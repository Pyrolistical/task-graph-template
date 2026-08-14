import { memberOf } from "../kernel/domain/lookup.ts";
import type { TaskId } from "../vocabulary/task.ts";

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
  held_reason?: string;
  branch?: string;
  waiting_since?: string;
}
