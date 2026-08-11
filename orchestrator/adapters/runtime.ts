import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViewName } from "../app/ports/publisher.ts";
import type { TaskId } from "../domain/task.ts";
import {
  type ClaimState,
  type Role,
  ALL_ROLES,
} from "../domain/state-machine.ts";
import { Appendable } from "./appendable.ts";
import { PidLock } from "./pid-lock.ts";

export const SERVER_ROOT = "/tmp/task-graph-server";

export const SERVER_LOG_CAP_BYTES = 100 * 1024 * 1024;

export function repoKey(repoPath: string): string {
  return path.resolve(repoPath).replaceAll("/", "-");
}

export function graphKey(repoPath: string, home = os.homedir()): string {
  const resolved = path.resolve(repoPath);
  const relative = path.relative(home, resolved);
  if (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  ) {
    return relative.replaceAll("/", "-");
  }
  return resolved.replaceAll("/", "-");
}

export function taskGraphRoot(): string {
  return (
    process.env.TASK_GRAPH_TASKS_ROOT ?? path.join(os.homedir(), "task-graph")
  );
}

export function defaultTasksDir(repoPath: string): string {
  return path.join(taskGraphRoot(), graphKey(repoPath));
}

export function defaultAgentsPath(tasksDir: string): string {
  return path.join(tasksDir, "agents.json");
}

export function viewJson(
  seq: number,
  key: string,
  rows: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ at: new Date().toISOString(), seq, ...extra, [key]: rows }, undefined, 2)}\n`;
}

async function trimToLastBytes(
  handle: fs.FileHandle,
  cap: number,
): Promise<void> {
  const { size } = await handle.stat();
  if (size <= cap) {
    return;
  }

  const buffer = Buffer.alloc(cap);
  const { bytesRead } = await handle.read(buffer, 0, cap, size - cap);
  const text = buffer.subarray(0, bytesRead).toString("utf-8");
  const firstBreak = text.indexOf("\n");
  const kept = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  await handle.truncate(0);
  await handle.appendFile(kept, "utf-8");
}

export class Runtime {
  readonly repo: string;
  readonly root: string;

  private readonly logging: Appendable;
  private readonly locking: PidLock;

  constructor(repoPath: string, serverRoot = SERVER_ROOT) {
    this.repo = path.resolve(repoPath);
    this.root = path.join(serverRoot, repoKey(this.repo));
    this.logging = new Appendable(this.serverLog);
    this.locking = new PidLock(path.join(this.root, "lock"), this.root);
  }

  static async open(
    repoPath: string,
    serverRoot = SERVER_ROOT,
  ): Promise<Runtime> {
    const runtime = new Runtime(repoPath, serverRoot);
    await fs.mkdir(runtime.root, { recursive: true });
    return runtime;
  }

  get serverLog(): string {
    return path.join(this.root, "server.log");
  }

  get transitionLog(): string {
    return path.join(this.root, "transitions.jsonl");
  }

  view(name: ViewName): string {
    return path.join(this.root, `${name}.json`);
  }

  get slotsView(): string {
    return this.view("slots");
  }

  get checksView(): string {
    return this.view("checks");
  }

  get tasksView(): string {
    return this.view("tasks");
  }

  get inboxView(): string {
    return this.view("inbox");
  }

  get queueView(): string {
    return this.view("queue");
  }

  get consoleCommand(): string {
    return path.join(this.root, "console-command");
  }

  get lockFile(): string {
    return this.locking.filePath;
  }

  takeLock(): Promise<void> {
    return this.locking.take();
  }

  clearLock(): Promise<void> {
    return this.locking.clear();
  }

  lockHolder(): Promise<number | undefined> {
    return this.locking.holder();
  }

  taskRoot(id: TaskId): string {
    return path.join(this.root, id);
  }

  assignment(id: TaskId): string {
    return path.join(this.taskRoot(id), "ASSIGNMENT.md");
  }

  history(id: TaskId): string {
    return path.join(this.taskRoot(id), "history");
  }

  findings(id: TaskId): string {
    return path.join(this.taskRoot(id), "findings.json");
  }

  reviewFailures(id: TaskId): string {
    return path.join(this.taskRoot(id), "review-failure-count");
  }

  worktree(id: TaskId): string {
    return path.join(this.taskRoot(id), "worktree");
  }

  sessionDir(id: TaskId, role: Role): string {
    return path.join(this.taskRoot(id), "session", role);
  }

  checkLog(id: TaskId, index: number): string {
    return path.join(this.taskRoot(id), `check-${index}.log`);
  }

  messagesDir(id: TaskId): string {
    return path.join(this.taskRoot(id), "messages");
  }

  messageFile(id: TaskId, state: ClaimState): string {
    return path.join(this.messagesDir(id), `${state}.md`);
  }

  async prepare(id: TaskId): Promise<void> {
    await fs.mkdir(this.history(id), { recursive: true });
    for (const role of ALL_ROLES) {
      await fs.mkdir(this.sessionDir(id, role), { recursive: true });
    }
    await fs.mkdir(this.messagesDir(id), { recursive: true });
  }

  async discard(id: TaskId): Promise<void> {
    await fs.rm(this.taskRoot(id), { recursive: true, force: true });
  }

  log(line: string, cap = SERVER_LOG_CAP_BYTES): Promise<void> {
    return this.logging.use(async (handle) => {
      await handle.appendFile(`${new Date().toISOString()} ${line}\n`, "utf-8");
      await trimToLastBytes(handle, cap);
    });
  }

  close(): Promise<void> {
    return this.logging.close();
  }
}
