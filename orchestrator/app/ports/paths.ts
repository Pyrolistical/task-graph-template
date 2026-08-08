import type { Role } from "../../domain/state-machine.ts";
import type { TaskId } from "../../domain/task.ts";

export interface Paths {
  readonly root: string;
  readonly serverLog: string;
  readonly transitionLog: string;
  readonly slotsView: string;
  readonly checksView: string;
  readonly tasksView: string;
  readonly inboxView: string;
  readonly queueView: string;
  readonly consoleCommand: string;
  taskRoot(id: TaskId): string;
  worktree(id: TaskId): string;
  assignment(id: TaskId): string;
  history(id: TaskId): string;
  findings(id: TaskId): string;
  reviewFailures(id: TaskId): string;
  sessionDir(id: TaskId, role: Role): string;
  checkLog(id: TaskId, index: number): string;
  messagesDir(id: TaskId): string;
  prepare(id: TaskId): void;
  discard(id: TaskId): void;
  log(line: string): void;
  takeLock(): void;
  clearLock(): void;
}
