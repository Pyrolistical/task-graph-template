import { RECENT_TASKS } from "../domain/rows.ts";
import type { TaskId } from "../../vocabulary/task.ts";

export interface Remembered {
  recent: TaskId[];
  discards: TaskId[];
}

export function keepRecent(
  taskId: TaskId,
  recent: readonly TaskId[],
  live: ReadonlySet<TaskId>,
): Remembered {
  const touched = [taskId, ...recent.filter((id) => id !== taskId)];
  return {
    recent: touched.slice(0, RECENT_TASKS),
    discards: touched.slice(RECENT_TASKS).filter((id) => !live.has(id)),
  };
}
