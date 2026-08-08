import fs from "node:fs";
import { type Slot, parseAgents } from "../domain/agents.ts";
import { DEFAULT_WRITE, PI_HOME, expandAll } from "./sandbox.ts";

export { DEFAULT_WRITE };

export function agentWrite(slot: Slot): string[] {
  return expandAll(
    slot.type === "pi" ? [...slot.write, PI_HOME] : [...slot.write],
  );
}

export function checkWrite(slots: Slot[]): string[] {
  return expandAll(slots.flatMap((slot) => slot.write));
}

export function parsePool(raw: unknown, source = "agents.json"): Slot[] {
  return parseAgents(raw, source, DEFAULT_WRITE);
}

export function loadAgents(filePath: string): Slot[] {
  return parsePool(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath);
}
