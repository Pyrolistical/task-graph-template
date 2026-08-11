import { messageOf } from "../domain/errors.ts";
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
import { Latch } from "../domain/latch.ts";
import { Queue } from "../domain/queue.ts";
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
  private watcher: { close(): void } | undefined = undefined;
  private scheduling = false;
  private failure: string | undefined = undefined;

  constructor(
    readonly config: ServerConfig,
    private readonly queue: Queue,
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

  get pending(): Latch {
    return this.queue.pending;
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.submit(work);
  }

  async view(name: ViewName): Promise<string> {
    return await this.publisher.read(name);
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
    await this.paths.takeLock();
    try {
      await this.graph.takeLock();
      await this.publisher.log(
        `starting against ${this.config.repo} (base ${this.config.base})`,
      );
      for (const filePath of this.prompts.cachedFiles()) {
        await this.publisher.log(`cached ${filePath}`);
      }
      await this.recovery.reclone();
      await this.recovery.reattach();
      await this.listen();
      await this.graph.rememberMostRecent();

      await this.writeViews();
      return this;
    } catch (err) {
      await this.release();
      throw err;
    }
  }

  tasks(): Promise<Map<TaskId, TaskMeta>> {
    return this.graph.list();
  }

  async claim(taskId: TaskId, args: ClaimArgs): Promise<void> {
    await this.graph.claim(taskId, args);
  }

  transition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): Promise<TransitionResult> {
    return this.graph.transition(taskId, name, args, by);
  }

  feedback(
    taskId: TaskId,
    findings: string[],
    by: string,
  ): Promise<TransitionResult> {
    return this.graph.feedback(taskId, findings, by);
  }

  async createTask(title: string): Promise<CreatedTask> {
    const created = await this.graph.create(title);
    await this.transitions.append({
      task_id: created.id,
      transition: "create",
      from: "NEW",
      to: "NEW",
      by: "manager",
    });
    return created;
  }

  async writeBody(taskId: TaskId, body: string): Promise<string> {
    return await this.graph.writeBody(taskId, body);
  }

  async submit(taskId: TaskId): Promise<TransitionResult> {
    const tasks = await this.tasks();
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

  hold(taskId: TaskId, reason: string): Promise<TransitionResult> {
    return this.transition(taskId, "hold", { reason }, "manager");
  }

  resume(taskId: TaskId): Promise<TransitionResult> {
    return this.transition(taskId, "resume", {}, "manager");
  }

  abort(taskId: TaskId): Promise<TransitionResult> {
    return this.lander.abort(taskId);
  }

  async reloadPrompts(): Promise<string[]> {
    const paths = await this.prompts.reload();
    for (const filePath of paths) {
      await this.publisher.log(`cached ${filePath}`);
    }
    return paths;
  }

  get lastError(): string | undefined {
    return this.failure;
  }

  async fail(message: string): Promise<void> {
    this.failure = message;
    await this.publisher.log(message);
  }

  get schedulerEnabled(): boolean {
    return this.scheduling;
  }

  async setSchedulerEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.pool.slots.length === 0) {
      throw new Error(
        `no agents to dispatch to; add one to ${this.config.agentsPath}`,
      );
    }
    this.scheduling = enabled;
    await this.publisher.log(`scheduler ${enabled ? "enabled" : "disabled"}`);
  }

  setAgentEnabled(agent: string, enabled: boolean): Promise<SlotRow[]> {
    return this.pool.setAgentEnabled(agent, enabled);
  }

  abortSlot(name: string): Promise<SlotRow> {
    return this.pool.abortSlot(name);
  }

  slotRows(): SlotRow[] {
    return this.pool.rows();
  }

  rateOf(agent: string): number | undefined {
    return this.pool.rates.rate(agent);
  }

  async tick(): Promise<void> {
    await this.queue.drain();
    const snapshot = await this.graph.snapshot();
    await this.recovery.reap(snapshot.tasks);
    this.checker.start(snapshot.tasks);
    if (this.scheduling) {
      await this.dispatcher.run(snapshot);
    }
    await this.writeViews();
  }

  async drain(): Promise<void> {
    for (;;) {
      await this.queue.drain();
      if (this.pool.inflight === 0 && this.checker.inflight === 0) {
        return;
      }
      const done: AbortController = new AbortController();
      await Promise.race([
        Promise.all([this.pool.settled(), this.checker.settled()]),
        this.queue.pending.wait(done.signal),
      ]);
      done.abort();
    }
  }

  async writeViews(): Promise<void> {
    await this.pool.readStats();

    const snapshot = await this.graph.snapshot();

    await this.publisher.publish({
      seq: this.transitions.cursor,
      agentsFile: this.config.agentsPath,
      slots: this.pool.rows(),
      checks: this.checker.view,
      tasks: this.graph.rows(snapshot),
      inbox: inbox(snapshot.tasks, snapshot.blocking),
      queue: candidates(
        snapshot.tasks,
        await this.dispatcher.resumable(snapshot.tasks),
        snapshot.blocking,
      ),
      scheduling: this.scheduling,
    });
  }

  private async listen(): Promise<void> {
    const stale = await this.commands.take();
    if (stale) {
      await this.applyCommand(stale);
    }
    this.watcher = this.commands.watch(
      (command) => this.enqueue(() => this.applyCommand(command)),
      (err) => this.fail(`the console channel failed: ${messageOf(err)}`),
    );
  }

  private async applyCommand(command: Command): Promise<void> {
    await this.publisher.log(`console: ${JSON.stringify(command)}`);
    try {
      if (command.command === "scheduler") {
        await this.setSchedulerEnabled(command.enabled);
      } else if (command.command === "slot_abort") {
        await this.abortSlot(command.slot);
      } else {
        await this.setAgentEnabled(command.agent, command.enabled);
      }
    } catch (err) {
      await this.publisher.log(`console command refused: ${messageOf(err)}`);
      return;
    }
    try {
      await this.writeViews();
    } catch (err) {
      await this.fail(`writing the views failed: ${messageOf(err)}`);
    }
  }

  async detach(): Promise<void> {
    this.stopTaking();
    await this.release();
    await this.publisher.log(
      "manager exited; agents left running, views left on disk",
    );
    await this.close();
  }

  async shutdown(): Promise<void> {
    this.stopTaking();
    await this.release();
    this.pool.shutdown();
    await this.close();
  }

  private stopTaking(): void {
    this.watcher?.close();
    this.queue.close();
  }

  private async release(): Promise<void> {
    await this.paths.clearLock();
    await this.graph.clearLock();
  }

  private async close(): Promise<void> {
    await this.transitions.close();
    await this.paths.close();
  }
}
