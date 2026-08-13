import { z } from "zod";
import { type ClaimState, CLAIM_STATES } from "./state-machine.ts";

export const Cost = z.strictObject({
  state: z.enum(CLAIM_STATES),
  slot: z.string().min(1),
  seconds: z.number(),
  cost: z.number(),
});

export type Cost = z.infer<typeof Cost>;

export interface Carried {
  seconds: number;
  cost: number;
}

export interface Meter {
  wattage: number;
  costPerKwh: number;
}

const MS_PER_HOUR = 3600000;

const MS_PER_SECOND = 1000;

const PLACES = 1e6;

export function costOf(
  meter: Meter,
  elapsedMs: number,
  reported?: number,
  carried = 0,
): number {
  if (reported) {
    return reported;
  }
  const kwh = ((meter.wattage / 1000) * elapsedMs) / MS_PER_HOUR;
  return Math.round((carried + kwh * meter.costPerKwh) * PLACES) / PLACES;
}

export function secondsOf(elapsedMs: number, carried = 0): number {
  return carried + Math.round(elapsedMs / MS_PER_SECOND);
}

export function carriedOn(costs: Cost[], state: ClaimState): Carried {
  const entry = costs.findLast((one) => one.state === state);
  return { seconds: entry?.seconds ?? 0, cost: entry?.cost ?? 0 };
}

export function recorded(costs: Cost[], entry: Cost, resumed: boolean): Cost[] {
  if (!resumed) {
    return [...costs, entry];
  }
  const at = costs.findLastIndex((one) => one.state === entry.state);
  return at === -1 ? [...costs, entry] : costs.with(at, entry);
}
