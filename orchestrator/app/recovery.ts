import type { Paths } from "./ports/paths.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import { Pool } from "./pool.ts";
import { TaskGraph } from "./task-graph.ts";
import type { Awaitable } from "../domain/awaitable.ts";
import { isClaimState } from "../domain/state-machine.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

export class Recovery {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly workspaces: Workspaces,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => Awaitable<boolean>,
    private readonly base: string,
  ) {}

  async reclone(): Promise<void> {
    for (const [id, task] of await this.graph.list()) {
      const workspace = task.workspace;
      if (!workspace || (await this.workspaces.exists(workspace.worktree))) {
        continue;
      }
      if (!(await this.workspaces.branchExists(workspace.branch))) {
        await this.publisher.log(
          `task ${id} lost both its worktree and branch ${workspace.branch}`,
        );
        continue;
      }
      await this.paths.prepare(id);
      await this.workspaces.create(
        workspace.branch,
        workspace.worktree,
        this.base,
      );
      await this.publisher.log(
        `recloned the workspace for ${id} from ${workspace.branch}`,
      );
    }
  }

  async reattach(): Promise<void> {
    const rows = await this.publisher.lastSlots();
    if (!rows) {
      return;
    }

    const tasks = await this.graph.list();
    for (const row of rows) {
      const runner = this.pool
        .runners()
        .find((one) => one.slot.name === row.name);
      if (!runner || !row.pid || !row.task_id || !(await this.alive(row.pid))) {
        continue;
      }

      const state = tasks.get(row.task_id)?.state;
      runner.state = "BUSY";
      runner.taskId = row.task_id;
      runner.taskState = state && isClaimState(state) ? state : undefined;
      runner.role = row.role;
      runner.startedAt = row.started_at;
      runner.detachedPid = row.pid;
      runner.session = row.session;

      await this.publisher.log(
        `${row.name} is still running ${row.task_id} as pid ${row.pid}; leaving it alone`,
      );
    }
  }

  async reap(tasks: Map<TaskId, TaskMeta>): Promise<void> {
    const held = this.pool.busyTasks();

    for (const [id, task] of tasks) {
      if (!task.claimed_pid || held.has(id)) {
        continue;
      }
      if (await this.alive(task.claimed_pid)) {
        continue;
      }

      await this.publisher.log(
        `reaping ${id}: "${task.claimed_by}" (pid ${task.claimed_pid}) is gone`,
      );
      await this.pool.harvest(task.workspace);
      await this.graph.releaseClaim(id);

      for (const runner of this.pool.runners()) {
        if (runner.taskId === id) {
          await this.pool.release(runner.slot.name);
        }
      }
    }
  }
}
