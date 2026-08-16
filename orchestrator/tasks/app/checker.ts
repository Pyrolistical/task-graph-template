import type { Checks } from "../../checks/ports/checks.ts";
import type { Messages } from "../../runtime/ports/messages.ts";
import type { Log } from "../../runtime/ports/log.ts";
import type { Prompts } from "../../prompting/ports/prompts.ts";
import { TaskGraph } from "./task-graph.ts";
import type { CheckResult } from "../../checks/domain/checks.ts";
import type { RunningCheck } from "../../views/checks.ts";
import { messageOf, uncaught } from "../../kernel/domain/errors.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";

type CheckFailure = {
  command: string;
  exit_code: string;
  output: string;
};

export class Checker {
  private readonly pending = new Map<TaskId, Promise<void>>();

  constructor(
    private readonly graph: TaskGraph,
    private readonly checks: Checks,
    private readonly messages: Messages,
    private readonly prompts: Prompts,
    private readonly log: Log,
    private readonly repo: string,
  ) {}

  start(tasks: Map<TaskId, TaskMeta>): void {
    for (const [id, task] of tasks) {
      if (task.state !== "CHECK" || this.pending.has(id)) {
        continue;
      }
      this.pending.set(
        id,
        this.runAll(id)
          .catch((err: unknown) =>
            this.log(`the checks for ${id} could not run: ${messageOf(err)}`),
          )
          .finally(() => {
            this.pending.delete(id);
          })
          .catch(uncaught),
      );
    }
  }

  get view(): RunningCheck[] {
    return this.checks.view;
  }

  get inflight(): number {
    return this.pending.size;
  }

  isRunning(taskId: TaskId): boolean {
    return this.pending.has(taskId) || this.checks.isRunning(taskId);
  }

  settled(): Promise<unknown> {
    return Promise.all([...this.pending.values()]);
  }

  run(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult> {
    return this.checks.run(taskId, index, command, worktree);
  }

  private async runAll(taskId: TaskId): Promise<void> {
    const task = await this.graph.read(taskId);
    if (!task) {
      throw new Error(`task "${taskId}" vanished before its checks could run`);
    }
    const worktree = task.workspace?.worktree ?? this.repo;
    const failures: CheckFailure[] = [];

    for (const [index, command] of task.checks.entries()) {
      const result = await this.run(taskId, index, command, worktree);
      if (result.code !== 0) {
        failures.push({
          command: result.command,
          exit_code: String(result.code),
          output: result.tail,
        });
      }
    }

    if (failures.length === 0) {
      await this.graph.transition(taskId, "pass", {}, "server");
      return;
    }
    await this.sendBack(taskId, failures);
  }

  private async sendBack(
    taskId: TaskId,
    failures: CheckFailure[],
  ): Promise<void> {
    await this.messages.queue(
      taskId,
      "WORK",
      this.prompts.fragment("check-failed", { failures }),
    );
    await this.graph.transition(taskId, "fail", {}, "server");
  }
}
