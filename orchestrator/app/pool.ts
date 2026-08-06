import type {
  AgentSession,
  AgentSpec,
  Agents,
  Paths,
  Publisher,
  Workspaces,
} from "./ports.ts";
import {
  type AgentRow,
  type AgentSlot,
  type AgentState,
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

export interface Worker {
  slot: AgentSlot;
  state: AgentState;
  task_id: TaskId | null;
  stage: ClaimState | null;
  role: Role | null;
  branch: string | null;
  worktree: string | null;
  head: string | null;
  process: AgentSession | null;
  started_at: string | null;
  dispatched: string | null;
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

function freshWorker(slot: AgentSlot): Worker {
  return {
    slot,
    state: "IDLE",
    task_id: null,
    stage: null,
    role: null,
    branch: null,
    worktree: null,
    head: null,
    process: null,
    started_at: null,
    dispatched: null,
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

export interface Checkout {
  branch: string;
  worktree: string;
}

export class Pool {
  readonly slots: AgentSlot[];
  readonly rates = new Rates();

  private readonly members = new Map<string, Worker>();
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
      this.members.set(slot.name, freshWorker(slot));
      if (!slot.enabled) {
        this.disabled.add(slot.agent);
      }
    }
  }

  workers(): Worker[] {
    return [...this.members.values()];
  }

  worker(name: string): Worker {
    const worker = this.members.get(name);
    if (worker === undefined) {
      throw new Error(`no agent slot named "${name}"`);
    }
    return worker;
  }

  freeSlots(): AgentSlot[] {
    return this.workers()
      .filter(
        (worker) =>
          worker.state === "IDLE" && !this.disabled.has(worker.slot.agent),
      )
      .map((worker) => worker.slot);
  }

  busyTasks(): Set<TaskId | null> {
    return new Set(
      this.workers()
        .filter((worker) => worker.process?.alive === true)
        .map((worker) => worker.task_id),
    );
  }

  hasSession(path: string): boolean {
    return this.agents.hasSession(path);
  }

  agentKeys(): string[] {
    return [...new Set(this.workers().map((worker) => worker.slot.agent))];
  }

  setAgentEnabled(agent: string, enabled: boolean): AgentRow[] {
    if (!this.agentKeys().includes(agent)) {
      throw new Error(
        `no agent named "${agent}"; the pool has ${this.agentKeys().join(", ")}`,
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

  abortAgent(name: string): AgentRow {
    const worker = this.members.get(name);
    if (worker === undefined) {
      throw new Error(
        `no agent slot named "${name}"; the pool has ${[...this.members.keys()].join(", ")}`,
      );
    }

    if (worker.process === null || !worker.process.alive) {
      throw new Error(`${name} is not running`);
    }

    const activity = worker.process.stream.state.activity;
    if (!abortable(activity)) {
      throw new Error(`${name} is not running a bash tool call to abort`);
    }

    worker.process.abortBash();
    this.publisher.log(`${name} aborted bash: ${activity.target}`);

    return this.rows().find((row) => row.name === name)!;
  }

  spawn(
    worker: Worker,
    spec: Omit<AgentSpec, "slot">,
    compacted: (worker: Worker) => Promise<void>,
  ): AgentSession {
    return this.agents.spawn(
      { ...spec, slot: worker.slot },
      (sample) => {
        this.rates.record(worker.slot.agent, sample);
      },
      () => {
        worker.compactions += 1;
        this.track(worker, compacted(worker));
      },
      (call) => {
        worker.results.push(call);
      },
    );
  }

  track(worker: Worker, work: Promise<void>): void {
    const taskId = worker.task_id;
    const tracked = work
      .catch((err: Error) => {
        this.publisher.log(
          `${worker.slot.name} on ${taskId} failed: ${err.message}`,
        );
        this.stop(worker);
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

  harvest(workspace: Checkout | null): void {
    if (workspace === null || !this.git.exists(workspace.worktree)) {
      return;
    }
    this.git.harvest(workspace.worktree, workspace.branch);
  }

  stop(worker: Worker): void {
    const process = worker.process;
    if (process !== null) {
      process.close();
      if (this.alive(process.pid)) {
        process.kill();
      }
    }
    this.release(worker.slot.name);
  }

  finish(worker: Worker): void {
    const { branch, worktree } = worker;
    this.stop(worker);
    if (branch !== null && worktree !== null) {
      this.harvest({ branch, worktree });
    }
  }

  release(name: string): void {
    const worker = this.worker(name);
    Object.assign(worker, freshWorker(worker.slot));
  }

  rows(): AgentRow[] {
    return this.workers().map((worker) => {
      const enabled = !this.disabled.has(worker.slot.agent);
      if (worker.state === "IDLE") {
        return idleRow(worker.slot, enabled);
      }

      return {
        ...idleRow(worker.slot, enabled),
        state: worker.state,
        task_id: worker.task_id,
        role: worker.role,
        pid: worker.process?.pid ?? worker.detachedPid,
        started_at: worker.started_at,
        activity: worker.process?.stream.state.activity ?? { kind: "none" },
        tokens: worker.tokens,
        context_percent: worker.contextPercent,
        compactions: worker.compactions,
        session: worker.session,
        log: worker.task_id === null ? null : this.paths.rpcLog(worker.task_id),
        retry: worker.retry,
      };
    });
  }

  async readStats(): Promise<void> {
    await Promise.all(
      this.workers().map(async (worker) => {
        if (worker.process === null || !worker.process.alive) {
          return;
        }
        const stats = await worker.process.stats().catch(() => null);
        if (stats === null) {
          return;
        }
        worker.tokens = stats.tokens ?? worker.tokens;
        worker.contextPercent = stats.contextPercent ?? worker.contextPercent;
      }),
    );
  }

  shutdown(): void {
    for (const worker of this.workers()) {
      if (worker.process === null) {
        continue;
      }
      worker.state = "ABORTING";
      try {
        worker.process.abort();
      } catch {
        // the process is already gone
      }
      worker.process.kill();
    }
  }
}
