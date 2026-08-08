import type { CheckResult, RunningCheck } from "../../domain/checks.ts";
import type { TaskId } from "../../domain/task.ts";

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
