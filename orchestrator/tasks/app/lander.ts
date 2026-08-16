import type { Workspaces } from "../../workspaces/ports/workspaces.ts";
import type { Pool } from "../../agents/app/pool.ts";
import { Checker } from "./checker.ts";
import { TaskGraph } from "./task-graph.ts";
import { HELD_STATES, type TaskState } from "../../vocabulary/state-machine.ts";
import type { TransitionResult } from "../../vocabulary/state-machine.ts";
import {
  type TaskId,
  type TaskMeta,
  requireWorkspace,
} from "../../vocabulary/task.ts";

const ABORTABLE_STATES: TaskState[] = ["MANAGER_REVIEW", ...HELD_STATES];

export interface LanderOptions {
  graph: TaskGraph;
  pool: Pool;
  checker: Checker;
  workspaces: Workspaces;
  base: string;
}

export class Lander {
  private readonly graph: TaskGraph;
  private readonly pool: Pool;
  private readonly checker: Checker;
  private readonly workspaces: Workspaces;
  private readonly base: string;

  constructor(options: LanderOptions) {
    this.graph = options.graph;
    this.pool = options.pool;
    this.checker = options.checker;
    this.workspaces = options.workspaces;
    this.base = options.base;
  }

  async merge(taskId: TaskId): Promise<TransitionResult> {
    const task = await this.requireManagerReview(taskId);
    const { branch, worktree } = requireWorkspace(task);

    if (await this.workspaces.exists(worktree)) {
      await this.workspaces.syncBase(worktree, this.base);
      const rebased = await this.workspaces.rebase(worktree, this.base);
      if (rebased.code !== 0) {
        await this.workspaces.abortRebase(worktree);
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

      await this.pool.harvest((await this.graph.read(taskId))?.workspace);
    }

    if (await this.workspaces.branchExists(branch)) {
      const merged = await this.workspaces.fastForward(branch);
      if (merged.code !== 0) {
        throw new Error(
          `the fast-forward merge of ${branch} was refused: ${merged.stderr.trim()}`,
        );
      }
      if (!(await this.workspaces.isAncestor(branch, this.base))) {
        throw new Error(
          `${branch} is not an ancestor of ${this.base} after the merge`,
        );
      }
    }

    const result = await this.graph.transition(taskId, "submit", {}, "manager");
    await this.graph.teardown(task);
    return result;
  }

  async abort(taskId: TaskId): Promise<TransitionResult> {
    const task = await this.requireAbortable(taskId);
    const branch = task.workspace?.branch;

    if (
      branch &&
      (await this.workspaces.branchExists(branch)) &&
      (await this.workspaces.isAncestor(branch, this.base))
    ) {
      throw new Error(
        `${branch} is already part of ${this.base}; an aborted task is one whose work is being thrown away`,
      );
    }

    return this.graph.transition(taskId, "abort", {}, "manager");
  }

  private async requireManagerReview(taskId: TaskId): Promise<TaskMeta> {
    const task = await this.graph.read(taskId);
    if (!task || task.state !== "MANAGER_REVIEW") {
      throw new Error(`task "${taskId}" is not in MANAGER_REVIEW`);
    }
    return task;
  }

  private async requireAbortable(taskId: TaskId): Promise<TaskMeta> {
    const task = await this.graph.read(taskId);
    if (!task || !ABORTABLE_STATES.includes(task.state)) {
      throw new Error(
        `task "${taskId}" is not in ${ABORTABLE_STATES.join(" or ")}`,
      );
    }
    return task;
  }
}
