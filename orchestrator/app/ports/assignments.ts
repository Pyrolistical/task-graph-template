import type { TaskId } from "../../domain/task.ts";

export interface Assignments {
  read(taskId: TaskId): string;
  write(taskId: TaskId, contents: string): void;
  exists(taskId: TaskId): boolean;
  rotate(taskId: TaskId): void;
}
