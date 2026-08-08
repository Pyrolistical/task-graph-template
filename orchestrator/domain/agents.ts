import { z } from "zod";
import { parse } from "./schema.ts";
import { ALL_ROLES, type Role } from "./state-machine.ts";
import { Activity } from "./activity.ts";

function poolSchema(defaultWrite: string[]) {
  const Entry = z.strictObject({
    type: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    slots: z.int().min(1).default(1),
    enabled: z.boolean().default(true),
    write: z.array(z.string().min(1)).default(() => [...defaultWrite]),
    roles: z.array(z.enum(ALL_ROLES)).default(() => [...ALL_ROLES]),
  });

  return z.strictObject({ agents: z.array(Entry) }).superRefine((pool, ctx) => {
    const seen = new Set<string>();
    pool.agents.forEach((entry, i) => {
      const triple = `${entry.type}/${entry.provider}/${entry.model}`;
      if (seen.has(triple)) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", i],
          message: `repeats type+provider+model "${triple}"`,
        });
      }
      seen.add(triple);
    });
  });
}

export interface AgentEntry {
  type: string;
  provider: string;
  model: string;
  slots: number;
  enabled: boolean;
  write: string[];
  roles: Role[];
}

export interface Slot {
  name: string;
  agent: string;
  type: string;
  provider: string;
  model: string;
  index: number;
  enabled: boolean;
  write: string[];
  roles: Role[];
}

export function agentName(entry: AgentEntry): string {
  return `${entry.type}-${entry.provider}-${entry.model}`;
}

export function slotName(entry: AgentEntry, index: number): string {
  return `${agentName(entry)}-${index}`;
}

export function agentOf(name: string): string {
  return name.slice(0, name.lastIndexOf("-"));
}

export function parseAgents(
  raw: unknown,
  source = "agents.json",
  defaultWrite: string[] = [],
): Slot[] {
  const pool = parse(poolSchema(defaultWrite), raw, "agent pool", source);
  const slots: Slot[] = [];

  for (const entry of pool.agents) {
    for (let index = 1; index <= entry.slots; index++) {
      slots.push({
        name: slotName(entry, index),
        agent: agentName(entry),
        type: entry.type,
        provider: entry.provider,
        model: entry.model,
        index,
        enabled: entry.enabled,
        write: entry.write,
        roles: entry.roles,
      });
    }
  }

  return slots;
}

export const SlotState = z.enum([
  "IDLE",
  "DISABLED",
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
  enabled: z.boolean(),
  state: SlotState,
  task_id: z.string().nullable(),
  role: z.enum(ALL_ROLES).nullable(),
  pid: z.int().nullable(),
  started_at: z.string().nullable(),
  activity: Activity,
  tokens: z.number().nullable(),
  context_percent: z.number().nullable(),
  compactions: z.int(),
  session: z.string().nullable(),
  retry: Retry.nullable(),
});

export type SlotRow = z.infer<typeof SlotRow>;

export const SlotsView = z.looseObject({
  agents_file: z.string(),
  slots: z.array(SlotRow),
});

export function idleRow(slot: Slot, enabled = true): SlotRow {
  return {
    name: slot.name,
    agent: slot.agent,
    type: slot.type,
    provider: slot.provider,
    model: slot.model,
    index: slot.index,
    enabled,
    state: enabled ? "IDLE" : "DISABLED",
    task_id: null,
    role: null,
    pid: null,
    started_at: null,
    activity: { kind: "none" },
    tokens: null,
    context_percent: null,
    compactions: 0,
    session: null,
    retry: null,
  };
}
