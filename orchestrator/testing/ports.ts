import type {
  AgentProcess,
  Agents,
  Assignments,
  CreatedTask,
  Messages,
  Reviews,
  Transitions,
  TransitionEntry,
  Paths,
  Prompts,
  Publisher,
  Tasks,
  ViewName,
  Views,
  Workspaces,
} from "../app/ports.ts";
import type { Activity } from "../domain/activity.ts";
import type { SlotRow, Slot } from "../domain/agents.ts";
import { type TaskId, type TaskMeta, formatId } from "../domain/task.ts";
import type {
  TransitionArgs,
  TransitionName,
  TransitionResult,
} from "../domain/state-machine.ts";
import type { TemplateVars } from "../domain/template.ts";

export function aSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    name: "pi-fake-fake-1",
    agent: "pi-fake-fake",
    type: "pi",
    provider: "fake",
    model: "fake",
    index: 1,
    enabled: true,
    write: [],
    roles: ["worker", "reviewer", "planner", "designer"],
    ...overrides,
  };
}

export function aTask(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: "000042",
    title: "a task",
    state: "WORK",
    state_entered: "2026-07-29T00:00:00Z",
    depends_on: [],
    claimed_by: null,
    claimed_pid: null,
    held_reason: null,
    workspace: null,
    checks: [],
    ...overrides,
  };
}

export function aSession(
  activity: Activity = { kind: "none" },
  alive = true,
  prompts: string[] = [],
): AgentProcess {
  let settles = 0;
  return {
    pid: 4242,
    alive,
    stream: {
      state: {
        activity,
        stopReason: null,
        errorMessage: null,
        settled: false,
        retrying: false,
        failure: null,
        looping: null,
      },
      settled: () => {
        if (settles > 0) {
          return new Promise<void>(() => {});
        }
        settles += 1;
        return Promise.resolve();
      },
    },
    newSession: () => Promise.resolve("a-session"),
    switchSession: () => Promise.resolve(),
    prompt: (message: string) => {
      prompts.push(message);
      return Promise.resolve();
    },
    steer: (message: string) => {
      prompts.push(message);
      return Promise.resolve();
    },
    abort: () => {},
    abortBash: () => {},
    stats: () => Promise.resolve({ tokens: null, contextPercent: null }),
    lastAssistantText: () => Promise.resolve(null),
    close: () => {},
    kill: () => {},
  };
}

export class FakePublisher implements Publisher {
  readonly lines: string[] = [];
  rows: SlotRow[] | null = null;
  published: Views | null = null;

  publish(views: Views): void {
    this.published = views;
  }

  read(name: ViewName): string {
    const views = this.published;
    if (views === null) {
      return "{}";
    }
    return `${JSON.stringify({ at: new Date().toISOString(), seq: views.seq, [name]: views[name] }, null, 2)}\n`;
  }

  lastSlots(): SlotRow[] | null {
    return this.rows;
  }

  log(line: string): void {
    this.lines.push(line);
  }
}

export class FakeTasks implements Tasks {
  readonly released: TaskId[] = [];
  readonly bodies = new Map<TaskId, string>();

  constructor(private readonly tasks: Map<TaskId, TaskMeta>) {}

  list(): { tasks: Map<TaskId, TaskMeta>; problems: Map<string, string> } {
    return { tasks: this.tasks, problems: new Map() };
  }

  read(id: TaskId): TaskMeta | null {
    return this.tasks.get(id) ?? null;
  }

  body(id: TaskId): string {
    return this.bodies.get(id) ?? "the goal\n";
  }

  create(title: string): CreatedTask {
    const id = formatId(this.tasks.size + 1);
    this.tasks.set(id, { ...aTask(), id, title, state: "NEW" });
    return { id, filePath: `/tasks/${id}.md` };
  }

  writeBody(id: TaskId, body: string): string {
    this.bodies.set(id, body);
    return `/tasks/${id}.md`;
  }

  readonly applied: { id: TaskId; name: string; args: TransitionArgs }[] = [];

  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): TransitionResult {
    this.applied.push({ id, name, args });
    return {
      taskId: id,
      from: "WORK",
      to: "HELD_WORK",
      unblocked: [],
      dependentsUpdated: [],
    };
  }

  claim(): void {}

  releaseClaim(id: TaskId): void {
    this.released.push(id);
    const task = this.tasks.get(id);
    if (task !== undefined) {
      task.claimed_by = null;
      task.claimed_pid = null;
    }
  }
}

export class FakeWorkspaces implements Workspaces {
  readonly harvested: string[] = [];
  readonly created: string[] = [];
  present = new Set<string>();
  branches = new Set<string>();

  create(branch: string, worktree: string): void {
    this.created.push(worktree);
    this.present.add(worktree);
  }

  remove(worktree: string): void {
    this.present.delete(worktree);
  }

  exists(worktree: string): boolean {
    return this.present.has(worktree);
  }

  branchExists(branch: string): boolean {
    return this.branches.has(branch);
  }

  deleteBranch(branch: string): void {
    this.branches.delete(branch);
  }

  head(): string {
    return "0000000";
  }

  resetTo(): void {}

  status(): { dirty: string[]; commits: number } {
    return { dirty: [], commits: 0 };
  }

  harvest(worktree: string): void {
    this.harvested.push(worktree);
  }

  syncBase(): void {}

  rebase(): { code: number; stderr: string } {
    return { code: 0, stderr: "" };
  }

  abortRebase(): void {}

  fastForward(): { code: number; stderr: string } {
    return { code: 0, stderr: "" };
  }

  isAncestor(): boolean {
    return false;
  }
}

export class FakeTransitions implements Transitions {
  readonly entries: TransitionEntry[] = [];

  get cursor(): number {
    return this.entries.length;
  }

  read(): TransitionEntry[] {
    return this.entries;
  }

  append(entry: Omit<TransitionEntry, "seq" | "at">): void {
    this.entries.push({
      ...entry,
      seq: this.entries.length + 1,
      at: "2026-07-29T00:00:00Z",
    });
  }
}

export class FakeTaskFiles implements Messages, Reviews {
  private readonly messages = new Map<string, string>();
  private readonly found = new Map<TaskId, string[]>();
  private readonly rejections = new Map<TaskId, number>();

  queue(taskId: TaskId, state: string, message: string): void {
    this.messages.set(`${taskId}/${state}`, message);
  }

  drain(taskId: TaskId, state: string): string {
    const key = `${taskId}/${state}`;
    const message = this.messages.get(key) ?? "";
    this.messages.delete(key);
    return message;
  }

  queued(taskId: TaskId, state: string): boolean {
    return this.messages.has(`${taskId}/${state}`);
  }

  findings(taskId: TaskId): string[] {
    return this.found.get(taskId) ?? [];
  }

  setFindings(taskId: TaskId, findings: string[]): void {
    this.found.set(taskId, findings);
  }

  clearFindings(taskId: TaskId): void {
    this.found.delete(taskId);
  }

  failures(taskId: TaskId): number {
    return this.rejections.get(taskId) ?? 0;
  }

  setFailures(taskId: TaskId, failures: number): void {
    this.rejections.set(taskId, failures);
  }

  clearFailures(taskId: TaskId): void {
    this.rejections.delete(taskId);
  }
}

export class FakeAssignments implements Assignments {
  private readonly contents = new Map<TaskId, string>();
  readonly rotated: TaskId[] = [];

  read(taskId: TaskId): string {
    return this.contents.get(taskId) ?? "";
  }

  write(taskId: TaskId, contents: string): void {
    this.contents.set(taskId, contents);
  }

  exists(taskId: TaskId): boolean {
    return this.contents.has(taskId);
  }

  rotate(taskId: TaskId): void {
    this.rotated.push(taskId);
  }
}

export class FakePaths {
  readonly prepared: TaskId[] = [];
  readonly discarded: TaskId[] = [];

  rpcLog(id: TaskId): string {
    return `/rpc/${id}.jsonl`;
  }

  worktree(id: TaskId): string {
    return `/runtime/${id}/worktree`;
  }

  prepare(id: TaskId): void {
    this.prepared.push(id);
  }

  discard(id: TaskId): void {
    this.discarded.push(id);
  }
}

export function fakePaths(): Paths {
  return new FakePaths() as unknown as Paths;
}

export function fakeAgents(
  slots: Slot[],
  session: () => AgentProcess = () => aSession(),
): Agents {
  return {
    slots: () => slots,
    hasSession: () => true,
    spawn: () => session(),
  } as unknown as Agents;
}

export class FakePrompts implements Prompts {
  fragment(name: string): string {
    return `prompt:${name}`;
  }

  issue(name: string, state: string, vars: TemplateVars = {}): string {
    return `issue:${name}:${state}:${JSON.stringify(vars)}`;
  }

  reload(): string[] {
    return [];
  }

  cachedFiles(): string[] {
    return [];
  }
}
