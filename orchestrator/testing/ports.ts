import type { AgentProcess, Agents } from "../agents/ports/agents.ts";
import type { Assignments } from "../runtime/ports/assignments.ts";
import type { Checks } from "../checks/ports/checks.ts";
import type { Messages } from "../runtime/ports/messages.ts";
import type { Paths } from "../runtime/ports/paths.ts";
import type { Prompts } from "../prompting/ports/prompts.ts";
import type { Publisher, ViewName, Views } from "../runtime/ports/publisher.ts";
import type { Reviews } from "../runtime/ports/reviews.ts";
import type { CreatedTask, Tasks } from "../tasks/ports/tasks.ts";
import type {
  TransitionEntry,
  Transitions,
} from "../runtime/ports/transitions.ts";
import type { Workspaces } from "../workspaces/ports/workspaces.ts";
import {
  type Checkout,
  type Reservation as PoolReservation,
  type Run,
  Pool,
} from "../agents/app/pool.ts";
import type { Awaitable } from "../kernel/domain/awaitable.ts";
import type { StreamState } from "../agents/domain/protocol.ts";
import type { Activity } from "../views/activity.ts";
import type { SlotRow } from "../views/slots.ts";
import type { Slot } from "../agents/domain/slots.ts";
import type { Schedule } from "../agents/domain/schedule.ts";
import type { CheckResult } from "../checks/domain/checks.ts";
import type { RunningCheck } from "../views/checks.ts";
import type { Cost } from "../vocabulary/costs.ts";
import { type TaskId, type TaskMeta, formatId } from "../vocabulary/task.ts";
import type {
  Role,
  TransitionArgs,
  TransitionName,
  TransitionResult,
} from "../vocabulary/state-machine.ts";
import type { FragmentVars } from "../prompting/domain/fragment.ts";
import type { ResultCall } from "../agents/domain/results.ts";

export interface Reservation extends PoolReservation {
  slotName: string;
}

export async function yielded<T>(value: T): Promise<T> {
  await Promise.resolve();
  return value;
}

export function aSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    name: "pi-fake-fake-1",
    agent: "pi-fake-fake",
    type: "pi",
    provider: "fake",
    model: "fake",
    index: 1,
    enabled: true,
    schedule: undefined,
    healthCheck: false,
    wattage: 0,
    costPerKwh: 0,
    write: [],
    roles: ["worker", "reviewer", "planner", "designer"],
    ...overrides,
  };
}

export function aSchedule(
  fromMinutes: number,
  toMinutes: number,
  nowMs = Date.now(),
): Schedule {
  const hhmm = (minutes: number) => {
    const at = new Date(nowMs + minutes * 60 * 1000);
    return [at.getHours(), at.getMinutes()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  };
  return [{ start: hhmm(fromMinutes), end: hhmm(toMinutes) }];
}

export function aTask(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "000042",
    title: "a task",
    state: "WORK",
    state_entered: "2026-07-29T00:00:00Z",
    depends_on: [],
    claimed_by: undefined,
    claimed_pid: undefined,
    held_reason: undefined,
    workspace: undefined,
    checks: [],
    costs: [],
    ...overrides,
  };
}

export interface SessionStats {
  tokens?: number;
  cost?: number;
  contextPercent?: number;
}

export function aSession(
  activity: Activity = { kind: "none" },
  alive = true,
  prompts: string[] = [],
  stats: SessionStats = {},
  stream: Partial<StreamState> = {},
): AgentProcess {
  let settles = 0;
  return {
    pid: 4242,
    alive,
    stream: {
      state: {
        activity,
        settled: false,
        retrying: false,
        ...stream,
      },
      settled: () => {
        if (settles > 0) {
          return new Promise<void>(() => {});
        }
        settles += 1;
      },
    },
    newSession: () => yielded("a-session"),
    switchSession: () => {},
    prompt: (message: string) => {
      prompts.push(message);
    },
    steer: (message: string) => {
      prompts.push(message);
    },
    abort: () => {},
    abortBash: () => {},
    stats: () => yielded(stats),
    lastAssistantText: () => {},
    close: () => {},
    kill: () => {},
  };
}

export class FakePublisher implements Publisher {
  readonly lines: string[] = [];
  rows: SlotRow[] | undefined = undefined;
  published: Views | undefined = undefined;

  publish(views: Views): Awaitable<void> {
    this.published = views;
  }

  read(name: ViewName): Promise<string> {
    const views = this.published;
    if (!views) {
      return yielded("{}");
    }
    return yielded(
      `${JSON.stringify({ at: new Date().toISOString(), seq: views.seq, [name]: views[name] }, undefined, 2)}\n`,
    );
  }

  lastSlots(): Promise<SlotRow[] | undefined> {
    return yielded(this.rows);
  }

  log(line: string): Awaitable<void> {
    this.lines.push(line);
  }
}

export class FakeTasks implements Tasks {
  readonly released: TaskId[] = [];
  readonly costs: { id: TaskId; cost: Cost; resumed: boolean }[] = [];
  readonly bodies = new Map<TaskId, string>();

  constructor(private readonly tasks: Map<TaskId, TaskMeta>) {}

  list(): Promise<{
    tasks: Map<TaskId, TaskMeta>;
    problems: Map<string, string>;
  }> {
    return yielded({ tasks: this.tasks, problems: new Map<string, string>() });
  }

  read(id: TaskId): Promise<TaskMeta | undefined> {
    return yielded(this.tasks.get(id));
  }

  body(id: TaskId): Promise<string> {
    return yielded(this.bodies.get(id) ?? "the goal\n");
  }

  create(title: string): Promise<CreatedTask> {
    const id = formatId(this.tasks.size + 1);
    this.tasks.set(id, { ...aTask(), id, title, state: "NEW" });
    return yielded({ id, filePath: `/tasks/${id}.md` });
  }

  writeBody(id: TaskId, body: string): Promise<string> {
    this.bodies.set(id, body);
    return yielded(`/tasks/${id}.md`);
  }

  readonly applied: { id: TaskId; name: string; args: TransitionArgs }[] = [];

  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): Promise<TransitionResult> {
    this.applied.push({ id, name, args });
    const result: TransitionResult = {
      taskId: id,
      from: "WORK",
      to: "HELD_WORK",
      unblocked: [],
      dependentsUpdated: [],
    };
    return yielded(result);
  }

  claim(): Awaitable<void> {}

  takeLock(): Awaitable<void> {}

  clearLock(): Awaitable<void> {}

  releaseClaim(id: TaskId): Awaitable<void> {
    this.released.push(id);
    const task = this.tasks.get(id);
    if (task) {
      task.claimed_by = undefined;
      task.claimed_pid = undefined;
    }
  }

  recordCost(id: TaskId, cost: Cost, resumed: boolean): Awaitable<void> {
    this.costs.push({ id, cost, resumed });
  }
}

export class FakeWorkspaces implements Workspaces {
  readonly harvested: string[] = [];
  readonly created: string[] = [];
  present = new Set<string>();
  branches = new Set<string>();

  create(branch: string, worktree: string, _base: string): Awaitable<void> {
    this.created.push(worktree);
    this.present.add(worktree);
  }

  remove(worktree: string): Awaitable<void> {
    this.present.delete(worktree);
  }

  exists(worktree: string): Promise<boolean> {
    return yielded(this.present.has(worktree));
  }

  branchExists(branch: string): Promise<boolean> {
    return yielded(this.branches.has(branch));
  }

  deleteBranch(branch: string): Awaitable<void> {
    this.branches.delete(branch);
  }

  head(_worktree: string): Promise<string> {
    return yielded("0000000");
  }

  resetTo(_worktree: string, _commit: string): Awaitable<void> {}

  status(
    _worktree: string,
    _base: string,
  ): Promise<{ dirty: string[]; commits: number }> {
    return yielded({ dirty: [], commits: 0 });
  }

  harvest(worktree: string, _branch: string): Awaitable<void> {
    this.harvested.push(worktree);
  }

  syncBase(_worktree: string, _base: string): Awaitable<void> {}

  rebase(
    _worktree: string,
    _base: string,
  ): Promise<{ code: number; stderr: string }> {
    return yielded({ code: 0, stderr: "" });
  }

  abortRebase(_worktree: string): Awaitable<void> {}

  fastForward(_branch: string): Promise<{ code: number; stderr: string }> {
    return yielded({ code: 0, stderr: "" });
  }

  isAncestor(_ref: string, _of: string): Promise<boolean> {
    return yielded(false);
  }
}

export class FakeTransitions implements Transitions {
  readonly entries: TransitionEntry[] = [];

  get cursor(): number {
    return this.entries.length;
  }

  read(): Promise<TransitionEntry[]> {
    return yielded(this.entries);
  }

  append(entry: Omit<TransitionEntry, "seq" | "at">): Promise<TransitionEntry> {
    const full: TransitionEntry = {
      ...entry,
      seq: this.entries.length + 1,
      at: "2026-07-29T00:00:00Z",
    };
    this.entries.push(full);
    return yielded(full);
  }

  close(): Awaitable<void> {}
}

export class FakeTaskFiles implements Messages, Reviews {
  private readonly messages = new Map<string, string>();
  private readonly found = new Map<TaskId, string[]>();
  private readonly rejections = new Map<TaskId, number>();

  queue(taskId: TaskId, state: string, message: string): Awaitable<void> {
    this.messages.set(`${taskId}/${state}`, message);
  }

  drain(taskId: TaskId, state: string): Promise<string> {
    const key = `${taskId}/${state}`;
    const message = this.messages.get(key) ?? "";
    this.messages.delete(key);
    return yielded(message);
  }

  queued(taskId: TaskId, state: string): Promise<boolean> {
    return yielded(this.messages.has(`${taskId}/${state}`));
  }

  findings(taskId: TaskId): Promise<string[]> {
    return yielded(this.found.get(taskId) ?? []);
  }

  setFindings(taskId: TaskId, findings: string[]): Awaitable<void> {
    this.found.set(taskId, findings);
  }

  clearFindings(taskId: TaskId): Awaitable<void> {
    this.found.delete(taskId);
  }

  failures(taskId: TaskId): Promise<number> {
    return yielded(this.rejections.get(taskId) ?? 0);
  }

  setFailures(taskId: TaskId, failures: number): Awaitable<void> {
    this.rejections.set(taskId, failures);
  }

  clearFailures(taskId: TaskId): Awaitable<void> {
    this.rejections.delete(taskId);
  }
}

export class FakeChecks implements Checks {
  readonly view: RunningCheck[] = [];
  readonly ran: string[] = [];
  codes: number[] = [];

  isRunning(_taskId: TaskId): boolean {
    return false;
  }

  run(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult> {
    this.ran.push(`${taskId}:${index}:${command} in ${worktree}`);
    return yielded({
      task_id: taskId,
      index,
      command,
      code: this.codes[index] ?? 0,
      log: `/runtime/${taskId}/check-${index}.log`,
      tail: "",
    });
  }
}

export class FakeAssignments implements Assignments {
  private readonly contents = new Map<TaskId, string>();
  readonly rotated: TaskId[] = [];

  read(taskId: TaskId): Promise<string> {
    return yielded(this.contents.get(taskId) ?? "");
  }

  write(taskId: TaskId, contents: string): Awaitable<void> {
    this.contents.set(taskId, contents);
  }

  exists(taskId: TaskId): Promise<boolean> {
    return yielded(this.contents.has(taskId));
  }

  rotate(taskId: TaskId): Awaitable<void> {
    this.rotated.push(taskId);
  }
}

export class FakePaths implements Paths {
  readonly prepared: TaskId[] = [];
  readonly discarded: TaskId[] = [];
  readonly lines: string[] = [];

  readonly root = "/runtime";
  readonly serverLog = "/runtime/server.log";
  readonly transitionLog = "/runtime/transitions.jsonl";
  readonly slotsView = "/runtime/slots.json";
  readonly checksView = "/runtime/checks.json";
  readonly tasksView = "/runtime/tasks.json";
  readonly inboxView = "/runtime/inbox.json";
  readonly queueView = "/runtime/queue.json";
  readonly consoleCommand = "/runtime/command.json";

  taskRoot(id: TaskId): string {
    return `/runtime/${id}`;
  }

  worktree(id: TaskId): string {
    return `/runtime/${id}/worktree`;
  }

  assignment(id: TaskId): string {
    return `/runtime/${id}/ASSIGNMENT.md`;
  }

  history(id: TaskId): string {
    return `/runtime/${id}/history`;
  }

  findings(id: TaskId): string {
    return `/runtime/${id}/findings.json`;
  }

  reviewFailures(id: TaskId): string {
    return `/runtime/${id}/review-failures`;
  }

  sessionDir(id: TaskId, role: Role): string {
    return `/runtime/${id}/sessions/${role}`;
  }

  checkLog(id: TaskId, index: number): string {
    return `/runtime/${id}/checks/${index}.log`;
  }

  messagesDir(id: TaskId): string {
    return `/runtime/${id}/messages`;
  }

  prepare(id: TaskId): Awaitable<void> {
    this.prepared.push(id);
  }

  discard(id: TaskId): Awaitable<void> {
    this.discarded.push(id);
  }

  log(line: string): Awaitable<void> {
    this.lines.push(line);
  }

  takeLock(): Awaitable<void> {}

  clearLock(): Awaitable<void> {}

  close(): Awaitable<void> {}
}

export function fakePaths(): Paths {
  return new FakePaths();
}

export function fakeAgents(
  slots: Slot[],
  session: () => AgentProcess = () => aSession(),
  healthy: (slot: Slot) => Awaitable<boolean> = () => true,
  results: ResultCall[] = [],
): Agents {
  return {
    slots: () => slots,
    hasSession: (_path: string) => yielded(true),
    healthy,
    spawn: (_spec, _onUsage, _onCompaction, onResult) => {
      for (const call of results) {
        onResult(call);
      }
      return yielded(session());
    },
  };
}

export function aCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    branch: "task/000042",
    worktree: "/runtime/000042/worktree",
    head: "abc1234",
    dispatched: "the goal\n",
    ...overrides,
  };
}

export async function aRun(
  pool: Pool,
  reservation: Reservation,
  session?: string,
  checkout: Checkout = aCheckout(),
  compacted: (run: Run) => Promise<void> = () => Promise.resolve(),
): Promise<Run> {
  const slot = pool.slots.find((one) => one.name === reservation.slotName);
  if (!slot) {
    throw new Error(`the pool has no slot named "${reservation.slotName}"`);
  }
  pool.reserve(slot, reservation);
  const run = await pool.spawn(slot, checkout, checkout.worktree, compacted);
  if (session) {
    pool.opened(run, session);
  }
  pool.busy(run);
  return run;
}

export class FakePrompts implements Prompts {
  fragment(name: string, _vars: FragmentVars = {}): string {
    return `prompt:${name}`;
  }

  issue(name: string, state: string, vars: FragmentVars = {}): string {
    return `issue:${name}:${state}:${JSON.stringify(vars)}`;
  }

  reload(): Promise<string[]> {
    return yielded([]);
  }

  cachedFiles(): string[] {
    return [];
  }
}
