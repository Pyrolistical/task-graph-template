import type { TaskId } from "../../vocabulary/task.ts";

export const OUTPUT_TAIL_LINES = 40;

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
