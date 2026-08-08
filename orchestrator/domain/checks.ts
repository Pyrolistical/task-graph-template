import { z } from "zod";
import type { TaskId } from "./task.ts";

export const OUTPUT_TAIL_LINES = 40;

export const RunningCheck = z.strictObject({
  task_id: z.string(),
  index: z.int(),
  command: z.string(),
  pid: z.int(),
  started_at: z.string(),
  log: z.string(),
});

export type RunningCheck = z.infer<typeof RunningCheck>;

export const ChecksView = z.looseObject({ checks: z.array(RunningCheck) });

export interface CheckResult {
  task_id: TaskId;
  index: number;
  command: string;
  code: number;
  log: string;
  tail: string;
}

export function tailOf(output: string, lines = OUTPUT_TAIL_LINES): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}
