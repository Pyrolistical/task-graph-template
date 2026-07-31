import fs from "node:fs";
import { z } from "zod";
import { parse } from "./schema.ts";
import { DEFAULT_WRITE, PI_HOME, overlays } from "./sandbox.ts";
import type { TaskId } from "./task.ts";
import type { Role } from "./runtime.ts";

const Entry = z.strictObject({
  type: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  slots: z.int().min(1).default(1),
  enabled: z.boolean().default(true),
  write: z.array(z.string().min(1)).default(() => [...DEFAULT_WRITE]),
});

const Pool = z
  .strictObject({ agents: z.array(Entry).min(1) })
  .superRefine((pool, ctx) => {
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

export type AgentEntry = z.infer<typeof Entry>;

export interface AgentSlot {
  name: string;
  agent: string;
  type: string;
  provider: string;
  model: string;
  slot: number;
  enabled: boolean;
  write: string[];
}

export function agentWrite(slot: AgentSlot): string[] {
  return overlays(
    slot.type === "pi" ? [...slot.write, PI_HOME] : [...slot.write],
  );
}

export function checkWrite(slots: AgentSlot[]): string[] {
  return overlays(slots.flatMap((slot) => slot.write));
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

export function parseAgents(raw: unknown, source = "agents.json"): AgentSlot[] {
  const pool = parse(Pool, raw, "agent pool", source);
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
      });
    }
  }

  return slots;
}

export function loadAgents(filePath: string): AgentSlot[] {
  return parseAgents(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath);
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
  activity: string | null;
  tokens: number | null;
  context_percent: number | null;
  session: string | null;
  log: string | null;
  retry_at?: string;
  attempt?: number;
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
    activity: null,
    tokens: null,
    context_percent: null,
    session: null,
    log: null,
  };
}
