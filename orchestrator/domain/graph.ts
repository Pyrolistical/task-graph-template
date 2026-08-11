import { z } from "zod";
import { maybe } from "./schema.ts";
import type { TaskId, TaskMeta } from "./task.ts";

export const RECENT_TASKS = 100;

export function blockingCounts(
  tasks: Map<TaskId, TaskMeta>,
): Map<TaskId, number> {
  const dependents = new Map<TaskId, TaskId[]>();
  for (const [id] of tasks) {
    dependents.set(id, []);
  }
  for (const [id, task] of tasks) {
    for (const dep of task.depends_on) {
      dependents.get(dep)?.push(id);
    }
  }

  const counts = new Map<TaskId, number>();
  for (const [id] of tasks) {
    const seen = new Set<TaskId>();
    const stack = [...(dependents.get(id) ?? [])];
    for (let next = stack.pop(); next; next = stack.pop()) {
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      stack.push(...(dependents.get(next) ?? []));
    }
    counts.set(id, seen.size);
  }
  return counts;
}

export const TaskRow = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  state_entered: maybe(z.string()),
  depends_on: z.array(z.string()),
  blocking: z.int(),
  claimed_by: maybe(z.string()),
  held_reason: maybe(z.string()),
  worktree: maybe(z.string()),
});

export type TaskRow = z.infer<typeof TaskRow>;

export const TasksView = z.looseObject({ tasks: z.array(TaskRow) });

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
