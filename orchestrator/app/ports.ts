import type { SlotRow, Slot } from "../domain/agents.ts";
import type { CheckResult, RunningCheck } from "../domain/checks.ts";
import type { Command } from "../domain/command.ts";
import type { TaskRow } from "../domain/graph.ts";
import type { WorktreeStatus } from "../domain/guard.ts";
import type { IssueName } from "../domain/issues.ts";
import type { Sample } from "../domain/rates.ts";
import type { ResultCall } from "../domain/results.ts";
import {
  type ClaimState,
  type Role,
  type TaskState,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
} from "../domain/state-machine.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";
import type { FragmentVars } from "../domain/fragment.ts";
import type { StreamState } from "../domain/protocol.ts";
import type { InboxRow } from "../policy/inbox.ts";
import type { Candidate } from "../policy/scheduler.ts";

export interface ClaimArgs {
  slotName: string;
  pid: number;
  branch?: string;
  worktree?: string;
  session?: string;
}

export interface CreatedTask {
  id: TaskId;
  filePath: string;
}

export interface Tasks {
  list(): { tasks: Map<TaskId, TaskMeta>; problems: Map<string, string> };
  read(id: TaskId): TaskMeta | null;
  body(id: TaskId): string;
  create(title: string): CreatedTask;
  writeBody(id: TaskId, body: string): string;
  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): TransitionResult;
  claim(id: TaskId, args: ClaimArgs): void;
  releaseClaim(id: TaskId): void;
}

export interface Workspaces {
  create(branch: string, worktree: string, base: string): void;
  remove(worktree: string): void;
  exists(worktree: string): boolean;
  branchExists(branch: string): boolean;
  deleteBranch(branch: string): void;
  head(worktree: string): string;
  resetTo(worktree: string, commit: string): void;
  status(worktree: string, base: string): WorktreeStatus;
  harvest(worktree: string, branch: string): void;
  syncBase(worktree: string, base: string): void;
  rebase(worktree: string, base: string): { code: number; stderr: string };
  abortRebase(worktree: string): void;
  fastForward(branch: string): { code: number; stderr: string };
  isAncestor(ref: string, of: string): boolean;
}

export interface AgentSpec {
  taskId: TaskId;
  state: ClaimState;
  role: Role;
  slot: Slot;
  cwd: string;
}

export interface AgentProcess {
  readonly pid: number;
  readonly alive: boolean;
  readonly stream: { readonly state: StreamState; settled(): Promise<void> };
  newSession(): Promise<string>;
  switchSession(path: string): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): void;
  abortBash(): void;
  stats(): Promise<{ tokens: number | null; contextPercent: number | null }>;
  lastAssistantText(): Promise<string | null>;
  close(): void;
  kill(): void;
}

export interface Agents {
  slots(): Slot[];
  hasSession(path: string): boolean;
  spawn(
    spec: AgentSpec,
    onUsage: (sample: Sample) => void,
    onCompaction: () => void,
    onResult: (call: ResultCall) => void,
  ): AgentProcess;
}

export interface Checks {
  readonly view: RunningCheck[];
  isRunning(taskId: TaskId): boolean;
  run(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult>;
}

export interface Prompts {
  fragment(name: string, vars?: FragmentVars): string;
  issue(name: IssueName, state: ClaimState, vars?: FragmentVars): string;
  reload(): string[];
  cachedFiles(): string[];
}

export interface Messages {
  queue(taskId: TaskId, state: ClaimState, message: string): void;
  drain(taskId: TaskId, state: ClaimState): string;
  queued(taskId: TaskId, state: ClaimState): boolean;
}

export interface Reviews {
  findings(taskId: TaskId): string[];
  setFindings(taskId: TaskId, findings: string[]): void;
  clearFindings(taskId: TaskId): void;
  failures(taskId: TaskId): number;
  setFailures(taskId: TaskId, failures: number): void;
  clearFailures(taskId: TaskId): void;
}

export interface Assignments {
  read(taskId: TaskId): string;
  write(taskId: TaskId, contents: string): void;
  exists(taskId: TaskId): boolean;
  rotate(taskId: TaskId): void;
}

export interface TransitionEntry {
  seq: number;
  at: string;
  task_id: TaskId;
  transition: string;
  from: TaskState;
  to: TaskState;
  by: string;
}

export interface Transitions {
  readonly cursor: number;
  read(): TransitionEntry[];
  append(entry: Omit<TransitionEntry, "seq" | "at">): void;
}

export interface Views {
  seq: number;
  agentsFile: string;
  slots: SlotRow[];
  checks: RunningCheck[];
  tasks: TaskRow[];
  inbox: InboxRow[];
  queue: Candidate[];
  scheduling: boolean;
}

export const VIEW_NAMES = [
  "slots",
  "checks",
  "tasks",
  "inbox",
  "queue",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export interface Publisher {
  publish(views: Views): void;
  read(name: ViewName): string;
  lastSlots(): SlotRow[] | null;
  log(line: string): void;
}

export interface CommandChannel {
  take(): Command | null;
  watch(apply: (command: Command) => void): { close(): void };
}

export interface Paths {
  readonly root: string;
  readonly serverLog: string;
  readonly transitionLog: string;
  readonly slotsView: string;
  readonly checksView: string;
  readonly tasksView: string;
  readonly inboxView: string;
  readonly queueView: string;
  readonly consoleCommand: string;
  taskRoot(id: TaskId): string;
  worktree(id: TaskId): string;
  assignment(id: TaskId): string;
  history(id: TaskId): string;
  findings(id: TaskId): string;
  reviewFailures(id: TaskId): string;
  sessionDir(id: TaskId, role: Role): string;
  rpcLog(id: TaskId): string;
  checkLog(id: TaskId, index: number): string;
  messagesDir(id: TaskId): string;
  prepare(id: TaskId): void;
  discard(id: TaskId): void;
  log(line: string): void;
  takeLock(): void;
  clearLock(): void;
}
