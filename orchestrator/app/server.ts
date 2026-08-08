import type {
  ClaimArgs,
  Console,
  CreatedTask,
  Journal,
  Paths,
  Prompts,
  Publisher,
  ViewName,
} from "./ports.ts";
import type { Manager, PathReport } from "./manager.ts";
import { Dispatch } from "./dispatch.ts";
import { Land } from "./land.ts";
import { Pool } from "./pool.ts";
import { Recover } from "./recover.ts";
import { RunChecks } from "./run-checks.ts";
import { TaskGraph } from "./task-graph.ts";
import type { Command } from "../domain/command.ts";
import type { SlotRow } from "../domain/agents.ts";
import { type TaskId, type TaskMeta, detectCycles } from "../domain/task.ts";
import type {
  TransitionArgs,
  TransitionName,
  TransitionResult,
} from "../domain/state-machine.ts";
import { inbox } from "../policy/inbox.ts";
import { candidates } from "../policy/scheduler.ts";

export interface ServerConfig {
  repo: string;
  base: string;
  tasksDir: string;
  agentsPath: string;
  promptDirs: { orchestrator: string; overrides: string };
}

export class Server implements Manager {
  private watcher: { close(): void } | null = null;
  private scheduling = false;
  private dispatching = false;
  private failure: string | null = null;

  constructor(
    readonly config: ServerConfig,
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly dispatcher: Dispatch,
    private readonly checker: RunChecks,
    private readonly lander: Land,
    private readonly recovery: Recover,
    private readonly console: Console,
    private readonly journal: Journal,
    private readonly promptStore: Prompts,
    private readonly layout: Paths,
    private readonly publisher: Publisher,
  ) {}

  isCheckRunning(taskId: TaskId): boolean {
    return this.checker.isRunning(taskId);
  }

  view(name: ViewName): string {
    return this.publisher.read(name);
  }

  paths(): PathReport {
    return {
      repo: this.config.repo,
      tasks_dir: this.config.tasksDir,
      agents_file: this.config.agentsPath,
      overrides_prompts_dir: this.config.promptDirs.overrides,
      orchestrator_prompts_dir: this.config.promptDirs.orchestrator,
      runtime_root: this.layout.root,
      server_log: this.layout.serverLog,
      transition_log: this.layout.transitionLog,
      console_command: this.layout.consoleCommand,
      views: {
        slots: this.layout.slotsView,
        checks: this.layout.checksView,
        tasks: this.layout.tasksView,
        inbox: this.layout.inboxView,
        queue: this.layout.queueView,
      },
    };
  }

  async start(): Promise<Server> {
    this.layout.takeLock();
    this.publisher.log(
      `starting against ${this.config.repo} (base ${this.config.base})`,
    );
    for (const filePath of this.promptStore.cachedFiles()) {
      this.publisher.log(`cached ${filePath}`);
    }
    this.recovery.workspaces();
    this.recovery.reattach();
    this.listen();
    this.graph.rememberMostRecent();

    await this.writeViews();
    return this;
  }

  tasks(): Map<TaskId, TaskMeta> {
    return this.graph.list();
  }

  claim(taskId: TaskId, args: ClaimArgs): void {
    this.graph.claim(taskId, args);
  }

  transition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): TransitionResult {
    return this.graph.transition(taskId, name, args, by);
  }

  feedback(taskId: TaskId, findings: string[], by: string): TransitionResult {
    return this.graph.feedback(taskId, findings, by);
  }

  createTask(title: string): CreatedTask {
    const created = this.graph.create(title);
    this.journal.append({
      task_id: created.id,
      transition: "create",
      from: "NEW",
      to: "NEW",
      by: "manager",
    });
    return created;
  }

  writeBody(taskId: TaskId, body: string): string {
    return this.graph.writeBody(taskId, body);
  }

  async submit(taskId: TaskId): Promise<TransitionResult> {
    const tasks = this.tasks();
    if (tasks.get(taskId)?.state === "MANAGER_REVIEW") {
      return this.lander.merge(taskId);
    }
    if (detectCycles(tasks).includes(taskId)) {
      throw new Error(
        `task "${taskId}" is part of a dependency cycle through ${tasks.get(taskId)?.depends_on.join(", ")}; it could never unblock`,
      );
    }
    return this.transition(taskId, "submit", {}, "manager");
  }

  hold(taskId: TaskId, reason: string): TransitionResult {
    return this.transition(taskId, "hold", { reason }, "manager");
  }

  resume(taskId: TaskId): TransitionResult {
    return this.transition(taskId, "resume", {}, "manager");
  }

  abort(taskId: TaskId): TransitionResult {
    return this.lander.abort(taskId);
  }

  reloadPrompts(): string[] {
    const paths = this.promptStore.reload();
    for (const filePath of paths) {
      this.publisher.log(`cached ${filePath}`);
    }
    return paths;
  }

  get lastError(): string | null {
    return this.failure;
  }

  fail(message: string): void {
    this.failure = message;
    this.publisher.log(message);
  }

  get schedulerEnabled(): boolean {
    return this.scheduling;
  }

  setSchedulerEnabled(enabled: boolean): void {
    if (enabled && this.pool.slots.length === 0) {
      throw new Error(
        `no agents to dispatch to; add one to ${this.config.agentsPath}`,
      );
    }
    this.scheduling = enabled;
    this.publisher.log(`scheduler ${enabled ? "enabled" : "disabled"}`);
  }

  setAgentEnabled(agent: string, enabled: boolean): SlotRow[] {
    return this.pool.setAgentEnabled(agent, enabled);
  }

  abortAgent(name: string): SlotRow {
    return this.pool.abortAgent(name);
  }

  agentRows(): SlotRow[] {
    return this.pool.rows();
  }

  rateOf(agent: string): number | null {
    return this.pool.rates.rate(agent);
  }

  async tick(): Promise<void> {
    await this.checker.settled();
    const snapshot = this.graph.snapshot();
    this.recovery.reap(snapshot.tasks);
    this.checker.start(snapshot.tasks);
    if (this.scheduling && !this.dispatching) {
      this.dispatching = true;
      try {
        await this.dispatcher.run(snapshot);
      } finally {
        this.dispatching = false;
      }
    }
    await this.writeViews();
  }

  async drain(): Promise<void> {
    while (this.pool.running > 0 || this.checker.running > 0) {
      await Promise.all([this.pool.settled(), this.checker.settled()]);
    }
  }

  async writeViews(): Promise<void> {
    await this.pool.readStats();

    const snapshot = this.graph.snapshot();

    this.publisher.publish({
      seq: this.journal.cursor,
      agentsFile: this.config.agentsPath,
      slots: this.pool.rows(),
      checks: this.checker.view,
      tasks: this.graph.rows(snapshot),
      inbox: inbox(snapshot.tasks, snapshot.blocking),
      queue: candidates(
        snapshot.tasks,
        this.dispatcher.resumable(snapshot.tasks),
        snapshot.blocking,
      ),
      scheduling: this.scheduling,
    });
  }

  private listen(): void {
    const stale = this.console.take();
    if (stale !== null) {
      this.applyCommand(stale);
    }
    this.watcher = this.console.watch((command) => {
      this.applyCommand(command);
    });
  }

  private applyCommand(command: Command): void {
    this.publisher.log(`console: ${JSON.stringify(command)}`);
    try {
      if (command.command === "scheduler") {
        this.setSchedulerEnabled(command.enabled);
      } else if (command.command === "agent_abort") {
        this.abortAgent(command["agent-name-slot"]);
      } else {
        this.setAgentEnabled(command.agent, command.enabled);
      }
    } catch (err) {
      this.publisher.log(`console command refused: ${(err as Error).message}`);
      return;
    }
    void this.writeViews().catch((err: Error) => {
      this.fail(`writing the views failed: ${err.message}`);
    });
  }

  detach(): void {
    this.watcher?.close();
    this.layout.clearLock();
    this.publisher.log(
      "manager exited; agents left running, views left on disk",
    );
  }

  shutdown(): void {
    this.watcher?.close();
    this.layout.clearLock();
    this.pool.shutdown();
  }
}
