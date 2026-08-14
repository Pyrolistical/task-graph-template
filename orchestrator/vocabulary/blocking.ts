import type { TaskId, TaskMeta } from "./task.ts";

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
