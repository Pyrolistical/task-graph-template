import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ViewName } from "../app/ports.ts";
import type { TaskId } from "../domain/task.ts";
import {
  type ClaimState,
  type Role,
  ALL_ROLES,
} from "../domain/state-machine.ts";
import { isProcessAlive } from "./task-store.ts";

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

export function writeAtomic(filePath: string, contents: string): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents, "utf-8");
  fs.renameSync(temp, filePath);
}

export function snapshot(
  seq: number,
  key: string,
  rows: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ at: new Date().toISOString(), seq, ...extra, [key]: rows }, null, 2)}\n`;
}

function trimToLastBytes(filePath: string, cap: number): void {
  const size = fs.statSync(filePath).size;
  if (size <= cap) {
    return;
  }

  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(cap);
  fs.readSync(handle, buffer, 0, cap, size - cap);
  fs.closeSync(handle);

  const text = buffer.toString("utf-8");
  const firstBreak = text.indexOf("\n");
  writeAtomic(filePath, firstBreak === -1 ? "" : text.slice(firstBreak + 1));
}

export class Runtime {
  readonly repo: string;
  readonly root: string;

  constructor(repoPath: string, serverRoot = SERVER_ROOT) {
    this.repo = path.resolve(repoPath);
    this.root = path.join(serverRoot, repoKey(this.repo));
    fs.mkdirSync(this.root, { recursive: true });
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

  get agentsView(): string {
    return this.view("agents");
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
    return path.join(this.root, "lock");
  }

  takeLock(): void {
    if (this.claimLock()) {
      return;
    }
    const holder = this.lockHolder();
    if (holder !== null && isProcessAlive(holder)) {
      throw new Error(`${this.root} is already in use by server ${holder}`);
    }
    fs.rmSync(this.lockFile, { force: true });
    if (!this.claimLock()) {
      throw new Error(`${this.root} was just taken by another server`);
    }
  }

  clearLock(): void {
    if (this.lockHolder() === process.pid) {
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  lockHolder(): number | null {
    let held: string;
    try {
      held = fs.readFileSync(this.lockFile, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const holder = Number.parseInt(held, 10);
    return Number.isInteger(holder) ? holder : null;
  }

  private claimLock(): boolean {
    try {
      fs.writeFileSync(this.lockFile, `${process.pid}`, { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  taskDir(id: TaskId): string {
    return path.join(this.root, id);
  }

  assignment(id: TaskId): string {
    return path.join(this.taskDir(id), "ASSIGNMENT.md");
  }

  history(id: TaskId): string {
    return path.join(this.taskDir(id), "history");
  }

  findings(id: TaskId): string {
    return path.join(this.taskDir(id), "findings.json");
  }

  reviewFailures(id: TaskId): string {
    return path.join(this.taskDir(id), "review-failure-count");
  }

  worktree(id: TaskId): string {
    return path.join(this.taskDir(id), "worktree");
  }

  sessionDir(id: TaskId, role: Role): string {
    return path.join(this.taskDir(id), "session", role);
  }

  rpcLog(id: TaskId): string {
    return path.join(this.taskDir(id), "agent-rpc.jsonl");
  }

  checkLog(id: TaskId, index: number): string {
    return path.join(this.taskDir(id), `check-${index}.log`);
  }

  queueDir(id: TaskId): string {
    return path.join(this.taskDir(id), "queue");
  }

  queueFile(id: TaskId, state: ClaimState): string {
    return path.join(this.queueDir(id), `${state}.md`);
  }

  prepare(id: TaskId): void {
    fs.mkdirSync(this.history(id), { recursive: true });
    for (const role of ALL_ROLES) {
      fs.mkdirSync(this.sessionDir(id, role), { recursive: true });
    }
    fs.mkdirSync(this.queueDir(id), { recursive: true });
  }

  discard(id: TaskId): void {
    fs.rmSync(this.taskDir(id), { recursive: true, force: true });
  }

  log(line: string, cap = SERVER_LOG_CAP_BYTES): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.appendFileSync(
      this.serverLog,
      `${new Date().toISOString()} ${line}\n`,
      "utf-8",
    );
    trimToLastBytes(this.serverLog, cap);
  }
}
