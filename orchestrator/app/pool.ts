import type { AgentProcess, AgentSpec, Agents } from "./ports/agents.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import {
  type SlotRow,
  type Slot,
  type SlotState,
  type Retry,
  idleRow,
} from "../domain/agents.ts";
import { type Awaitable, orNull } from "../domain/awaitable.ts";
import { abortable } from "../domain/activity.ts";
import { messageOf, uncaught } from "../domain/errors.ts";
import { type IssueName } from "../domain/issues.ts";
import { Rates } from "../domain/rates.ts";
import type { ResultCall } from "../domain/results.ts";
import type { ClaimState, Role } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";

export const BACKOFF_START_MS = 1000;

export interface Checkout {
  branch: string;
  worktree: string;
  head: string;
  dispatched: string;
}

export interface Runner {
  slot: Slot;
  state: SlotState;
  taskId: TaskId | null;
  taskState: ClaimState | null;
  role: Role | null;
  checkout: Checkout | null;
  process: AgentProcess | null;
  startedAt: string | null;
  detachedPid: number | null;
  session: string | null;
  tokens: number | null;
  contextPercent: number | null;
  compactions: number;
  results: ResultCall[];
  issues: Map<IssueName, number>;
  backoff: number;
  retry: Retry | null;
}

function freshRunner(slot: Slot): Runner {
  return {
    slot,
    state: "IDLE",
    taskId: null,
    taskState: null,
    role: null,
    checkout: null,
    process: null,
    startedAt: null,
    detachedPid: null,
    session: null,
    tokens: null,
    contextPercent: null,
    compactions: 0,
    results: [],
    issues: new Map(),
    backoff: BACKOFF_START_MS,
    retry: null,
  };
}

export interface Run {
  runner: Runner;
  process: AgentProcess;
  taskId: TaskId;
  state: ClaimState;
  checkout: Checkout;
}

export function runOf(runner: Runner): Run | null {
  const { process, taskId, taskState, checkout } = runner;
  if (
    process === null ||
    taskId === null ||
    taskState === null ||
    checkout === null
  ) {
    return null;
  }
  return { runner, process, taskId, state: taskState, checkout };
}

export class Pool {
  readonly slots: Slot[];
  readonly rates = new Rates();

  private readonly byName = new Map<string, Runner>();
  private readonly disabled = new Set<string>();
  private readonly tracked = new Set<Promise<void>>();

  constructor(
    private readonly agents: Agents,
    private readonly workspaces: Workspaces,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => Awaitable<boolean>,
  ) {
    this.slots = agents.slots();
    for (const slot of this.slots) {
      this.byName.set(slot.name, freshRunner(slot));
      if (!slot.enabled) {
        this.disabled.add(slot.agent);
      }
    }
  }

  runners(): Runner[] {
    return [...this.byName.values()];
  }

  runner(name: string): Runner {
    const runner = this.byName.get(name);
    if (runner === undefined) {
      throw new Error(`no agent slot named "${name}"`);
    }
    return runner;
  }

  freeSlots(): Slot[] {
    return this.runners()
      .filter(
        (runner) =>
          runner.state === "IDLE" && !this.disabled.has(runner.slot.agent),
      )
      .map((runner) => runner.slot);
  }

  busyTasks(): Set<TaskId | null> {
    return new Set(
      this.runners()
        .filter((runner) => runner.process !== null)
        .map((runner) => runner.taskId),
    );
  }

  hasSession(path: string): Awaitable<boolean> {
    return this.agents.hasSession(path);
  }

  agentNames(): string[] {
    return [...new Set(this.runners().map((runner) => runner.slot.agent))];
  }

  async setAgentEnabled(agent: string, enabled: boolean): Promise<SlotRow[]> {
    if (!this.agentNames().includes(agent)) {
      throw new Error(
        `no agent named "${agent}"; the pool has ${this.agentNames().join(", ")}`,
      );
    }

    if (enabled) {
      this.disabled.delete(agent);
    } else {
      this.disabled.add(agent);
    }

    const rows = this.rows().filter((row) => row.agent === agent);
    const draining = rows.filter((row) => row.state !== "DISABLED").length;

    await this.publisher.log(
      enabled
        ? `agent ${agent} enabled: ${rows.length} slots dispatchable`
        : `agent ${agent} disabled: ${draining} of ${rows.length} slots still running`,
    );

    return rows;
  }

  async abortSlot(name: string): Promise<SlotRow> {
    const runner = this.byName.get(name);
    if (runner === undefined) {
      throw new Error(
        `no agent slot named "${name}"; the pool has ${[...this.byName.keys()].join(", ")}`,
      );
    }

    if (runner.process === null || !runner.process.alive) {
      throw new Error(`${name} is not running`);
    }

    const activity = runner.process.stream.state.activity;
    if (!abortable(activity)) {
      throw new Error(`${name} is not running a bash tool call to abort`);
    }

    runner.process.abortBash();
    await this.publisher.log(`${name} aborted bash: ${activity.target}`);

    return this.rowOf(runner);
  }

  spawn(
    runner: Runner,
    spec: Omit<AgentSpec, "slot">,
    compacted: (runner: Runner) => Promise<void>,
  ): Awaitable<AgentProcess> {
    return this.agents.spawn(
      { ...spec, slot: runner.slot },
      (sample) => {
        this.rates.record(runner.slot.agent, sample);
      },
      () => {
        runner.compactions += 1;
        this.track(runner, compacted(runner));
      },
      (call) => {
        runner.results.push(call);
      },
    );
  }

  requireRun(runner: Runner): Run {
    const run = runOf(runner);
    if (run === null) {
      throw new Error(
        `${runner.slot.name} has no session to work in: it holds ${runner.taskId ?? "no task"}`,
      );
    }
    return run;
  }

  track(runner: Runner, work: Promise<void>): void {
    const taskId = runner.taskId;
    const settling = work
      .catch(async (err: unknown) => {
        await this.publisher.log(
          `${runner.slot.name} on ${taskId} failed: ${messageOf(err)}`,
        );
        await this.stop(runner);
      })
      .finally(() => {
        this.tracked.delete(settling);
      })
      .catch(uncaught);
    this.tracked.add(settling);
  }

  get inflight(): number {
    return this.tracked.size;
  }

  settled(): Promise<unknown> {
    return Promise.all([...this.tracked]);
  }

  async harvest(
    workspace: { branch: string; worktree: string } | null,
  ): Promise<void> {
    if (
      workspace === null ||
      !(await this.workspaces.exists(workspace.worktree))
    ) {
      return;
    }
    await this.workspaces.harvest(workspace.worktree, workspace.branch);
  }

  async stop(runner: Runner): Promise<void> {
    const process = runner.process;
    if (process !== null) {
      process.close();
      if (await this.alive(process.pid)) {
        process.kill();
      }
    }
    this.release(runner.slot.name);
  }

  async finish(runner: Runner): Promise<void> {
    const { checkout } = runner;
    await this.stop(runner);
    await this.harvest(checkout);
  }

  release(name: string): void {
    const runner = this.runner(name);
    Object.assign(runner, freshRunner(runner.slot));
  }

  rows(): SlotRow[] {
    return this.runners().map((runner) => this.rowOf(runner));
  }

  private rowOf(runner: Runner): SlotRow {
    const enabled = !this.disabled.has(runner.slot.agent);
    if (runner.state === "IDLE") {
      return idleRow(runner.slot, enabled);
    }

    return {
      ...idleRow(runner.slot, enabled),
      state: runner.state,
      task_id: runner.taskId,
      role: runner.role,
      pid: runner.process?.pid ?? runner.detachedPid,
      started_at: runner.startedAt,
      activity: runner.process?.stream.state.activity ?? { kind: "none" },
      tokens: runner.tokens,
      context_percent: runner.contextPercent,
      compactions: runner.compactions,
      session: runner.session,
      retry: runner.retry,
    };
  }

  async readStats(): Promise<void> {
    await Promise.all(
      this.runners().map(async (runner) => {
        if (runner.process === null || !runner.process.alive) {
          return;
        }
        const stats = await orNull(runner.process.stats());
        if (stats === null) {
          return;
        }
        runner.tokens = stats.tokens ?? runner.tokens;
        runner.contextPercent = stats.contextPercent ?? runner.contextPercent;
      }),
    );
  }

  shutdown(): void {
    for (const runner of this.runners()) {
      if (runner.process === null) {
        continue;
      }
      runner.state = "ABORTING";
      try {
        runner.process.abort();
      } catch {
        // the process is already gone
      }
      runner.process.kill();
    }
  }
}
