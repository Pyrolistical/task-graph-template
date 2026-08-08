import type {
  Assignments,
  Inbox,
  Paths,
  Publisher,
  Workspaces,
} from "./ports.ts";
import { type Runner, Pool } from "./pool.ts";
import { SettleAgent } from "./settle-agent.ts";
import { type Snapshot, TaskGraph } from "./task-graph.ts";
import type { Slot } from "../domain/agents.ts";
import { type TaskId, type TaskMeta, normalizeBody } from "../domain/task.ts";
import { type Role, STAGE_OF } from "../domain/state-machine.ts";
import { branchName } from "../domain/workspace.ts";
import { type Candidate, plan } from "../policy/scheduler.ts";

export class Dispatch {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly settle: SettleAgent,
    private readonly git: Workspaces,
    private readonly assignments: Assignments,
    private readonly inbox: Inbox,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly base: string,
  ) {}

  resumable(tasks: Map<TaskId, TaskMeta>): Set<TaskId> {
    const ids = new Set<TaskId>();
    for (const [id, task] of tasks) {
      if (
        task.state === "WORK" &&
        task.claimed_by === null &&
        task.workspace?.session != null &&
        this.pool.hasSession(task.workspace.session) &&
        this.inbox.queued(id, "WORK")
      ) {
        ids.add(id);
      }
    }
    return ids;
  }

  async run({ tasks, blocking }: Snapshot): Promise<void> {
    for (const { candidate, slot } of plan(
      tasks,
      this.resumable(tasks),
      blocking,
      this.pool.freeSlots(),
      this.pool.rates.rateOf,
    )) {
      const task = tasks.get(candidate.task_id);
      if (task === undefined) {
        continue;
      }
      try {
        await this.assign(task, candidate, slot);
      } catch (err) {
        this.publisher.log(
          `dispatch of ${task.id} to ${slot.name} failed: ${(err as Error).message}`,
        );
        this.pool.finish(this.pool.runner(slot.name));
      }
    }
  }

  private async assign(
    task: TaskMeta,
    candidate: Candidate,
    slot: Slot,
  ): Promise<void> {
    const runner = this.pool.runner(slot.name);
    runner.state = "SPAWNING";
    runner.task_id = task.id;
    runner.started_at = new Date().toISOString();
    runner.stage = candidate.stage;
    runner.role = candidate.role;
    runner.issues.clear();

    if (candidate.rank === "resume") {
      await this.resume(task, runner, candidate.role);
      return;
    }

    const stage = candidate.stage;
    this.paths.prepare(task.id);
    const worktree = this.paths.worktree(task.id);
    const branch = task.workspace?.branch ?? branchName(task.id);

    if (!this.git.exists(worktree)) {
      this.git.create(branch, worktree, this.base);
    }

    const section = STAGE_OF[stage].section;
    runner.checkout = {
      branch,
      worktree,
      head: this.git.head(worktree),
      dispatched:
        section === null && this.assignments.exists(task.id)
          ? this.assignments.read(task.id)
          : this.writeAssignment(task, section),
    };

    const process = this.pool.spawn(
      runner,
      { taskId: task.id, state: stage, role: candidate.role, cwd: worktree },
      (settling) => this.settle.compacted(settling),
    );
    runner.process = process;

    const session = await process.newSession();
    runner.session = session;
    this.requireStill(task, slot);
    this.graph.claim(task.id, {
      slotName: slot.name,
      pid: process.pid,
      branch,
      worktree,
      session,
    });

    runner.state = "BUSY";
    const queued = this.inbox.drain(task.id, stage);
    const message = this.settle.nudge(task.id, stage);
    await this.settle.prompt(
      this.pool.runOf(runner),
      queued === "" ? message : `${queued}\n\n${message}`,
    );
    this.settle.watch(runner);
  }

  private async resume(
    task: TaskMeta,
    runner: Runner,
    role: Role,
  ): Promise<void> {
    const slot = runner.slot;
    const workspace = task.workspace!;
    runner.checkout = {
      branch: workspace.branch,
      worktree: workspace.worktree,
      head: this.git.head(workspace.worktree),
      dispatched: this.assignments.read(task.id),
    };

    const process = this.pool.spawn(
      runner,
      {
        taskId: task.id,
        state: "WORK",
        role,
        cwd: workspace.worktree,
      },
      (settling) => this.settle.compacted(settling),
    );
    runner.process = process;

    await process.switchSession(workspace.session!);
    runner.session = workspace.session;
    this.requireStill(task, slot);
    this.graph.claim(task.id, {
      slotName: slot.name,
      pid: process.pid,
      branch: workspace.branch,
      worktree: workspace.worktree,
      session: workspace.session!,
    });

    runner.state = "BUSY";

    const queued = this.inbox.drain(task.id, "WORK");
    await this.settle.prompt(
      this.pool.runOf(runner),
      queued === "" ? this.settle.nudge(task.id, "WORK") : queued,
    );
    this.settle.watch(runner);
  }

  private requireStill(task: TaskMeta, slot: Slot): void {
    const current = this.graph.list().get(task.id);
    if (current?.state !== task.state) {
      throw new Error(
        `${task.id} left ${task.state} before ${slot.name} could claim it`,
      );
    }
    if (current.claimed_by !== null) {
      throw new Error(
        `${task.id} was claimed by "${current.claimed_by}" before ${slot.name} could claim it`,
      );
    }
  }

  private writeAssignment(task: TaskMeta, section: string | null): string {
    this.assignments.rotate(task.id);

    const body = normalizeBody(this.graph.body(task.id));
    const dispatched = section === null ? body : `${body}\n${section}\n`;
    this.assignments.write(task.id, dispatched);
    return dispatched;
  }
}
