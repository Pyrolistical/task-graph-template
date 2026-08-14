import type { CheckResult } from "../domain/checks.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { TaskId } from "../../vocabulary/task.ts";

export interface Checks {
  readonly view: RunningCheck[];
  isRunning(taskId: TaskId): boolean;
  run(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult>;
}
