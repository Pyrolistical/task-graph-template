import type { SlotRow } from "../../views/slots.ts";
import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { TaskRow } from "../../views/tasks.ts";
import type { InboxRow } from "../../views/inbox.ts";
import type { Candidate } from "../../views/queue.ts";

export interface Views {
  seq: number;
  agentsFile: string;
  slots: SlotRow[];
  checks: RunningCheck[];
  tasks: TaskRow[];
  inbox: InboxRow[];
  queue: Candidate[];
  scheduling: boolean;
}

export const VIEW_NAMES = [
  "slots",
  "checks",
  "tasks",
  "inbox",
  "queue",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export interface Publisher {
  publish(views: Views): Awaitable<void>;
  read(name: ViewName): Awaitable<string>;
  lastSlots(): Awaitable<SlotRow[] | undefined>;
  log(line: string): Awaitable<void>;
}
