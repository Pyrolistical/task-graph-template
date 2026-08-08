import { memberOf } from "../domain/lookup.ts";
import { type TaskId, type TaskMeta } from "../domain/task.ts";

export const INBOX_RANKS = [
  "MANAGER_REVIEW",
  "HELD_DESIGN",
  "HELD_PLAN",
  "HELD_WORK",
  "NEW",
] as const;

export type InboxRank = (typeof INBOX_RANKS)[number];

export const isInboxRank = memberOf(INBOX_RANKS);

export interface InboxRow {
  task_id: TaskId;
  title: string;
  rank: InboxRank;
  blocking: number;
  held_reason: string | null;
  branch: string | null;
  waiting_since: string | null;
}

export function inbox(
  tasks: Map<TaskId, TaskMeta>,
  blocking: Map<TaskId, number>,
): InboxRow[] {
  const rows: InboxRow[] = [];

  for (const [id, task] of tasks) {
    if (!isInboxRank(task.state)) {
      continue;
    }
    rows.push({
      task_id: id,
      title: task.title,
      rank: task.state,
      blocking: blocking.get(id) ?? 0,
      held_reason: task.held_reason,
      branch: task.workspace?.branch ?? null,
      waiting_since: task.state_entered,
    });
  }

  return rows.sort(
    (a, b) =>
      INBOX_RANKS.indexOf(a.rank) - INBOX_RANKS.indexOf(b.rank) ||
      b.blocking - a.blocking ||
      a.task_id.localeCompare(b.task_id),
  );
}
