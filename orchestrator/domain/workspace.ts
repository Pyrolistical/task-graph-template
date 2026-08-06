import type { TaskId } from "./task.ts";

export function branchName(id: TaskId): string {
  return `task/${id}`;
}
