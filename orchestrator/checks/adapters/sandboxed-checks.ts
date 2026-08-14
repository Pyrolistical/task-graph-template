import type { Checks } from "../ports/checks.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { Slot } from "../../agents/domain/slots.ts";
import type { CheckResult } from "../domain/checks.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { TaskId } from "../../vocabulary/task.ts";
import { checkWrite } from "../../agents/adapters/agent-pool.ts";
import { CheckRunner } from "./check-runner.ts";
import {
  CHECK_OOM_SCORE_ADJUST,
  overlays,
  sandbox,
} from "../../agents/adapters/sandbox.ts";

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
