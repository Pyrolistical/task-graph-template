import { z } from "zod";
import { parse } from "../../kernel/domain/schema.ts";
import { ALL_ROLES, type Role } from "../../vocabulary/state-machine.ts";
import type { SlotRow, SlotState } from "../../views/slots.ts";
import { Schedule, withinSchedule } from "./schedule.ts";

function poolSchema(defaultWrite: string[]) {
  const Entry = z.strictObject({
    type: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    slots: z.int().min(1).default(1),
    maxSlots: z.int().min(1).optional(),
    enabled: z.boolean().default(true),
    schedule: Schedule.optional(),
    healthCheck: z.boolean().default(false),
    wattage: z.number().min(0).default(0),
    costPerKwh: z.number().min(0).default(0),
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
      if (entry.maxSlots && entry.maxSlots < entry.slots) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", i, "maxSlots"],
          message: `is ${entry.maxSlots}, below its ${entry.slots} slots`,
        });
      }
    });
  });
}

export interface AgentEntry {
  type: string;
  provider: string;
  model: string;
  slots: number;
  maxSlots?: number;
  enabled: boolean;
  schedule?: Schedule;
  healthCheck: boolean;
  wattage: number;
  costPerKwh: number;
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
  maxSlots?: number;
  enabled: boolean;
  schedule?: Schedule;
  healthCheck: boolean;
  wattage: number;
  costPerKwh: number;
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

export function slotAt(template: Slot, index: number): Slot {
  return { ...template, name: `${template.agent}-${index}`, index };
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
        maxSlots: entry.maxSlots,
        enabled: entry.enabled,
        schedule: entry.schedule,
        healthCheck: entry.healthCheck,
        wattage: entry.wattage,
        costPerKwh: entry.costPerKwh,
        write: entry.write,
        roles: entry.roles,
      });
    }
  }

  return slots;
}

function idleState(
  enabled: boolean,
  reachable: boolean,
  scheduled: boolean,
): SlotState {
  if (!enabled) {
    return "DISABLED";
  }
  if (!scheduled) {
    return "OFF_SCHEDULE";
  }
  return reachable ? "IDLE" : "UNREACHABLE";
}

export function idleRow(
  slot: Slot,
  total: number,
  enabled = true,
  reachable = true,
  scheduled = withinSchedule(slot.schedule),
): SlotRow {
  return {
    name: slot.name,
    agent: slot.agent,
    type: slot.type,
    provider: slot.provider,
    model: slot.model,
    index: slot.index,
    total,
    max: slot.maxSlots,
    enabled,
    state: idleState(enabled, reachable, scheduled),
    task_id: undefined,
    role: undefined,
    pid: undefined,
    started_at: undefined,
    activity: { kind: "none" },
    tokens: undefined,
    cost: undefined,
    context_percent: undefined,
    compactions: 0,
    session: undefined,
    retry: undefined,
  };
}
