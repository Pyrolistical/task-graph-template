import { z } from "zod";
import { parse } from "./schema.ts";
import type { TaskId } from "./task.ts";
import { ALL_ROLES, type Role } from "./state-machine.ts";
import type { Activity } from "./activity.ts";

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

export interface AgentSlot {
  name: string;
  agent: string;
  type: string;
  provider: string;
  model: string;
  slot: number;
  enabled: boolean;
  write: string[];
  roles: Role[];
}

export function agentKey(entry: AgentEntry): string {
  return `${entry.type}-${entry.provider}-${entry.model}`;
}

export function agentName(entry: AgentEntry, slot: number): string {
  return `${agentKey(entry)}-${slot}`;
}

export function agentModelKey(name: string): string {
  return name.slice(0, name.lastIndexOf("-"));
}

export function parseAgents(
  raw: unknown,
  source = "agents.json",
  defaultWrite: string[] = [],
): AgentSlot[] {
  const pool = parse(poolSchema(defaultWrite), raw, "agent pool", source);
  const slots: AgentSlot[] = [];

  for (const entry of pool.agents) {
    for (let slot = 1; slot <= entry.slots; slot++) {
      slots.push({
        name: agentName(entry, slot),
        agent: agentKey(entry),
        type: entry.type,
        provider: entry.provider,
        model: entry.model,
        slot,
        enabled: entry.enabled,
        write: entry.write,
        roles: entry.roles,
      });
    }
  }

  return slots;
}

export type AgentState =
  | "IDLE"
  | "DISABLED"
  | "SPAWNING"
  | "BUSY"
  | "WAITING"
  | "ABORTING"
  | "SETTLED";

export interface AgentRow {
  name: string;
  agent: string;
  type: string;
  provider: string;
  model: string;
  slot: number;
  enabled: boolean;
  state: AgentState;
  task_id: TaskId | null;
  role: Role | null;
  pid: number | null;
  started_at: string | null;
  activity: Activity;
  tokens: number | null;
  context_percent: number | null;
  compactions: number;
  session: string | null;
  log: string | null;
  retry: Retry | null;
}

export interface Retry {
  at: string;
  attempt: number;
}

export function idleRow(slot: AgentSlot, enabled = true): AgentRow {
  return {
    name: slot.name,
    agent: slot.agent,
    type: slot.type,
    provider: slot.provider,
    model: slot.model,
    slot: slot.slot,
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
    log: null,
    retry: null,
  };
}
