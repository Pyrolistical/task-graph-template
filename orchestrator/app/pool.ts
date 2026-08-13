import type { AgentProcess, Agents } from "./ports/agents.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import {
  type SlotRow,
  type Slot,
  type SlotState,
  idleRow,
} from "../domain/agents.ts";
import { type Awaitable, orUndefined } from "../domain/awaitable.ts";
import { abortable } from "../domain/activity.ts";
import { type Wait, due, retryOf } from "../domain/backoff.ts";
import { type Carried, type Cost, costOf, secondsOf } from "../domain/costs.ts";
import { messageOf, uncaught } from "../domain/errors.ts";
import { type IssueName } from "../domain/issues.ts";
import { Rates } from "../domain/rates.ts";
import { withinSchedule } from "../domain/schedule.ts";
import type { ResultCall } from "../domain/results.ts";
import type { ClaimState, Role } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";

export interface Checkout {
  branch: string;
  worktree: string;
  head: string;
  dispatched: string;
}

export interface Reservation {
  taskId: TaskId;
  state: ClaimState;
  role: Role;
  startedAt?: string;
  resumed?: boolean;
  carried?: Carried;
}

interface Runner {
  slot: Slot;
  state: SlotState;
  run?: Run;
  taskId?: TaskId;
  taskState?: ClaimState;
  role?: Role;
  process?: AgentProcess;
  startedAt?: string;
  detachedPid?: number;
  session?: string;
  resumed: boolean;
  carried: Carried;
  tokens?: number;
  cost?: number;
  contextPercent?: number;
  compactions: number;
  results: ResultCall[];
  issues: Map<IssueName, number>;
  wait?: Wait;
}

function freshRunner(slot: Slot): Runner {
  return {
    slot,
    state: "IDLE",
    run: undefined,
    taskId: undefined,
    taskState: undefined,
    role: undefined,
    process: undefined,
    startedAt: undefined,
    detachedPid: undefined,
    session: undefined,
    resumed: false,
    carried: { seconds: 0, cost: 0 },
    tokens: undefined,
    cost: undefined,
    contextPercent: undefined,
    compactions: 0,
    results: [],
    issues: new Map(),
    wait: undefined,
  };
}

export class Run {
  constructor(
    private readonly runner: Runner,
    readonly process: AgentProcess,
    readonly taskId: TaskId,
    readonly state: ClaimState,
    readonly role: Role,
    readonly checkout: Checkout,
  ) {}

  get slot(): Slot {
    return this.runner.slot;
  }

  get results(): ResultCall[] {
    return this.runner.results;
  }

  get session(): string | undefined {
    return this.runner.session;
  }

  get wait(): Wait | undefined {
    return this.runner.wait;
  }

  attempts(issue: IssueName): number {
    return this.runner.issues.get(issue) ?? 0;
  }
}

export class Pool {
  readonly slots: Slot[];
  readonly rates = new Rates();

  private readonly byName = new Map<string, Runner>();
  private readonly disabled = new Set<string>();
  private readonly unreachable = new Set<string>();
  private readonly tracked = new Set<Promise<void>>();

  constructor(
    private readonly agents: Agents,
    private readonly workspaces: Workspaces,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => Awaitable<boolean>,
    private readonly costs: (
      taskId: TaskId,
      cost: Cost,
      resumed: boolean,
    ) => Awaitable<void>,
  ) {
    this.slots = agents.slots();
    for (const slot of this.slots) {
      this.byName.set(slot.name, freshRunner(slot));
      if (!slot.enabled) {
        this.disabled.add(slot.agent);
      }
    }
  }

  private runner(name: string): Runner {
    const runner = this.byName.get(name);
    if (!runner) {
      throw new Error(`no agent slot named "${name}"`);
    }
    return runner;
  }

  private held(run: Run): Runner {
    const runner = this.runner(run.slot.name);
    if (runner.run !== run) {
      throw new Error(
        `${run.slot.name} no longer holds ${run.taskId}; its slot was released`,
      );
    }
    return runner;
  }

  private runners(): Runner[] {
    return [...this.byName.values()];
  }

  async freeSlots(): Promise<Slot[]> {
    const idle = this.runners()
      .filter(
        (runner) =>
          runner.state === "IDLE" &&
          !this.disabled.has(runner.slot.agent) &&
          withinSchedule(runner.slot.schedule),
      )
      .map((runner) => runner.slot);

    const probes = new Map<string, Awaitable<boolean>>();
    for (const slot of idle) {
      if (slot.healthCheck && !probes.has(slot.provider)) {
        probes.set(slot.provider, this.agents.healthy(slot));
      }
    }

    for (const [provider, probe] of probes) {
      await this.noteHealth(provider, await probe);
    }

    return idle.filter((slot) => this.reachable(slot));
  }

  private reachable(slot: Slot): boolean {
    return !slot.healthCheck || !this.unreachable.has(slot.provider);
  }

  private async noteHealth(provider: string, healthy: boolean): Promise<void> {
    if (healthy === !this.unreachable.has(provider)) {
      return;
    }
    if (healthy) {
      this.unreachable.delete(provider);
    } else {
      this.unreachable.add(provider);
    }
    await this.publisher.log(
      healthy
        ? `provider ${provider} answered its health check: its slots are dispatchable again`
        : `provider ${provider} failed its health check: its slots are held back`,
    );
  }

  busyTasks(): Set<TaskId | undefined> {
    return new Set(
      this.runners()
        .filter((runner) => runner.process)
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
    if (!runner) {
      throw new Error(
        `no agent slot named "${name}"; the pool has ${[...this.byName.keys()].join(", ")}`,
      );
    }

    if (!runner.process || !runner.process.alive) {
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

  reserve(slot: Slot, reservation: Reservation): void {
    const runner = this.runner(slot.name);
    if (runner.state !== "IDLE") {
      throw new Error(
        `${slot.name} is ${runner.state} on ${runner.taskId ?? "no task"}; it cannot take ${reservation.taskId}`,
      );
    }

    runner.state = "SPAWNING";
    runner.taskId = reservation.taskId;
    runner.taskState = reservation.state;
    runner.role = reservation.role;
    runner.startedAt = reservation.startedAt ?? new Date().toISOString();
    runner.resumed = reservation.resumed ?? false;
    runner.carried = reservation.carried ?? { seconds: 0, cost: 0 };
    runner.issues.clear();
    runner.results = [];
  }

  async spawn(
    slot: Slot,
    checkout: Checkout,
    cwd: string,
    compacted: (run: Run) => Promise<void>,
  ): Promise<Run> {
    const runner = this.runner(slot.name);
    const { taskId, taskState, role } = runner;
    if (!taskId || !taskState || !role) {
      throw new Error(`${slot.name} was not reserved for a task before spawn`);
    }

    let spawned: Run | undefined = undefined;

    const process = await this.agents.spawn(
      { taskId, state: taskState, role, slot, cwd },
      (sample) => {
        this.rates.record(slot.agent, sample);
      },
      () => {
        runner.compactions += 1;
        if (spawned) {
          this.track(spawned, compacted(spawned));
        }
      },
      (call) => {
        runner.results.push(call);
      },
    );

    spawned = new Run(runner, process, taskId, taskState, role, checkout);
    runner.process = process;
    runner.run = spawned;
    return spawned;
  }

  opened(run: Run, session: string): void {
    this.held(run).session = session;
  }

  busy(run: Run): void {
    this.held(run).state = "BUSY";
  }

  settling(run: Run): void {
    this.held(run).state = "SETTLED";
  }

  waiting(run: Run, wait: Wait): void {
    const runner = this.held(run);
    runner.state = "WAITING";
    runner.wait = wait;
  }

  recovered(run: Run): void {
    this.held(run).wait = undefined;
  }

  raised(run: Run, issue: IssueName): void {
    const runner = this.held(run);
    runner.issues.set(issue, run.attempts(issue) + 1);
    runner.state = "BUSY";
  }

  clearResults(run: Run): void {
    this.held(run).results = [];
  }

  due(nowMs = Date.now()): Run[] {
    return this.runners()
      .filter((runner) => runner.state === "WAITING")
      .flatMap((runner) =>
        runner.run && runner.wait && due(runner.wait, nowMs)
          ? [runner.run]
          : [],
      );
  }

  reattach(row: SlotRow, state?: ClaimState): boolean {
    const runner = this.byName.get(row.name);
    if (!runner || !row.pid || !row.task_id) {
      return false;
    }
    runner.state = "BUSY";
    runner.taskId = row.task_id;
    runner.taskState = state;
    runner.role = row.role;
    runner.startedAt = row.started_at;
    runner.detachedPid = row.pid;
    runner.session = row.session;
    return true;
  }

  track(run: Run, work: Promise<void>): void {
    const settling = work
      .catch(async (err: unknown) => {
        await this.publisher.log(
          `${run.slot.name} on ${run.taskId} failed: ${messageOf(err)}`,
        );
        await this.stop(run);
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

  async harvest(workspace?: {
    branch: string;
    worktree: string;
  }): Promise<void> {
    if (!workspace || !(await this.workspaces.exists(workspace.worktree))) {
      return;
    }
    await this.workspaces.harvest(workspace.worktree, workspace.branch);
  }

  async stop(run: Run): Promise<void> {
    if (this.runner(run.slot.name).run !== run) {
      return;
    }
    await this.stopSlot(run.slot.name);
  }

  async finish(run: Run): Promise<void> {
    if (this.runner(run.slot.name).run !== run) {
      return;
    }
    await this.finishSlot(run.slot.name);
  }

  async finishSlot(name: string): Promise<void> {
    const checkout = this.runner(name).run?.checkout;
    await this.stopSlot(name);
    await this.harvest(checkout);
  }

  private async stopSlot(name: string): Promise<void> {
    const process = this.runner(name).process;
    if (process) {
      process.close();
      if (await this.alive(process.pid)) {
        process.kill();
      }
    }
    await this.release(name);
  }

  async releaseTask(taskId: TaskId): Promise<void> {
    for (const runner of this.runners()) {
      if (runner.taskId === taskId) {
        await this.release(runner.slot.name);
      }
    }
  }

  async release(name: string): Promise<void> {
    const runner = this.runner(name);
    const { taskId, taskState, session } = runner;
    if (taskId && taskState && session) {
      await this.costs(
        taskId,
        {
          state: taskState,
          slot: runner.slot.name,
          seconds: secondsOf(this.elapsed(runner), runner.carried.seconds),
          cost: this.spent(runner),
        },
        runner.resumed,
      );
    }
    Object.assign(runner, freshRunner(runner.slot));
  }

  private elapsed(runner: Runner): number {
    const started = runner.startedAt
      ? Date.parse(runner.startedAt)
      : Date.now();
    return Date.now() - started;
  }

  private spent(runner: Runner): number {
    return costOf(
      runner.slot,
      this.elapsed(runner),
      runner.cost,
      runner.carried.cost,
    );
  }

  rows(): SlotRow[] {
    return this.runners().map((runner) => this.rowOf(runner));
  }

  private rowOf(runner: Runner): SlotRow {
    const enabled = !this.disabled.has(runner.slot.agent);
    const reachable = this.reachable(runner.slot);
    if (runner.state === "IDLE") {
      return idleRow(runner.slot, enabled, reachable);
    }

    return {
      ...idleRow(runner.slot, enabled, reachable),
      state: runner.state,
      task_id: runner.taskId,
      role: runner.role,
      pid: runner.process?.pid ?? runner.detachedPid,
      started_at: runner.startedAt,
      activity: runner.process?.stream.state.activity ?? { kind: "none" },
      tokens: runner.tokens,
      cost: this.spent(runner),
      context_percent: runner.contextPercent,
      compactions: runner.compactions,
      session: runner.session,
      retry:
        runner.state === "WAITING" && runner.wait
          ? retryOf(runner.wait)
          : undefined,
    };
  }

  async readStats(): Promise<void> {
    await Promise.all(
      this.runners().map(async (runner) => {
        if (!runner.process || !runner.process.alive) {
          return;
        }
        const stats = await orUndefined(runner.process.stats());
        if (!stats) {
          return;
        }
        runner.tokens = stats.tokens ?? runner.tokens;
        runner.cost = stats.cost ?? runner.cost;
        runner.contextPercent = stats.contextPercent ?? runner.contextPercent;
      }),
    );
  }

  shutdown(): void {
    for (const runner of this.runners()) {
      if (!runner.process) {
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
