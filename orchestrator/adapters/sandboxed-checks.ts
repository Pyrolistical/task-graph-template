import type { Checks } from "../app/ports/checks.ts";
import type { Paths } from "../app/ports/paths.ts";
import type { Slot } from "../domain/agents.ts";
import type { CheckResult, RunningCheck } from "../domain/checks.ts";
import type { TaskId } from "../domain/task.ts";
import { checkWrite } from "./agent-pool.ts";
import { CheckRunner } from "./check-runner.ts";
import { CHECK_OOM_SCORE_ADJUST, overlays, sandbox } from "./sandbox.ts";

export class SandboxedChecks implements Checks {
  private readonly runner = new CheckRunner();

  constructor(
    private readonly paths: Paths,
    private readonly slots: Slot[],
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
          overlay: await overlays(checkWrite(this.slots)),
          oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
        },
        this.sandboxCommand,
      ),
    );
  }
}
