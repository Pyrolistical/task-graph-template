import type { Workspaces } from "./ports/workspaces.ts";
import { Pool } from "./pool.ts";
import { Checker } from "./checker.ts";
import { TaskGraph } from "./task-graph.ts";
import { HELD_STATES, type TaskState } from "../domain/state-machine.ts";
import type { TransitionResult } from "../domain/state-machine.ts";
import {
  type TaskId,
  type TaskMeta,
  requireWorkspace,
} from "../domain/task.ts";

const ABORTABLE_STATES: TaskState[] = ["MANAGER_REVIEW", ...HELD_STATES];

export class Lander {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly checker: Checker,
    private readonly workspaces: Workspaces,
    private readonly base: string,
  ) {}

  async merge(taskId: TaskId): Promise<TransitionResult> {
    const task = this.requireManagerReview(taskId);
    const { branch, worktree } = requireWorkspace(task);

    if (this.workspaces.exists(worktree)) {
      this.workspaces.syncBase(worktree, this.base);
      const rebased = this.workspaces.rebase(worktree, this.base);
      if (rebased.code !== 0) {
        this.workspaces.abortRebase(worktree);
        throw new Error(
          `the branch no longer rebases onto ${this.base}: ${rebased.stderr.trim()}`,
        );
      }

      for (const [index, command] of task.checks.entries()) {
        const result = await this.checker.run(taskId, index, command, worktree);
        if (result.code !== 0) {
          throw new Error(
            `\`${result.command}\` failed after the rebase (exit ${result.code}):\n${result.tail}`,
          );
        }
      }

      this.pool.harvest(this.graph.read(taskId)?.workspace ?? null);
    }

    if (this.workspaces.branchExists(branch)) {
      const merged = this.workspaces.fastForward(branch);
      if (merged.code !== 0) {
        throw new Error(
          `the fast-forward merge of ${branch} was refused: ${merged.stderr.trim()}`,
        );
      }
      if (!this.workspaces.isAncestor(branch, this.base)) {
        throw new Error(
          `${branch} is not an ancestor of ${this.base} after the merge`,
        );
      }
    }

    const result = this.graph.transition(taskId, "submit", {}, "manager");
    this.graph.teardown(task);
    return result;
  }

  abort(taskId: TaskId): TransitionResult {
    const task = this.requireAbortable(taskId);
    const branch = task.workspace?.branch ?? null;

    if (
      branch !== null &&
      this.workspaces.branchExists(branch) &&
      this.workspaces.isAncestor(branch, this.base)
    ) {
      throw new Error(
        `${branch} is already part of ${this.base}; an aborted task is one whose work is being thrown away`,
      );
    }

    return this.graph.transition(taskId, "abort", {}, "manager");
  }

  private requireManagerReview(taskId: TaskId): TaskMeta {
    const task = this.graph.list().get(taskId);
    if (task === undefined || task.state !== "MANAGER_REVIEW") {
      throw new Error(`task "${taskId}" is not in MANAGER_REVIEW`);
    }
    return task;
  }

  private requireAbortable(taskId: TaskId): TaskMeta {
    const task = this.graph.list().get(taskId);
    if (task === undefined || !ABORTABLE_STATES.includes(task.state)) {
      throw new Error(
        `task "${taskId}" is not in ${ABORTABLE_STATES.join(" or ")}`,
      );
    }
    return task;
  }
}
