import type { Paths, Publisher, Workspaces } from "./ports.ts";
import { Pool } from "./pool.ts";
import { TaskGraph } from "./task-graph.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

export class Recover {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly git: Workspaces,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => boolean,
    private readonly base: string,
  ) {}

  workspaces(): void {
    for (const [id, task] of this.graph.list()) {
      const workspace = task.workspace;
      if (workspace === null || this.git.exists(workspace.worktree)) {
        continue;
      }
      if (!this.git.branchExists(workspace.branch)) {
        this.publisher.log(
          `task ${id} lost both its worktree and branch ${workspace.branch}`,
        );
        continue;
      }
      this.paths.prepare(id);
      this.git.create(workspace.branch, workspace.worktree, this.base);
      this.publisher.log(
        `recloned the workspace for ${id} from ${workspace.branch}`,
      );
    }
  }

  reattach(): void {
    const rows = this.publisher.lastAgents();
    if (rows === null) {
      return;
    }

    for (const row of rows) {
      const worker = this.pool
        .workers()
        .find((one) => one.slot.name === row.name);
      if (
        worker === undefined ||
        row.pid === null ||
        row.task_id === null ||
        !this.alive(row.pid)
      ) {
        continue;
      }

      worker.state = "BUSY";
      worker.task_id = row.task_id;
      worker.role = row.role;
      worker.started_at = row.started_at;
      worker.detachedPid = row.pid;
      worker.session = row.session;

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

      for (const worker of this.pool.workers()) {
        if (worker.task_id === id && worker.process?.alive !== true) {
          worker.process?.close();
          this.pool.release(worker.slot.name);
        }
      }
    }
  }
}
