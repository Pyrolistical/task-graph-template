import type { CommandChannel } from "./ports/command-channel.ts";
import type { Paths } from "./ports/paths.ts";
import type { Prompts } from "./ports/prompts.ts";
import type { Publisher, ViewName } from "./ports/publisher.ts";
import type { ClaimArgs, CreatedTask } from "./ports/tasks.ts";
import type { Transitions } from "./ports/transitions.ts";
import type { Manager, PathReport } from "./manager.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Lander } from "./lander.ts";
import { Pool } from "./pool.ts";
import { Recovery } from "./recovery.ts";
import { Checker } from "./checker.ts";
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
    private readonly dispatcher: Dispatcher,
    private readonly checker: Checker,
    private readonly lander: Lander,
    private readonly recovery: Recovery,
    private readonly commands: CommandChannel,
    private readonly transitions: Transitions,
    private readonly prompts: Prompts,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
  ) {}

  isCheckRunning(taskId: TaskId): boolean {
    return this.checker.isRunning(taskId);
  }

  view(name: ViewName): string {
    return this.publisher.read(name);
  }

  pathReport(): PathReport {
    return {
      repo: this.config.repo,
      tasks_dir: this.config.tasksDir,
      agents_file: this.config.agentsPath,
      overrides_prompts_dir: this.config.promptDirs.overrides,
      orchestrator_prompts_dir: this.config.promptDirs.orchestrator,
      runtime_root: this.paths.root,
      server_log: this.paths.serverLog,
      transition_log: this.paths.transitionLog,
      console_command: this.paths.consoleCommand,
      views: {
        slots: this.paths.slotsView,
        checks: this.paths.checksView,
        tasks: this.paths.tasksView,
        inbox: this.paths.inboxView,
        queue: this.paths.queueView,
      },
    };
  }

  async start(): Promise<Server> {
    this.paths.takeLock();
    this.publisher.log(
      `starting against ${this.config.repo} (base ${this.config.base})`,
    );
    for (const filePath of this.prompts.cachedFiles()) {
      this.publisher.log(`cached ${filePath}`);
    }
    this.recovery.reclone();
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
    this.transitions.append({
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
    const paths = this.prompts.reload();
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

  abortSlot(name: string): SlotRow {
    return this.pool.abortSlot(name);
  }

  slotRows(): SlotRow[] {
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
    while (this.pool.inflight > 0 || this.checker.inflight > 0) {
      await Promise.all([this.pool.settled(), this.checker.settled()]);
    }
  }

  async writeViews(): Promise<void> {
    await this.pool.readStats();

    const snapshot = this.graph.snapshot();

    this.publisher.publish({
      seq: this.transitions.cursor,
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
    const stale = this.commands.take();
    if (stale !== null) {
      this.applyCommand(stale);
    }
    this.watcher = this.commands.watch((command) => {
      this.applyCommand(command);
    });
  }

  private applyCommand(command: Command): void {
    this.publisher.log(`console: ${JSON.stringify(command)}`);
    try {
      if (command.command === "scheduler") {
        this.setSchedulerEnabled(command.enabled);
      } else if (command.command === "slot_abort") {
        this.abortSlot(command.slot);
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
    this.paths.clearLock();
    this.publisher.log(
      "manager exited; agents left running, views left on disk",
    );
  }

  shutdown(): void {
    this.watcher?.close();
    this.paths.clearLock();
    this.pool.shutdown();
  }
}
