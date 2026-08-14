import fs from "node:fs/promises";
import { type Slot, parseAgents } from "../domain/slots.ts";
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

export async function loadAgents(filePath: string): Promise<Slot[]> {
  return parsePool(JSON.parse(await fs.readFile(filePath, "utf-8")), filePath);
}
