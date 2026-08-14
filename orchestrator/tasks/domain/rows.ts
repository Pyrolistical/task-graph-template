import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";
import type { TaskRow } from "../../views/tasks.ts";

export const RECENT_TASKS = 100;

export function taskRow(task: TaskMeta, blocking: number): TaskRow {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    state_entered: task.state_entered,
    depends_on: task.depends_on,
    blocking,
    claimed_by: task.claimed_by,
    held_reason: task.held_reason,
    worktree: task.workspace?.worktree,
  };
}

export function taskRows(
  tasks: Map<TaskId, TaskMeta>,
  blocking: Map<TaskId, number>,
  recent: TaskId[],
  closed: Map<TaskId, TaskRow>,
): TaskRow[] {
  const rows: TaskRow[] = [];

  for (const id of recent.slice(0, RECENT_TASKS)) {
    const task = tasks.get(id);
    if (!task) {
      const archived = closed.get(id);
      if (archived) {
        rows.push(archived);
      }
      continue;
    }
    rows.push(taskRow(task, blocking.get(id) ?? 0));
  }

  return rows;
}
