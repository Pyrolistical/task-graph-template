import fs from "node:fs";
import path from "node:path";
import {
  type TaskId,
  type TaskMeta,
  parseDocument,
  parseTaskMeta,
  splitDocument,
} from "./task.ts";

export const RECENT_TASKS = 100;

export interface Scan {
  tasks: Map<TaskId, TaskMeta>;
  problems: Map<string, string>;
}

export function readActiveTasks(tasksDir: string): Scan {
  const tasks = new Map<TaskId, TaskMeta>();
  const problems = new Map<string, string>();

  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{6}\.md$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(tasksDir, entry.name);
    try {
      const { raw } = parseDocument(fs.readFileSync(filePath, "utf-8"));
      const meta = parseTaskMeta(raw, filePath);
      tasks.set(meta.id, meta);
    } catch (err) {
      problems.set(filePath, (err as Error).message);
    }
  }

  return { tasks, problems };
}

export function readTaskBody(tasksDir: string, id: TaskId): string {
  const filePath = path.join(tasksDir, `${id}.md`);
  return splitDocument(fs.readFileSync(filePath, "utf-8")).body.trim();
}

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
    while (stack.length > 0) {
      const next = stack.pop()!;
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

export interface TaskRow {
  id: TaskId;
  title: string;
  state: string;
  state_entered: string | null;
  depends_on: TaskId[];
  blocking: number;
  claimed_by: string | null;
  held_reason: string | null;
  worktree: string | null;
}

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
    worktree: task.workspace?.worktree ?? null,
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
    if (task === undefined) {
      const archived = closed.get(id);
      if (archived !== undefined) {
        rows.push(archived);
      }
      continue;
    }
    rows.push(taskRow(task, blocking.get(id) ?? 0));
  }

  return rows;
}
