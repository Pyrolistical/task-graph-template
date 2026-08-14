import { type TaskId, type TaskMeta } from "../../vocabulary/task.ts";
import { type InboxRow, INBOX_RANKS, isInboxRank } from "../../views/inbox.ts";

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
      branch: task.workspace?.branch,
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
