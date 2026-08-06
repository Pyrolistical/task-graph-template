import type { Checks, Inbox, Prompts } from "./ports.ts";
import { TaskGraph } from "./task-graph.ts";
import type { CheckResult, RunningCheck } from "../domain/checks.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

export class RunChecks {
  private readonly pending = new Map<TaskId, Promise<void>>();

  constructor(
    private readonly graph: TaskGraph,
    private readonly checks: Checks,
    private readonly inbox: Inbox,
    private readonly prompts: Prompts,
    private readonly repo: string,
  ) {}

  start(tasks: Map<TaskId, TaskMeta>): void {
    for (const [id, task] of tasks) {
      if (task.state !== "CHECK" || this.pending.has(id)) {
        continue;
      }
      this.pending.set(
        id,
        this.runAll(id).finally(() => {
          this.pending.delete(id);
        }),
      );
    }
  }

  get view(): RunningCheck[] {
    return this.checks.view;
  }

  get running(): number {
    return this.pending.size;
  }

  isRunning(taskId: TaskId): boolean {
    return this.checks.isRunning(taskId);
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
    const task = this.graph.read(taskId)!;
    const worktree = task.workspace?.worktree ?? this.repo;
    const failures: { command: string; exit_code: string; output: string }[] =
      [];

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
      this.graph.transition(taskId, "pass", {}, "server");
      return;
    }
    this.inbox.queue(
      taskId,
      "WORK",
      this.prompts.fragment("check-failed", { failures }),
    );
    this.graph.transition(taskId, "fail", {}, "server");
  }
}
