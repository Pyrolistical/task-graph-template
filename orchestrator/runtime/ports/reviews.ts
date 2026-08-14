import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { TaskId } from "../../vocabulary/task.ts";

export interface Reviews {
  findings(taskId: TaskId): Awaitable<string[]>;
  setFindings(taskId: TaskId, findings: string[]): Awaitable<void>;
  clearFindings(taskId: TaskId): Awaitable<void>;
  failures(taskId: TaskId): Awaitable<number>;
  setFailures(taskId: TaskId, failures: number): Awaitable<void>;
  clearFailures(taskId: TaskId): Awaitable<void>;
}
