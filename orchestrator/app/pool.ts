import type {
  AgentProcess,
  AgentSpec,
  Agents,
  Paths,
  Publisher,
  Workspaces,
} from "./ports.ts";
import {
  type SlotRow,
  type Slot,
  type SlotState,
  type Retry,
  idleRow,
} from "../domain/agents.ts";
import { abortable } from "../domain/activity.ts";
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
  task_id: TaskId | null;
  stage: ClaimState | null;
  role: Role | null;
  checkout: Checkout | null;
  process: AgentProcess | null;
  started_at: string | null;
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
    task_id: null,
    stage: null,
    role: null,
    checkout: null,
    process: null,
    started_at: null,
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

export interface Running {
  runner: Runner;
  process: AgentProcess;
  taskId: TaskId;
  stage: ClaimState;
  checkout: Checkout;
}

export function running(runner: Runner): Running | null {
  const { process, task_id, stage, checkout } = runner;
  if (
    process === null ||
    task_id === null ||
    stage === null ||
    checkout === null
  ) {
    return null;
  }
  return { runner, process, taskId: task_id, stage, checkout };
}

export class Pool {
  readonly slots: Slot[];
  readonly rates = new Rates();

  private readonly members = new Map<string, Runner>();
  private readonly disabled = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly agents: Agents,
    private readonly git: Workspaces,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly alive: (pid: number) => boolean,
  ) {
    this.slots = agents.slots();
    for (const slot of this.slots) {
      this.members.set(slot.name, freshRunner(slot));
      if (!slot.enabled) {
        this.disabled.add(slot.agent);
      }
    }
  }

  workers(): Runner[] {
    return [...this.members.values()];
  }

  runner(name: string): Runner {
    const runner = this.members.get(name);
    if (runner === undefined) {
      throw new Error(`no agent slot named "${name}"`);
    }
    return runner;
  }

  freeSlots(): Slot[] {
    return this.workers()
      .filter(
        (runner) =>
          runner.state === "IDLE" && !this.disabled.has(runner.slot.agent),
      )
      .map((runner) => runner.slot);
  }

  busyTasks(): Set<TaskId | null> {
    return new Set(
      this.workers()
        .filter((runner) => runner.process?.alive === true)
        .map((runner) => runner.task_id),
    );
  }

  hasSession(path: string): boolean {
    return this.agents.hasSession(path);
  }

  agentNames(): string[] {
    return [...new Set(this.workers().map((runner) => runner.slot.agent))];
  }

  setAgentEnabled(agent: string, enabled: boolean): SlotRow[] {
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

    this.publisher.log(
      enabled
        ? `agent ${agent} enabled: ${rows.length} slots dispatchable`
        : `agent ${agent} disabled: ${draining} of ${rows.length} slots still running`,
    );

    return rows;
  }

  abortAgent(name: string): SlotRow {
    const runner = this.members.get(name);
    if (runner === undefined) {
      throw new Error(
        `no agent slot named "${name}"; the pool has ${[...this.members.keys()].join(", ")}`,
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
    this.publisher.log(`${name} aborted bash: ${activity.target}`);

    return this.rows().find((row) => row.name === name)!;
  }

  spawn(
    runner: Runner,
    spec: Omit<AgentSpec, "slot">,
    compacted: (runner: Runner) => Promise<void>,
  ): AgentProcess {
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

  runOf(runner: Runner): Running {
    const run = running(runner);
    if (run === null) {
      throw new Error(
        `${runner.slot.name} has no session to work in: it holds ${runner.task_id ?? "no task"}`,
      );
    }
    return run;
  }

  track(runner: Runner, work: Promise<void>): void {
    const taskId = runner.task_id;
    const tracked = work
      .catch((err: Error) => {
        this.publisher.log(
          `${runner.slot.name} on ${taskId} failed: ${err.message}`,
        );
        this.stop(runner);
      })
      .finally(() => {
        this.inflight.delete(tracked);
      });
    this.inflight.add(tracked);
  }

  get running(): number {
    return this.inflight.size;
  }

  settled(): Promise<unknown> {
    return Promise.all([...this.inflight]);
  }

  harvest(workspace: { branch: string; worktree: string } | null): void {
    if (workspace === null || !this.git.exists(workspace.worktree)) {
      return;
    }
    this.git.harvest(workspace.worktree, workspace.branch);
  }

  stop(runner: Runner): void {
    const process = runner.process;
    if (process !== null) {
      process.close();
      if (this.alive(process.pid)) {
        process.kill();
      }
    }
    this.release(runner.slot.name);
  }

  finish(runner: Runner): void {
    const { checkout } = runner;
    this.stop(runner);
    this.harvest(checkout);
  }

  release(name: string): void {
    const runner = this.runner(name);
    Object.assign(runner, freshRunner(runner.slot));
  }

  rows(): SlotRow[] {
    return this.workers().map((runner) => {
      const enabled = !this.disabled.has(runner.slot.agent);
      if (runner.state === "IDLE") {
        return idleRow(runner.slot, enabled);
      }

      return {
        ...idleRow(runner.slot, enabled),
        state: runner.state,
        task_id: runner.task_id,
        role: runner.role,
        pid: runner.process?.pid ?? runner.detachedPid,
        started_at: runner.started_at,
        activity: runner.process?.stream.state.activity ?? { kind: "none" },
        tokens: runner.tokens,
        context_percent: runner.contextPercent,
        compactions: runner.compactions,
        session: runner.session,
        log: runner.task_id === null ? null : this.paths.rpcLog(runner.task_id),
        retry: runner.retry,
      };
    });
  }

  async readStats(): Promise<void> {
    await Promise.all(
      this.workers().map(async (runner) => {
        if (runner.process === null || !runner.process.alive) {
          return;
        }
        const stats = await runner.process.stats().catch(() => null);
        if (stats === null) {
          return;
        }
        runner.tokens = stats.tokens ?? runner.tokens;
        runner.contextPercent = stats.contextPercent ?? runner.contextPercent;
      }),
    );
  }

  shutdown(): void {
    for (const runner of this.workers()) {
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
