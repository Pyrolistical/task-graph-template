import fs from "node:fs";
import path from "node:path";
import {
  normalizeBody,
  type TaskId,
  type TaskMeta,
  type Workspace,
  detectCycles,
  findTaskFile,
  isProcessAlive,
  readTaskFile,
} from "./task.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  applyTransition,
} from "./transition.ts";
import { type ClaimArgs, clearClaim, takeClaim } from "./claim.ts";
import {
  type AgentRow,
  type AgentSlot,
  type AgentState,
  agentWrite,
  checkWrite,
  idleRow,
  loadAgents,
} from "./agents.ts";
import { restored, rotate } from "./assignment.ts";
import { append, drain, queueFile } from "./queue.ts";
import { clearFindings, readFindings, writeFindings } from "./findings.ts";
import {
  type AgentResult,
  type PlanReviewResults,
  type ResultCall,
  type WorkReviewResults,
  resultFromCall,
} from "./results.ts";
import { CheckRunner, type CheckResult } from "./checks.ts";
import * as git from "./git.ts";
import {
  type TaskRow,
  RECENT_TASKS,
  blockingCounts,
  readActiveTasks,
  readTaskBody,
  taskRow,
  taskRows,
} from "./graph.ts";
import { inbox } from "./inbox.ts";
import { type IssueName, ISSUES, Prompts } from "./prompts.ts";
import { LOOP_LIMIT, PiProcess, type StopReason } from "./rpc.ts";
import { Rates } from "./rates.ts";
import { type Activity, abortable } from "./activity.ts";
import { type Candidate, candidates, plan } from "./scheduler.ts";
import { type Command, takeCommand, watchCommands } from "./command.ts";
import {
  AGENT_OOM_SCORE_ADJUST,
  CHECK_OOM_SCORE_ADJUST,
  LIMIT_COMMAND,
  SANDBOX_COMMAND,
  hasLimits,
  sandbox,
} from "./sandbox.ts";
import {
  Runtime,
  branchName,
  defaultTasksDir,
  snapshot,
  writeAtomic,
} from "./runtime.ts";
import {
  type ClaimState,
  type Role,
  type TaskState,
  HELD_STATES,
  STATE_TOOLS,
} from "./states.ts";
import type { TemplateVars } from "./template.ts";
import { TransitionLog } from "./transition-log.ts";

const ABORTABLE_STATES: TaskState[] = ["MANAGER_REVIEW", ...HELD_STATES];

export const BACKOFF_START_MS = 1000;
export const BACKOFF_CAP_MS = 64000;
export const MODEL_LOADING_MS = 5000;

interface Snapshot {
  tasks: Map<TaskId, TaskMeta>;
  blocking: Map<TaskId, number>;
}

type Guard = "none" | "untouched" | "committed";

interface WorktreeIssue {
  name: IssueName;
  detail: string;
  vars: TemplateVars;
}

interface Authoring {
  missing: IssueName;
  section: string;
  guard: Guard;
  body: boolean;
}

interface Review {
  back: ClaimState;
  findings: string | null;
  guard: Guard;
  body: boolean;
}

const AUTHORING: Record<string, Authoring> = {
  DESIGN: {
    missing: "missing-design",
    section: "## Design",
    guard: "untouched",
    body: false,
  },
  PLAN: {
    missing: "missing-todos",
    section: "## Todos",
    guard: "untouched",
    body: false,
  },
  WORK: {
    missing: "missing-notes",
    section: "## Implementation Notes",
    guard: "committed",
    body: true,
  },
};

const REVIEWS: Record<string, Review> = {
  DESIGN_REVIEW: {
    back: "DESIGN",
    findings: null,
    guard: "untouched",
    body: true,
  },
  PLAN_REVIEW: {
    back: "PLAN",
    findings: null,
    guard: "untouched",
    body: true,
  },
  WORK_REVIEW: {
    back: "WORK",
    findings: "work-findings",
    guard: "none",
    body: false,
  },
};

export interface ServerOptions {
  repo: string;
  agentsPath?: string;
  tasksDir?: string;
  orchestratorDir?: string;
  overridesDir?: string;
  serverRoot?: string;
  piCommand?: string;
  sandboxCommand?: string;
  base?: string;
}

interface Worker {
  slot: AgentSlot;
  state: AgentState;
  task_id: TaskId | null;
  stage: ClaimState | null;
  role: Role | null;
  branch: string | null;
  worktree: string | null;
  head: string | null;
  process: PiProcess | null;
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
  retry_at: string | null;
  attempt: number;
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
    retry_at: null,
    attempt: 0,
  };
}

export class Server {
  readonly runtime: Runtime;
  readonly repo: string;
  readonly tasksDir: string;
  readonly orchestratorDir: string;
  readonly overridesDir: string;
  readonly agentsPath: string;
  readonly transitions: TransitionLog;
  readonly checks = new CheckRunner();
  readonly prompts: Prompts;
  readonly base: string;
  readonly rates = new Rates();

  private readonly piCommand: string;
  private readonly sandboxCommand: string;
  private readonly slots: AgentSlot[];
  private readonly workers = new Map<string, Worker>();
  private readonly recent: TaskId[] = [];
  private readonly pendingChecks = new Map<TaskId, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly closed = new Map<TaskId, TaskRow>();
  private readonly disabled = new Set<string>();
  private problems = new Map<string, string>();
  private cycling = new Set<TaskId>();
  private watcher: fs.FSWatcher | null = null;
  private scheduling = false;
  private dispatching = false;
  private detached = false;

  private constructor(options: ServerOptions) {
    this.repo = path.resolve(options.repo);
    this.tasksDir = options.tasksDir ?? defaultTasksDir(this.repo);
    if (options.tasksDir === undefined) {
      this.seedTasksDir();
    }
    this.orchestratorDir = options.orchestratorDir ?? import.meta.dir;
    this.overridesDir = options.overridesDir ?? this.tasksDir;
    this.piCommand = options.piCommand ?? "pi";
    this.sandboxCommand = options.sandboxCommand ?? SANDBOX_COMMAND;
    this.runtime = new Runtime(this.repo, options.serverRoot);
    this.transitions = new TransitionLog(this.runtime.transitionLog);
    this.prompts = new Prompts(this.orchestratorDir, this.overridesDir);
    this.base = options.base ?? git.defaultBranch(this.repo);
    this.agentsPath =
      options.agentsPath ?? path.join(this.tasksDir, "agents.json");
    this.slots = loadAgents(this.agentsPath);

    for (const slot of this.slots) {
      this.workers.set(slot.name, freshWorker(slot));
      if (!slot.enabled) {
        this.disabled.add(slot.agent);
      }
    }

    if (!hasLimits()) {
      console.warn(
        `no cgroup limits available: ${LIMIT_COMMAND} --user --scope failed, sandboxes run without MemoryMax/TasksMax`,
      );
    }
  }

  private seedTasksDir(): void {
    fs.cpSync(path.join(import.meta.dir, "..", "tasks"), this.tasksDir, {
      recursive: true,
      force: false,
    });
  }

  static async start(options: ServerOptions): Promise<Server> {
    const repo = path.resolve(options.repo);
    if (!git.isRepo(repo)) {
      throw new Error(`${repo} is not a git repository`);
    }

    const server = new Server(options);

    server.runtime.log(`starting against ${repo} (base ${server.base})`);
    for (const filePath of server.prompts.cachedFiles()) {
      server.runtime.log(`cached ${filePath}`);
    }
    server.recoverWorkspaces();
    server.reattach();
    server.listen();

    const tasks = [...server.tasks().values()].sort((a, b) =>
      (b.state_entered ?? "").localeCompare(a.state_entered ?? ""),
    );
    for (const task of tasks.slice(0, RECENT_TASKS)) {
      server.recent.push(task.id);
    }

    await server.writeViews();
    return server;
  }

  private reattach(): void {
    if (!fs.existsSync(this.runtime.agentsView)) {
      return;
    }

    let rows: AgentRow[];
    try {
      rows = (
        JSON.parse(fs.readFileSync(this.runtime.agentsView, "utf-8")) as {
          agents: AgentRow[];
        }
      ).agents;
    } catch {
      return;
    }

    for (const row of rows) {
      const worker = this.workers.get(row.name);
      if (
        worker === undefined ||
        row.pid === null ||
        row.task_id === null ||
        !isProcessAlive(row.pid)
      ) {
        continue;
      }

      worker.state = "BUSY";
      worker.task_id = row.task_id;
      worker.role = row.role;
      worker.started_at = row.started_at;
      worker.detachedPid = row.pid;
      worker.session = row.session;

      this.runtime.log(
        `${row.name} is still running ${row.task_id} as pid ${row.pid}; leaving it alone`,
      );
    }
  }

  private recoverWorkspaces(): void {
    for (const [id, task] of this.tasks()) {
      const workspace = task.workspace;
      if (workspace === null || fs.existsSync(workspace.worktree)) {
        continue;
      }
      if (!git.branchExists(this.repo, workspace.branch)) {
        this.runtime.log(
          `task ${id} lost both its worktree and branch ${workspace.branch}`,
        );
        continue;
      }
      this.runtime.prepare(id);
      git.addWorkspace(
        this.repo,
        workspace.branch,
        workspace.worktree,
        this.base,
      );
      this.runtime.log(
        `recloned the workspace for ${id} from ${workspace.branch}`,
      );
    }
  }

  tasks(): Map<TaskId, TaskMeta> {
    const { tasks, problems } = readActiveTasks(this.tasksDir);

    for (const [filePath, message] of problems) {
      if (this.problems.get(filePath) !== message) {
        this.runtime.log(`ignoring ${filePath}: ${message}`);
      }
    }
    for (const filePath of this.problems.keys()) {
      if (!problems.has(filePath)) {
        this.runtime.log(`${filePath} parses again`);
      }
    }
    this.problems = problems;
    this.reportCycles(tasks);

    return tasks;
  }

  private reportCycles(tasks: Map<TaskId, TaskMeta>): void {
    const cycling = new Set(detectCycles(tasks));

    for (const id of cycling) {
      if (!this.cycling.has(id)) {
        this.runtime.log(
          `task ${id} depends on itself through ${tasks.get(id)?.depends_on.join(", ")}; it can never unblock`,
        );
      }
    }
    this.cycling = cycling;
  }

  private snapshot(): Snapshot {
    const tasks = this.tasks();
    return { tasks, blocking: blockingCounts(tasks) };
  }

  reloadPrompts(): string[] {
    const paths = this.prompts.reload();
    for (const filePath of paths) {
      this.runtime.log(`cached ${filePath}`);
    }
    return paths;
  }

  get schedulerEnabled(): boolean {
    return this.scheduling;
  }

  setSchedulerEnabled(enabled: boolean): void {
    this.scheduling = enabled;
    this.runtime.log(`scheduler ${enabled ? "enabled" : "disabled"}`);
  }

  agentKeys(): string[] {
    return [
      ...new Set([...this.workers.values()].map((worker) => worker.slot.agent)),
    ];
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

    const rows = this.agentRows().filter((row) => row.agent === agent);
    const draining = rows.filter((row) => row.state !== "DISABLED").length;

    this.runtime.log(
      enabled
        ? `agent ${agent} enabled: ${rows.length} slots dispatchable`
        : `agent ${agent} disabled: ${draining} of ${rows.length} slots still running`,
    );

    return rows;
  }

  abortAgent(name: string): AgentRow {
    const worker = this.workers.get(name);
    if (worker === undefined) {
      throw new Error(
        `no agent slot named "${name}"; the pool has ${[...this.workers.keys()].join(", ")}`,
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
    this.runtime.log(`${name} aborted bash: ${activity.target}`);

    return this.agentRows().find((row) => row.name === name)!;
  }

  claim(taskId: TaskId, args: ClaimArgs): void {
    takeClaim(this.tasksDir, taskId, args);
    this.remember(taskId, this.tasks());
  }

  transition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): TransitionResult {
    const tasks = this.tasks();
    const before = tasks.get(taskId);
    const result = applyTransition(this.tasksDir, taskId, name, args);
    const to = (result.to ?? before?.state ?? "NEW") as TaskState;

    if (to === "CLOSED" && before !== undefined) {
      this.closed.set(taskId, {
        ...taskRow(before, blockingCounts(tasks).get(taskId) ?? 0),
        state: "CLOSED",
        state_entered: new Date().toISOString(),
        claimed_by: null,
        worktree: null,
      });
      this.teardown(before);
      this.runtime.discard(taskId);
    }

    this.transitions.append({
      task_id: taskId,
      transition: name,
      from: result.from,
      to,
      by,
    });
    this.remember(taskId, tasks);
    return result;
  }

  private teardown(task: TaskMeta): void {
    const workspace = task.workspace;
    if (workspace === null) {
      return;
    }

    git.removeWorkspace(workspace.worktree);
    if (git.branchExists(this.repo, workspace.branch)) {
      git.deleteBranch(this.repo, workspace.branch);
    }
  }

  private remember(taskId: TaskId, tasks: Map<TaskId, TaskMeta>): void {
    const at = this.recent.indexOf(taskId);
    if (at !== -1) {
      this.recent.splice(at, 1);
    }
    this.recent.unshift(taskId);

    while (this.recent.length > RECENT_TASKS) {
      const dropped = this.recent.pop()!;
      if (!tasks.has(dropped)) {
        this.closed.delete(dropped);
        this.runtime.discard(dropped);
      }
    }
  }

  private track(worker: Worker, work: Promise<void>): void {
    const taskId = worker.task_id;
    const tracked = work
      .catch((err: Error) => {
        this.runtime.log(
          `${worker.slot.name} on ${taskId} failed: ${err.message}`,
        );
        this.stop(worker);
      })
      .finally(() => {
        this.inflight.delete(tracked);
      });
    this.inflight.add(tracked);
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0 || this.pendingChecks.size > 0) {
      await Promise.all([...this.inflight, ...this.pendingChecks.values()]);
    }
  }

  private worker(name: string): Worker {
    const worker = this.workers.get(name);
    if (worker === undefined) {
      throw new Error(`no agent slot named "${name}"`);
    }
    return worker;
  }

  private resumable(tasks: Map<TaskId, TaskMeta>): Set<TaskId> {
    const ids = new Set<TaskId>();
    for (const [id, task] of tasks) {
      if (
        task.state === "WORK" &&
        task.claimed_by === null &&
        task.workspace?.session != null &&
        fs.existsSync(task.workspace.session) &&
        fs.existsSync(queueFile(this.runtime.taskDir(id), "WORK"))
      ) {
        ids.add(id);
      }
    }
    return ids;
  }

  async tick(): Promise<void> {
    await Promise.all([...this.pendingChecks.values()]);
    const graph = this.snapshot();
    this.reap(graph.tasks);
    this.startChecks(graph.tasks);
    if (this.scheduling && !this.dispatching) {
      this.dispatching = true;
      try {
        await this.dispatch(graph);
      } finally {
        this.dispatching = false;
      }
    }
    await this.writeViews();
  }

  private listen(): void {
    const stale = takeCommand(this.runtime);
    if (stale !== null) {
      this.applyCommand(stale);
    }
    this.watcher = watchCommands(this.runtime, (command) => {
      this.applyCommand(command);
    });
  }

  private applyCommand(command: Command): void {
    this.runtime.log(`console: ${JSON.stringify(command)}`);
    try {
      if (command.command === "scheduler") {
        this.setSchedulerEnabled(command.enabled);
      } else if (command.command === "agent_abort") {
        this.abortAgent(command["agent-name-slot"]);
      } else {
        this.setAgentEnabled(command.agent, command.enabled);
      }
    } catch (err) {
      this.runtime.log(`console command refused: ${(err as Error).message}`);
      return;
    }
    void this.writeViews().catch((err: Error) => {
      this.runtime.log(`writing the views failed: ${err.message}`);
    });
  }

  private reap(tasks: Map<TaskId, TaskMeta>): void {
    const held = new Set(
      [...this.workers.values()]
        .filter((worker) => worker.process?.alive === true)
        .map((worker) => worker.task_id),
    );

    for (const [id, task] of tasks) {
      if (
        task.claimed_pid === null ||
        held.has(id) ||
        isProcessAlive(task.claimed_pid)
      ) {
        continue;
      }

      this.runtime.log(
        `reaping ${id}: "${task.claimed_by}" (pid ${task.claimed_pid}) is gone`,
      );
      this.harvestWorkspace(task.workspace);
      clearClaim(this.tasksDir, id);
      this.remember(id, this.tasks());

      for (const worker of this.workers.values()) {
        if (worker.task_id === id && worker.process?.alive !== true) {
          worker.process?.close();
          this.release(worker.slot.name);
        }
      }
    }
  }

  private async dispatch({ tasks, blocking }: Snapshot): Promise<void> {
    const free = [...this.workers.values()]
      .filter(
        (worker) =>
          worker.state === "IDLE" && !this.disabled.has(worker.slot.agent),
      )
      .map((worker) => worker.slot);

    for (const { candidate, slot } of plan(
      tasks,
      this.resumable(tasks),
      blocking,
      free,
      this.rates.rateOf,
    )) {
      const task = tasks.get(candidate.task_id);
      if (task === undefined) {
        continue;
      }
      try {
        await this.assign(task, candidate, slot);
      } catch (err) {
        this.runtime.log(
          `dispatch of ${task.id} to ${slot.name} failed: ${(err as Error).message}`,
        );
        this.finish(this.worker(slot.name));
      }
    }
  }

  private requireStill(task: TaskMeta, slot: AgentSlot): void {
    const current = this.tasks().get(task.id);
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

  private launch(taskId: TaskId, slot: AgentSlot, cwd: string): string[] {
    return sandbox(
      {
        cwd,
        writable: [this.runtime.taskDir(taskId)],
        readable: [this.repo, this.orchestratorDir],
        overlay: agentWrite(slot),
        oomScoreAdjust: AGENT_OOM_SCORE_ADJUST,
      },
      this.sandboxCommand,
    );
  }

  private spawn(
    taskId: TaskId,
    role: Role,
    state: ClaimState,
    slot: AgentSlot,
    cwd: string,
    worker: Worker,
  ) {
    return new PiProcess(
      {
        provider: slot.provider,
        model: slot.model,
        sessionDir: this.runtime.sessionDir(taskId, role),
        name: `${taskId} ${state}`,
        cwd,
        extension: path.join(
          this.orchestratorDir,
          `result-tools-${STATE_TOOLS[state]}.ts`,
        ),
        log: this.runtime.rpcLog(taskId),
      },
      this.piCommand,
      this.launch(taskId, slot, cwd),
      (sample) => {
        this.rates.record(slot.agent, sample);
      },
      () => {
        worker.compactions += 1;
        this.track(worker, this.compacted(worker));
      },
      (call) => {
        worker.results.push(call);
      },
    );
  }

  private async prompt(worker: Worker, message: string): Promise<void> {
    worker.results = [];
    await worker.process!.prompt(message);
  }

  private async assign(
    task: TaskMeta,
    candidate: Candidate,
    slot: AgentSlot,
  ): Promise<void> {
    const worker = this.worker(slot.name);
    worker.state = "SPAWNING";
    worker.task_id = task.id;
    worker.started_at = new Date().toISOString();
    worker.stage = candidate.stage;
    worker.role = candidate.role;
    worker.issues.clear();

    if (candidate.rank === "resume") {
      await this.resume(task, worker);
      return;
    }

    const role = worker.role;
    const stage = candidate.stage;
    this.runtime.prepare(task.id);
    const worktree = this.runtime.worktree(task.id);
    const branch = task.workspace?.branch ?? branchName(task.id);
    worker.worktree = worktree;
    worker.branch = branch;

    if (!fs.existsSync(worktree)) {
      git.addWorkspace(this.repo, branch, worktree, this.base);
    }
    worker.head = git.head(worktree);

    if (
      stage === "DESIGN_REVIEW" ||
      stage === "PLAN_REVIEW" ||
      stage === "WORK_REVIEW"
    ) {
      const assignmentPath = this.runtime.assignment(task.id);
      worker.dispatched = fs.existsSync(assignmentPath)
        ? fs.readFileSync(assignmentPath, "utf-8")
        : this.writeAssignment(task, null);
    } else {
      worker.dispatched = this.writeAssignment(task, AUTHORING[stage]!.section);
    }

    const process = this.spawn(task.id, role, stage, slot, worktree, worker);
    worker.process = process;

    const session = await process.newSession();
    worker.session = session;
    this.requireStill(task, slot);
    this.claim(task.id, {
      agentName: slot.name,
      pid: process.pid,
      branch,
      worktree,
      session,
    });

    worker.state = "BUSY";
    const queued = drain(this.runtime.taskDir(task.id), stage);
    const message = this.nudge(task.id, stage);
    await this.prompt(
      worker,
      queued === "" ? message : `${queued}\n\n${message}`,
    );
    this.track(worker, this.awaitSettle(worker));
  }

  private async promptQueued(
    worker: Worker,
    taskId: TaskId,
    state: ClaimState,
  ): Promise<void> {
    const queued = drain(this.runtime.taskDir(taskId), state);
    if (queued !== "") {
      await this.prompt(worker, queued);
    }
  }

  private async resume(task: TaskMeta, worker: Worker): Promise<void> {
    const slot = worker.slot;
    const workspace = task.workspace!;
    const role = worker.role!;
    const live = this.runtime.assignment(task.id);
    worker.worktree = workspace.worktree;
    worker.branch = workspace.branch;
    worker.head = git.head(workspace.worktree);

    const process = this.spawn(
      task.id,
      role,
      "WORK",
      slot,
      workspace.worktree,
      worker,
    );
    worker.process = process;

    await process.switchSession(workspace.session!);
    worker.session = workspace.session;
    this.requireStill(task, slot);
    this.claim(task.id, {
      agentName: slot.name,
      pid: process.pid,
      branch: workspace.branch,
      worktree: workspace.worktree,
      session: workspace.session!,
    });

    worker.dispatched = fs.readFileSync(live, "utf-8");
    worker.state = "BUSY";

    await this.promptQueued(worker, task.id, "WORK");
    this.track(worker, this.awaitSettle(worker));
  }

  private writeAssignment(task: TaskMeta, section: string | null): string {
    const live = this.runtime.assignment(task.id);
    rotate(live, this.runtime.history(task.id));

    const body = normalizeBody(readTaskBody(this.tasksDir, task.id));
    const dispatched = section === null ? body : `${body}\n${section}\n`;
    fs.writeFileSync(live, dispatched, "utf-8");
    return dispatched;
  }

  private async awaitSettle(worker: Worker): Promise<void> {
    const process = worker.process;
    if (process === null) {
      return;
    }

    await process.stream.settled();

    if (!process.alive) {
      this.runtime.log(
        `${worker.slot.name} on ${worker.task_id}: the process exited without settling: ${process.stream.state.failure}`,
      );
      this.finish(worker);
      return;
    }

    worker.state = "SETTLED";
    const stopReason = process.stream.state.stopReason;

    const closing = await process.lastAssistantText().catch(() => null);
    if (closing !== null) {
      this.runtime.log(
        `${worker.slot.name} on ${worker.task_id} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    if (stopReason === "error") {
      await this.backOff(worker);
      return;
    }

    worker.backoff = BACKOFF_START_MS;

    const looping = process.stream.state.looping;
    if (looping !== null) {
      await this.raise(worker, "looping", looping, {
        command: looping,
        limit: LOOP_LIMIT,
      });
      return;
    }

    if (stopReason === "aborted") {
      this.finish(worker);
      return;
    }

    await this.settle(worker, stopReason);
  }

  private async compacted(worker: Worker): Promise<void> {
    const process = worker.process;
    if (process === null || !process.alive) {
      return;
    }

    if (worker.results.length > 0) {
      this.runtime.log(
        `${worker.slot.name} on ${worker.task_id} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting =
      worker.role !== "worker" &&
      worker.worktree !== null &&
      worker.head !== null;

    if (resetting) {
      git.resetTo(worker.worktree!, worker.head!);
    }

    this.runtime.log(
      `${worker.slot.name} on ${worker.task_id} compacted: ${resetting ? "worktree reset, " : ""}steered back to the assignment`,
    );

    await process.steer(this.nudge(worker.task_id!, worker.stage!));
  }

  private async backOff(worker: Worker): Promise<void> {
    const message = worker.process?.stream.state.errorMessage ?? "";
    const loading = /503/.test(message) && /load/i.test(message);
    const delay = loading
      ? MODEL_LOADING_MS
      : Math.min(worker.backoff, BACKOFF_CAP_MS);

    worker.state = "WAITING";
    worker.retry_at = new Date(Date.now() + delay).toISOString();
    if (!loading) {
      worker.attempt++;
      worker.backoff = Math.min(worker.backoff * 2, BACKOFF_CAP_MS);
    }

    this.runtime.log(
      `${worker.slot.name} waiting ${delay}ms on ${loading ? "model loading" : "provider error"}: ${message}`,
    );

    await Bun.sleep(delay);
    if (worker.process === null || !worker.process.alive) {
      this.finish(worker);
      return;
    }

    worker.state = "BUSY";
    worker.retry_at = null;
    await this.prompt(worker, this.nudge(worker.task_id!, worker.stage!));
    this.track(worker, this.awaitSettle(worker));
  }

  private async settle(
    worker: Worker,
    stopReason: StopReason | null,
  ): Promise<void> {
    const state = worker.stage!;
    const calls = worker.results;

    if (stopReason === "length" || calls.length === 0) {
      await this.raise(worker, "missing-result", "");
      return;
    }

    const result: AgentResult = resultFromCall(state, calls[calls.length - 1]!);

    if (result.type === "blocked") {
      await this.raise(worker, "blocked", result.message);
      return;
    }

    const review = REVIEWS[state];
    if (review !== undefined) {
      await this.settleReview(
        worker,
        review,
        result as Extract<WorkReviewResults, { type: "submit" }>,
      );
      return;
    }

    await this.settleAuthoring(worker, AUTHORING[state]!);
  }

  private diffAssignment(
    dispatched: string,
    live: string,
  ): "ok" | "unchanged" | "modified" {
    if (live.trimEnd() === dispatched.trimEnd()) {
      return "unchanged";
    }
    if (live.startsWith(dispatched)) {
      return "ok";
    }
    return "modified";
  }

  private restoreAssignment(
    taskId: TaskId,
    dispatched: string,
    live: string,
    section: string | null,
  ): void {
    fs.writeFileSync(
      this.runtime.assignment(taskId),
      restored(dispatched, live, section),
      "utf-8",
    );
  }

  private liveAssignment(taskId: TaskId): string {
    return fs.readFileSync(this.runtime.assignment(taskId), "utf-8");
  }

  private async settleAuthoring(
    worker: Worker,
    spec: Authoring,
  ): Promise<void> {
    const taskId = worker.task_id!;
    const live = this.liveAssignment(taskId);

    const diff = this.diffAssignment(worker.dispatched!, live);
    if (diff === "unchanged") {
      await this.raise(worker, spec.missing, "");
      return;
    }
    if (diff === "modified") {
      this.restoreAssignment(taskId, worker.dispatched!, live, spec.section);
      await this.raise(worker, "modified-assignment", "");
      return;
    }

    if (await this.guarded(worker, spec.guard)) {
      return;
    }

    worker.process!.close();
    clearFindings(this.runtime.findings(taskId));
    this.transition(
      taskId,
      "submit",
      spec.body ? { body: live } : {},
      worker.slot.name,
    );
    this.finish(worker);
  }

  private async settleReview(
    worker: Worker,
    spec: Review,
    result: Extract<WorkReviewResults, { type: "submit" }>,
  ): Promise<void> {
    const taskId = worker.task_id!;
    const live = this.liveAssignment(taskId);

    if (this.diffAssignment(worker.dispatched!, live) !== "unchanged") {
      this.restoreAssignment(taskId, worker.dispatched!, live, null);
      await this.raise(worker, "modified-assignment", "");
      return;
    }

    if (await this.guarded(worker, spec.guard)) {
      return;
    }

    const findings = result.findings;

    worker.process!.close();

    if (findings.length === 0) {
      this.transition(
        taskId,
        "submit",
        spec.body ? { body: live } : {},
        worker.slot.name,
      );
    } else {
      this.sendBack(taskId, spec.back, spec.findings, findings);
    }
    this.finish(worker);
  }

  private sendBack(
    taskId: TaskId,
    back: ClaimState,
    fragment: string | null,
    findings: string[],
  ): void {
    if (fragment === null) {
      writeFindings(this.runtime.findings(taskId), findings);
    } else {
      append(
        this.runtime.taskDir(taskId),
        back,
        this.prompts.fragment(fragment, {
          findings: findings.map((finding) => ({ finding })),
        }),
      );
    }
    this.transition(taskId, "feedback", { findings }, "server");
  }

  private nudge(taskId: TaskId, state: ClaimState): string {
    const findings = readFindings(this.runtime.findings(taskId));
    if (findings.length === 0) {
      return this.prompts.fragment(state);
    }
    return this.prompts.fragment(`${state}-with-findings`, {
      findings: findings.map((finding) => ({ finding })),
    });
  }

  private async guarded(worker: Worker, guard: Guard): Promise<boolean> {
    if (guard === "none") {
      return false;
    }

    const worktree = worker.worktree!;
    const dirty = git.uncommitted(worktree);
    const commits = git.commitCount(worktree, this.base);
    const issue =
      guard === "untouched"
        ? this.untouched(dirty, commits)
        : this.committed(dirty, commits);

    if (issue === null) {
      return false;
    }

    await this.raise(worker, issue.name, issue.detail, issue.vars);
    return true;
  }

  private committed(dirty: string[], commits: number): WorktreeIssue | null {
    if (dirty.length === 0 && commits > 0) {
      return null;
    }

    return {
      name: "uncommitted",
      detail: this.detailOf([
        commits === 0 ? "nothing is committed on the branch" : null,
        dirty.length === 0 ? null : `${dirty.length} uncommitted file(s)`,
      ]),
      vars: {
        empty: commits === 0 ? [{}] : [],
        dirty: dirty.length === 0 ? [] : [{ status: git.statusOf(dirty) }],
      },
    };
  }

  private untouched(dirty: string[], commits: number): WorktreeIssue | null {
    if (dirty.length === 0 && commits === 0) {
      return null;
    }

    return {
      name: "modified-worktree",
      detail: this.detailOf([
        commits === 0 ? null : `${commits} commit(s) on the branch`,
        dirty.length === 0 ? null : `${dirty.length} uncommitted file(s)`,
      ]),
      vars: {
        commits: commits === 0 ? [] : [{}],
        dirty: dirty.length === 0 ? [] : [{ status: git.statusOf(dirty) }],
        base: this.base,
      },
    };
  }

  private detailOf(parts: (string | null)[]): string {
    return parts.filter((part) => part !== null).join("; ");
  }

  private async raise(
    worker: Worker,
    name: IssueName,
    detail: string,
    vars: TemplateVars = {},
  ): Promise<void> {
    const taskId = worker.task_id!;
    const issue = ISSUES[name];
    const used = worker.issues.get(name) ?? 0;

    this.runtime.log(
      `${worker.slot.name} on ${taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      worker.process?.close();
      this.transition(
        taskId,
        "hold",
        { reason: issue.held(detail) },
        worker.slot.name,
      );
      this.finish(worker);
      return;
    }

    if (worker.process === null || !worker.process.alive) {
      this.finish(worker);
      return;
    }

    worker.issues.set(name, used + 1);
    worker.state = "BUSY";
    await this.prompt(worker, this.prompts.issue(name, worker.stage!, vars));
    this.track(worker, this.awaitSettle(worker));
  }

  private harvest(taskId: TaskId): void {
    this.harvestWorkspace(this.taskAt(taskId)?.workspace ?? null);
  }

  private harvestWorkspace(workspace: Workspace | null): void {
    if (workspace === null || !fs.existsSync(workspace.worktree)) {
      return;
    }
    git.harvest(this.repo, workspace.worktree, workspace.branch);
  }

  private taskAt(taskId: TaskId): TaskMeta | null {
    const filePath = findTaskFile(taskId, this.tasksDir);
    return filePath === null ? null : readTaskFile(filePath).meta;
  }

  private stop(worker: Worker): void {
    const process = worker.process;
    if (process !== null) {
      process.close();
      if (isProcessAlive(process.pid)) {
        process.kill();
      }
    }
    this.release(worker.slot.name);
  }

  private finish(worker: Worker): void {
    const workspace =
      worker.branch === null || worker.worktree === null
        ? null
        : { branch: worker.branch, worktree: worker.worktree };
    this.stop(worker);
    if (workspace !== null) {
      this.harvestWorkspace({ ...workspace, agent: "", session: null });
    }
  }

  private release(name: string): void {
    const worker = this.worker(name);
    Object.assign(worker, freshWorker(worker.slot));
  }

  private startChecks(tasks: Map<TaskId, TaskMeta>): void {
    for (const [id, task] of tasks) {
      if (task.state !== "CHECK" || this.pendingChecks.has(id)) {
        continue;
      }
      this.pendingChecks.set(
        id,
        this.runChecks(id).finally(() => {
          this.pendingChecks.delete(id);
        }),
      );
    }
  }

  private async runChecks(taskId: TaskId): Promise<void> {
    const task = this.taskAt(taskId)!;
    const worktree = task.workspace?.worktree ?? this.repo;
    const failures: { command: string; exit_code: string; output: string }[] =
      [];

    for (const [index, command] of task.checks.entries()) {
      const result = await this.runCheck(taskId, index, command, worktree);
      if (result.code !== 0) {
        failures.push({
          command: result.command,
          exit_code: String(result.code),
          output: result.tail,
        });
      }
    }

    if (failures.length === 0) {
      this.transition(taskId, "pass", {}, "server");
      return;
    }
    append(
      this.runtime.taskDir(taskId),
      "WORK",
      this.prompts.fragment("check-failed", { failures }),
    );
    this.transition(taskId, "fail", {}, "server");
  }

  private runCheck(
    taskId: TaskId,
    index: number,
    command: string,
    worktree: string,
  ): Promise<CheckResult> {
    return this.checks.start(
      taskId,
      index,
      command,
      worktree,
      this.runtime.checkLog(taskId, index),
      sandbox(
        {
          cwd: worktree,
          writable: [worktree],
          readable: [this.repo],
          overlay: checkWrite(this.slots),
          oomScoreAdjust: CHECK_OOM_SCORE_ADJUST,
        },
        this.sandboxCommand,
      ),
    );
  }

  async attemptMerge(taskId: TaskId): Promise<TransitionResult> {
    const task = this.requireManagerReview(taskId);
    const { branch, worktree } = task.workspace!;

    if (fs.existsSync(worktree)) {
      git.syncBase(worktree, this.base);
      const rebased = git.rebase(worktree, this.base);
      if (rebased.code !== 0) {
        git.abortRebase(worktree);
        throw new Error(
          `the branch no longer rebases onto ${this.base}: ${rebased.stderr.trim()}`,
        );
      }

      for (const [index, command] of task.checks.entries()) {
        const result = await this.runCheck(taskId, index, command, worktree);
        if (result.code !== 0) {
          throw new Error(
            `\`${result.command}\` failed after the rebase (exit ${result.code}):\n${result.tail}`,
          );
        }
      }

      this.harvest(taskId);
    }

    if (git.branchExists(this.repo, branch)) {
      const merged = git.mergeFastForward(this.repo, branch);
      if (merged.code !== 0) {
        throw new Error(
          `the fast-forward merge of ${branch} was refused: ${merged.stderr.trim()}`,
        );
      }
      if (!git.isAncestor(this.repo, branch, this.base)) {
        throw new Error(
          `${branch} is not an ancestor of ${this.base} after the merge`,
        );
      }
    }

    const result = this.transition(taskId, "submit", {}, "manager");
    this.teardown(task);
    return result;
  }

  attemptAbort(taskId: TaskId): TransitionResult {
    const task = this.requireAbortable(taskId);
    const branch = task.workspace?.branch ?? null;

    if (
      branch !== null &&
      git.branchExists(this.repo, branch) &&
      git.isAncestor(this.repo, branch, this.base)
    ) {
      throw new Error(
        `${branch} is already part of ${this.base}; an aborted task is one whose work is being thrown away`,
      );
    }

    return this.transition(taskId, "abort", {}, "manager");
  }

  private requireManagerReview(taskId: TaskId): TaskMeta {
    const task = this.tasks().get(taskId);
    if (task === undefined || task.state !== "MANAGER_REVIEW") {
      throw new Error(`task "${taskId}" is not in MANAGER_REVIEW`);
    }
    return task;
  }

  private requireAbortable(taskId: TaskId): TaskMeta {
    const task = this.tasks().get(taskId);
    if (task === undefined || !ABORTABLE_STATES.includes(task.state)) {
      throw new Error(
        `task "${taskId}" is not in ${ABORTABLE_STATES.join(" or ")}`,
      );
    }
    return task;
  }

  agentRows(): AgentRow[] {
    return [...this.workers.values()].map((worker) => {
      const enabled = !this.disabled.has(worker.slot.agent);
      if (worker.state === "IDLE") {
        return idleRow(worker.slot, enabled);
      }

      const row: AgentRow = {
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
        log:
          worker.task_id === null ? null : this.runtime.rpcLog(worker.task_id),
      };

      if (worker.retry_at !== null) {
        row.retry_at = worker.retry_at;
        row.attempt = worker.attempt;
      }
      return row;
    });
  }

  async writeViews(): Promise<void> {
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
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

    const seq = this.transitions.cursor;
    const { tasks, blocking } = this.snapshot();

    writeAtomic(
      this.runtime.agentsView,
      snapshot(seq, "agents", this.agentRows()),
    );
    writeAtomic(
      this.runtime.checksView,
      snapshot(seq, "checks", this.checks.view),
    );
    writeAtomic(
      this.runtime.tasksView,
      snapshot(
        seq,
        "tasks",
        taskRows(tasks, blocking, this.recent, this.closed),
      ),
    );
    writeAtomic(
      this.runtime.inboxView,
      snapshot(seq, "inbox", inbox(tasks, blocking)),
    );
    writeAtomic(
      this.runtime.queueView,
      snapshot(
        seq,
        "queue",
        candidates(tasks, this.resumable(tasks), blocking),
        { scheduling: this.scheduling },
      ),
    );
  }

  detach(): void {
    this.detached = true;
    this.watcher?.close();
    this.runtime.log("manager exited; agents left running, views left on disk");
  }

  shutdown(): void {
    this.watcher?.close();
    for (const worker of this.workers.values()) {
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
