import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CACHE_HOME, expandAll } from "../../kernel/adapters/sandbox.ts";
import { type Slot, parseAgents } from "../domain/slots.ts";

export const AGENT_OOM_SCORE_ADJUST = 300;

export const PI_HOME = path.join(os.homedir(), ".pi");

export const ZIG_WRITE = CACHE_HOME;

export const DEFAULT_WRITE: string[] = [ZIG_WRITE];

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
