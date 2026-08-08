import type { Paths, Publisher, Workspaces } from "./ports.ts";
import { Pool } from "./pool.ts";
import { TaskGraph } from "./task-graph.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

export class Recovery {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly workspaces: Workspaces,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => boolean,
    private readonly base: string,
  ) {}

  reclone(): void {
    for (const [id, task] of this.graph.list()) {
      const workspace = task.workspace;
      if (workspace === null || this.workspaces.exists(workspace.worktree)) {
        continue;
      }
      if (!this.workspaces.branchExists(workspace.branch)) {
        this.publisher.log(
          `task ${id} lost both its worktree and branch ${workspace.branch}`,
        );
        continue;
      }
      this.paths.prepare(id);
      this.workspaces.create(workspace.branch, workspace.worktree, this.base);
      this.publisher.log(
        `recloned the workspace for ${id} from ${workspace.branch}`,
      );
    }
  }

  reattach(): void {
    const rows = this.publisher.lastSlots();
    if (rows === null) {
      return;
    }

    for (const row of rows) {
      const runner = this.pool
        .workers()
        .find((one) => one.slot.name === row.name);
      if (
        runner === undefined ||
        row.pid === null ||
        row.task_id === null ||
        !this.alive(row.pid)
      ) {
        continue;
      }

      runner.state = "BUSY";
      runner.taskId = row.task_id;
      runner.role = row.role;
      runner.startedAt = row.started_at;
      runner.detachedPid = row.pid;
      runner.session = row.session;

      this.publisher.log(
        `${row.name} is still running ${row.task_id} as pid ${row.pid}; leaving it alone`,
      );
    }
  }

  reap(tasks: Map<TaskId, TaskMeta>): void {
    const held = this.pool.busyTasks();

    for (const [id, task] of tasks) {
      if (
        task.claimed_pid === null ||
        held.has(id) ||
        this.alive(task.claimed_pid)
      ) {
        continue;
      }

      this.publisher.log(
        `reaping ${id}: "${task.claimed_by}" (pid ${task.claimed_pid}) is gone`,
      );
      this.pool.harvest(task.workspace);
      this.graph.releaseClaim(id);

      for (const runner of this.pool.workers()) {
        if (runner.taskId === id && runner.process?.alive !== true) {
          runner.process?.close();
          this.pool.release(runner.slot.name);
        }
      }
    }
  }
}
