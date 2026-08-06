import fs from "node:fs";
import { type AgentSlot, parseAgents } from "../domain/agents.ts";
import { DEFAULT_WRITE, PI_HOME, overlays } from "./sandbox.ts";

export { DEFAULT_WRITE };

export function agentWrite(slot: AgentSlot): string[] {
  return overlays(
    slot.type === "pi" ? [...slot.write, PI_HOME] : [...slot.write],
  );
}

export function checkWrite(slots: AgentSlot[]): string[] {
  return overlays(slots.flatMap((slot) => slot.write));
}

export function parsePool(raw: unknown, source = "agents.json"): AgentSlot[] {
  return parseAgents(raw, source, DEFAULT_WRITE);
}

export function loadAgents(filePath: string): AgentSlot[] {
  return parsePool(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath);
}
