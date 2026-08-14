import { z } from "zod";
import { maybe } from "../kernel/domain/schema.ts";
import { ALL_ROLES } from "../vocabulary/state-machine.ts";
import { Activity } from "./activity.ts";

export const SlotState = z.enum([
  "IDLE",
  "DISABLED",
  "OFF_SCHEDULE",
  "UNREACHABLE",
  "SPAWNING",
  "BUSY",
  "WAITING",
  "ABORTING",
  "SETTLED",
]);

export type SlotState = z.infer<typeof SlotState>;

export const Retry = z.strictObject({
  at: z.string(),
  attempt: z.int(),
});

export type Retry = z.infer<typeof Retry>;

export const SlotRow = z.strictObject({
  name: z.string(),
  agent: z.string(),
  type: z.string(),
  provider: z.string(),
  model: z.string(),
  index: z.int(),
  total: z.int(),
  enabled: z.boolean(),
  state: SlotState,
  task_id: maybe(z.string()),
  role: maybe(z.enum(ALL_ROLES)),
  pid: maybe(z.int()),
  started_at: maybe(z.string()),
  activity: Activity,
  tokens: maybe(z.number()),
  cost: maybe(z.number()),
  context_percent: maybe(z.number()),
  compactions: z.int(),
  session: maybe(z.string()),
  retry: maybe(Retry),
});

export type SlotRow = z.infer<typeof SlotRow>;

export const HOLDING_STATES: SlotState[] = [
  "SPAWNING",
  "BUSY",
  "WAITING",
  "ABORTING",
  "SETTLED",
];

export function holding(row: SlotRow): boolean {
  return HOLDING_STATES.includes(row.state);
}

export const SlotsView = z.looseObject({
  agents_file: z.string(),
  slots: z.array(SlotRow),
});

export const DetachedSlot = z.object({
  name: z.string(),
  task_id: maybe(z.string()),
  role: maybe(z.enum(ALL_ROLES)),
  pid: maybe(z.int()),
  started_at: maybe(z.string()),
  session: maybe(z.string()),
});

export type DetachedSlot = z.infer<typeof DetachedSlot>;

export const SlotsViewOfAnyServer = z.looseObject({
  agents_file: z.string(),
  slots: z.array(DetachedSlot),
});
