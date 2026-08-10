import type { Awaitable } from "../../domain/awaitable.ts";
import type { TaskId } from "../../domain/task.ts";

export interface Assignments {
  read(taskId: TaskId): Awaitable<string>;
  write(taskId: TaskId, contents: string): Awaitable<void>;
  exists(taskId: TaskId): Awaitable<boolean>;
  rotate(taskId: TaskId): Awaitable<void>;
}
