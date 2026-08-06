import type { TaskId } from "./task.ts";

export const OUTPUT_TAIL_LINES = 40;

export interface RunningCheck {
  task_id: TaskId;
  index: number;
  command: string;
  pid: number;
  started_at: string;
  log: string;
}

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
