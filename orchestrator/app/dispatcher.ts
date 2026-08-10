import type { Assignments } from "./ports/assignments.ts";
import type { Messages } from "./ports/messages.ts";
import type { Paths } from "./ports/paths.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import { type Runner, Pool } from "./pool.ts";
import { Settler } from "./settler.ts";
import { type Snapshot, TaskGraph } from "./task-graph.ts";
import type { Slot } from "../domain/agents.ts";
import { messageOf } from "../domain/errors.ts";
import {
  type TaskId,
  type TaskMeta,
  normalizeBody,
  requireSession,
  requireWorkspace,
} from "../domain/task.ts";
import { type Role, STAGE_OF } from "../domain/state-machine.ts";
import { branchName } from "../domain/workspace.ts";
import { type Candidate, schedule } from "../policy/scheduler.ts";

export class Dispatcher {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly settler: Settler,
    private readonly workspaces: Workspaces,
    private readonly assignments: Assignments,
    private readonly messages: Messages,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly base: string,
  ) {}

  async resumable(tasks: Map<TaskId, TaskMeta>): Promise<Set<TaskId>> {
    const ids = new Set<TaskId>();
    for (const [id, task] of tasks) {
      if (
        task.state === "WORK" &&
        task.claimed_by === null &&
        task.workspace?.session != null &&
        (await this.pool.hasSession(task.workspace.session)) &&
        (await this.messages.queued(id, "WORK"))
      ) {
        ids.add(id);
      }
    }
    return ids;
  }

  async run({ tasks, blocking }: Snapshot): Promise<void> {
    for (const { candidate, slot } of schedule(
      tasks,
      await this.resumable(tasks),
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
        await this.publisher.log(
          `dispatch of ${task.id} to ${slot.name} failed: ${messageOf(err)}`,
        );
        await this.pool.finish(this.pool.runner(slot.name));
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
    runner.taskId = task.id;
    runner.startedAt = new Date().toISOString();
    runner.taskState = candidate.state;
    runner.role = candidate.role;
    runner.issues.clear();

    if (candidate.rank === "resume") {
      await this.resume(task, runner, candidate.role);
      return;
    }

    const state = candidate.state;
    await this.paths.prepare(task.id);
    const worktree = this.paths.worktree(task.id);
    const branch = task.workspace?.branch ?? branchName(task.id);

    if (!(await this.workspaces.exists(worktree))) {
      await this.workspaces.create(branch, worktree, this.base);
    }

    const section = STAGE_OF[state].section;
    runner.checkout = {
      branch,
      worktree,
      head: await this.workspaces.head(worktree),
      dispatched:
        section === null && (await this.assignments.exists(task.id))
          ? await this.assignments.read(task.id)
          : await this.writeAssignment(task, section),
    };

    const process = await this.pool.spawn(
      runner,
      { taskId: task.id, state, role: candidate.role, cwd: worktree },
      (settling) => this.settler.compacted(settling),
    );
    runner.process = process;

    const session = await process.newSession();
    runner.session = session;
    await this.requireStill(task, slot);
    await this.graph.claim(task.id, {
      slotName: slot.name,
      pid: process.pid,
      branch,
      worktree,
      session,
    });

    runner.state = "BUSY";
    const queued = await this.messages.drain(task.id, state);
    const message = await this.settler.nudge(task.id, state);
    await this.settler.prompt(
      this.pool.requireRun(runner),
      queued === "" ? message : `${queued}\n\n${message}`,
    );
    this.settler.watch(runner);
  }

  private async resume(
    task: TaskMeta,
    runner: Runner,
    role: Role,
  ): Promise<void> {
    const slot = runner.slot;
    const workspace = requireWorkspace(task);
    const session = requireSession(task, workspace);
    runner.checkout = {
      branch: workspace.branch,
      worktree: workspace.worktree,
      head: await this.workspaces.head(workspace.worktree),
      dispatched: await this.assignments.read(task.id),
    };

    const process = await this.pool.spawn(
      runner,
      {
        taskId: task.id,
        state: "WORK",
        role,
        cwd: workspace.worktree,
      },
      (settling) => this.settler.compacted(settling),
    );
    runner.process = process;

    await process.switchSession(session);
    runner.session = session;
    await this.requireStill(task, slot);
    await this.graph.claim(task.id, {
      slotName: slot.name,
      pid: process.pid,
      branch: workspace.branch,
      worktree: workspace.worktree,
      session,
    });

    runner.state = "BUSY";

    const queued = await this.messages.drain(task.id, "WORK");
    await this.settler.prompt(
      this.pool.requireRun(runner),
      queued === "" ? await this.settler.nudge(task.id, "WORK") : queued,
    );
    this.settler.watch(runner);
  }

  private async requireStill(task: TaskMeta, slot: Slot): Promise<void> {
    const current = (await this.graph.list()).get(task.id);
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

  private async writeAssignment(
    task: TaskMeta,
    section: string | null,
  ): Promise<string> {
    await this.assignments.rotate(task.id);

    const body = normalizeBody(await this.graph.body(task.id));
    const dispatched = section === null ? body : `${body}\n${section}\n`;
    await this.assignments.write(task.id, dispatched);
    return dispatched;
  }
}
