import type { Assignments } from "../../runtime/ports/assignments.ts";
import type { Messages } from "../../runtime/ports/messages.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { Publisher } from "../../runtime/ports/publisher.ts";
import type { Workspaces } from "../../workspaces/ports/workspaces.ts";
import type { Checkout, Pool, Run } from "../../agents/app/pool.ts";
import { Settler } from "./settler.ts";
import { type Snapshot, TaskGraph } from "./task-graph.ts";
import type { Slot } from "../../agents/domain/slots.ts";
import { carriedOn } from "../../vocabulary/costs.ts";
import { messageOf } from "../../kernel/domain/errors.ts";
import {
  type TaskId,
  type TaskMeta,
  normalizeBody,
  requireSession,
  requireWorkspace,
} from "../../vocabulary/task.ts";
import { type ClaimState, STAGE_OF } from "../../vocabulary/state-machine.ts";
import { branchName } from "../../workspaces/domain/workspace.ts";
import { type Candidate } from "../../views/queue.ts";
import { schedule } from "../../agents/policy/scheduler.ts";

export interface DispatcherOptions {
  graph: TaskGraph;
  pool: Pool;
  settler: Settler;
  workspaces: Workspaces;
  assignments: Assignments;
  messages: Messages;
  paths: Paths;
  publisher: Publisher;
  base: string;
  agentsPath: string;
}

export class Dispatcher {
  private scheduling = false;

  private readonly graph: TaskGraph;
  private readonly pool: Pool;
  private readonly settler: Settler;
  private readonly workspaces: Workspaces;
  private readonly assignments: Assignments;
  private readonly messages: Messages;
  private readonly paths: Paths;
  private readonly publisher: Publisher;
  private readonly base: string;
  private readonly agentsPath: string;

  constructor(options: DispatcherOptions) {
    this.graph = options.graph;
    this.pool = options.pool;
    this.settler = options.settler;
    this.workspaces = options.workspaces;
    this.assignments = options.assignments;
    this.messages = options.messages;
    this.paths = options.paths;
    this.publisher = options.publisher;
    this.base = options.base;
    this.agentsPath = options.agentsPath;
  }

  get enabled(): boolean {
    return this.scheduling;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.pool.slots.length === 0) {
      throw new Error(
        `no agents to dispatch to; add one to ${this.agentsPath}`,
      );
    }
    this.scheduling = enabled;
    await this.publisher.log(`scheduler ${enabled ? "enabled" : "disabled"}`);
  }

  async resumable(tasks: Map<TaskId, TaskMeta>): Promise<Set<TaskId>> {
    const ids = new Set<TaskId>();
    for (const [id, task] of tasks) {
      if (
        task.state === "WORK" &&
        !task.claimed_by &&
        task.workspace?.session &&
        (await this.pool.hasSession(task.workspace.session)) &&
        (await this.messages.queued(id, "WORK"))
      ) {
        ids.add(id);
      }
    }
    return ids;
  }

  async run({ tasks, blocking }: Snapshot): Promise<void> {
    if (!this.scheduling) {
      return;
    }

    for (const { candidate, slot } of schedule(
      tasks,
      await this.resumable(tasks),
      blocking,
      await this.pool.freeSlots(),
      this.pool.rates.rateOf,
    )) {
      const task = tasks.get(candidate.task_id);
      if (!task) {
        continue;
      }
      try {
        await this.assign(task, candidate, slot);
      } catch (err) {
        await this.publisher.log(
          `dispatch of ${task.id} to ${slot.name} failed: ${messageOf(err)}`,
        );
        await this.pool.finishSlot(slot.name);
      }
    }
  }

  private assign(
    task: TaskMeta,
    candidate: Candidate,
    slot: Slot,
  ): Promise<void> {
    return candidate.rank === "resume"
      ? this.resume(task, candidate, slot)
      : this.begin(task, candidate, slot);
  }

  private async begin(
    task: TaskMeta,
    candidate: Candidate,
    slot: Slot,
  ): Promise<void> {
    this.pool.reserve(slot, {
      taskId: task.id,
      state: candidate.state,
      role: candidate.role,
    });

    await this.paths.prepare(task.id);
    const worktree = this.paths.worktree(task.id);
    const branch = task.workspace?.branch ?? branchName(task.id);

    if (!(await this.workspaces.exists(worktree))) {
      await this.workspaces.create(branch, worktree, this.base);
    }

    const section = STAGE_OF[candidate.state].section;
    await this.dispatch(task, slot, candidate.state, {
      branch,
      worktree,
      head: await this.workspaces.head(worktree),
      dispatched:
        !section && (await this.assignments.exists(task.id))
          ? await this.assignments.read(task.id)
          : await this.writeAssignment(task, section),
    });
  }

  private async resume(
    task: TaskMeta,
    candidate: Candidate,
    slot: Slot,
  ): Promise<void> {
    const workspace = requireWorkspace(task);
    const session = requireSession(task, workspace);

    this.pool.reserve(slot, {
      taskId: task.id,
      state: candidate.state,
      role: candidate.role,
      resumed: true,
      carried: carriedOn(task.costs, candidate.state),
    });

    await this.dispatch(
      task,
      slot,
      candidate.state,
      {
        branch: workspace.branch,
        worktree: workspace.worktree,
        head: await this.workspaces.head(workspace.worktree),
        dispatched: await this.assignments.read(task.id),
      },
      session,
    );
  }

  private async dispatch(
    task: TaskMeta,
    slot: Slot,
    state: ClaimState,
    checkout: Checkout,
    resuming?: string,
  ): Promise<void> {
    const run = await this.pool.spawn(
      slot,
      checkout,
      checkout.worktree,
      (settling) => this.settler.compacted(settling),
    );

    const session = await this.openSession(run, resuming);
    this.pool.opened(run, session);
    await this.requireStill(task, slot);
    await this.graph.claim(task.id, {
      slotName: slot.name,
      pid: run.process.pid,
      branch: checkout.branch,
      worktree: checkout.worktree,
      session,
    });

    this.pool.busy(run);
    const queued = await this.messages.drain(task.id, state);
    const parts: string[] = [];
    if (queued !== "") {
      parts.push(queued);
    }
    if (!resuming || queued === "") {
      parts.push(await this.settler.nudge(task.id, state));
    }
    await this.settler.prompt(run, parts.join("\n\n"));
    this.settler.watch(run);
  }

  private async openSession(run: Run, resuming?: string): Promise<string> {
    if (!resuming) {
      return run.process.newSession();
    }
    await run.process.switchSession(resuming);
    return resuming;
  }

  private async requireStill(task: TaskMeta, slot: Slot): Promise<void> {
    const current = await this.graph.read(task.id);
    if (current?.state !== task.state) {
      throw new Error(
        `${task.id} left ${task.state} before ${slot.name} could claim it`,
      );
    }
    if (current.claimed_by) {
      throw new Error(
        `${task.id} was claimed by "${current.claimed_by}" before ${slot.name} could claim it`,
      );
    }
  }

  private async writeAssignment(
    task: TaskMeta,
    section?: string,
  ): Promise<string> {
    await this.assignments.rotate(task.id);

    const body = normalizeBody(await this.graph.body(task.id));
    const dispatched = !section ? body : `${body}\n${section}\n`;
    await this.assignments.write(task.id, dispatched);
    return dispatched;
  }
}
