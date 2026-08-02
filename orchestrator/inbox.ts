import { type TaskId, type TaskMeta, openCount } from "./task.ts";
import { blockingCounts } from "./graph.ts";

export const INBOX_RANKS = [
  "READY_MANAGER_REVIEW",
  "READY_TASK_GRAPH_UPDATE",
  "HELD_PLAN",
  "HELD_WORK",
  "NEW",
] as const;

export type InboxRank = (typeof INBOX_RANKS)[number];

export interface InboxRow {
  task_id: TaskId;
  title: string;
  rank: InboxRank;
  blocking: number;
  open_todos: number;
  held_reason: string | null;
  branch: string | null;
  waiting_since: string | null;
}

export function inbox(tasks: Map<TaskId, TaskMeta>): InboxRow[] {
  const blocking = blockingCounts(tasks);
  const rows: InboxRow[] = [];

  for (const [id, task] of tasks) {
    if (!(INBOX_RANKS as readonly string[]).includes(task.state)) {
      continue;
    }
    rows.push({
      task_id: id,
      title: task.title,
      rank: task.state as InboxRank,
      blocking: blocking.get(id) ?? 0,
      open_todos: openCount(task.todos),
      held_reason: task.held_reason,
      branch: task.workspace?.branch ?? null,
      waiting_since: task.state_entered,
    });
  }

  return rows.sort(
    (a, b) =>
      INBOX_RANKS.indexOf(a.rank) - INBOX_RANKS.indexOf(b.rank) ||
      b.blocking - a.blocking ||
      a.open_todos - b.open_todos ||
      a.task_id.localeCompare(b.task_id),
  );
}
