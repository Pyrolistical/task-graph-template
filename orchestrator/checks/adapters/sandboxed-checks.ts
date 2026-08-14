import { overlays, sandbox } from "../../kernel/adapters/sandbox.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { TaskId } from "../../vocabulary/task.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { CheckResult } from "../domain/checks.ts";
import type { Checks } from "../ports/checks.ts";
import { CheckRunner } from "./check-runner.ts";

export const CHECK_OOM_SCORE_ADJUST = 400;

export class SandboxedChecks implements Checks {
  private readonly runner = new CheckRunner();

  constructor(
    private readonly paths: Paths,
    private readonly write: string[],
    private readonly repo: string,
    private readonly sandboxCommand: string,
  ) {}

  get view(): RunningCheck[] {
    return this.runner.view;
  }

  isRunning(taskId: TaskId): boolean {
    return this.runner.isRunning(taskId);
  }

  async run(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult> {
    return this.runner.start(
      taskId,
      index,
      command,
      worktree,
      this.paths.checkLog(taskId, index),
      await sandbox(
        {
          cwd: worktree,
          writable: [worktree],
          readable: [this.repo],
          overlay: await overlays(this.write),
          oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
        },
        this.sandboxCommand,
      ),
    );
  }
}
