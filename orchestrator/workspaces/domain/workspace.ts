import type { TaskId } from "../../vocabulary/task.ts";

export function branchName(id: TaskId): string {
  return `task/${id}`;
}
