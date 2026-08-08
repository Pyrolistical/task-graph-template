import type { SlotRow } from "../../domain/agents.ts";
import type { RunningCheck } from "../../domain/checks.ts";
import type { TaskRow } from "../../domain/graph.ts";
import type { InboxRow } from "../../policy/inbox.ts";
import type { Candidate } from "../../policy/scheduler.ts";

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
  publish(views: Views): void;
  read(name: ViewName): string;
  lastSlots(): SlotRow[] | null;
  log(line: string): void;
}
