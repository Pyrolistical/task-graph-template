import fs from "node:fs";
import path from "node:path";
import type { TaskId } from "./task.ts";

export const SERVER_ROOT = "/tmp/task-graph-server";

export const SERVER_LOG_CAP_BYTES = 100 * 1024 * 1024;

export type Role = "work" | "review";

export function repoKey(repoPath: string): string {
  return path.resolve(repoPath).replaceAll("/", "-");
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

  get agentsView(): string {
    return path.join(this.root, "agents.json");
  }

  get checksView(): string {
    return path.join(this.root, "checks.json");
  }

  get tasksView(): string {
    return path.join(this.root, "tasks.json");
  }

  get inboxView(): string {
    return path.join(this.root, "inbox.json");
  }

  get queueView(): string {
    return path.join(this.root, "queue.json");
  }

  get consoleCommand(): string {
    return path.join(this.root, "console-command");
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

  prepare(id: TaskId): void {
    fs.mkdirSync(this.history(id), { recursive: true });
    fs.mkdirSync(this.sessionDir(id, "work"), { recursive: true });
    fs.mkdirSync(this.sessionDir(id, "review"), { recursive: true });
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

export function branchName(id: TaskId): string {
  return `work/${id}`;
}
