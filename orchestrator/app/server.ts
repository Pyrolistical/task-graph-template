import type {
  ClaimArgs,
  Console,
  Journal,
  Paths,
  Prompts,
  Publisher,
} from "./ports.ts";
import { Dispatch } from "./dispatch.ts";
import { Land } from "./land.ts";
import { Pool } from "./pool.ts";
import { Recover } from "./recover.ts";
import { RunChecks } from "./run-checks.ts";
import { TaskGraph } from "./task-graph.ts";
import type { Command } from "../domain/command.ts";
import type { AgentRow } from "../domain/agents.ts";
import type { Rates } from "../domain/rates.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";
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
  orchestratorDir: string;
  overridesDir: string;
  agentsPath: string;
}

export class Server {
  private watcher: { close(): void } | null = null;
  private scheduling = false;
  private dispatching = false;

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
    private readonly paths: Paths,
    private readonly publisher: Publisher,
  ) {}

  get repo(): string {
    return this.config.repo;
  }

  get base(): string {
    return this.config.base;
  }

  get tasksDir(): string {
    return this.config.tasksDir;
  }

  get orchestratorDir(): string {
    return this.config.orchestratorDir;
  }

  get overridesDir(): string {
    return this.config.overridesDir;
  }

  get agentsPath(): string {
    return this.config.agentsPath;
  }

  get runtime(): Paths {
    return this.paths;
  }

  get prompts(): Prompts {
    return this.promptStore;
  }

  get transitions(): Journal {
    return this.journal;
  }

  get rates(): Rates {
    return this.pool.rates;
  }

  isCheckRunning(taskId: TaskId): boolean {
    return this.checker.isRunning(taskId);
  }

  async start(): Promise<Server> {
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

  attemptMerge(taskId: TaskId): Promise<TransitionResult> {
    return this.lander.merge(taskId);
  }

  attemptAbort(taskId: TaskId): TransitionResult {
    return this.lander.abort(taskId);
  }

  reloadPrompts(): string[] {
    const paths = this.promptStore.reload();
    for (const filePath of paths) {
      this.publisher.log(`cached ${filePath}`);
    }
    return paths;
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

  setAgentEnabled(agent: string, enabled: boolean): AgentRow[] {
    return this.pool.setAgentEnabled(agent, enabled);
  }

  abortAgent(name: string): AgentRow {
    return this.pool.abortAgent(name);
  }

  agentRows(): AgentRow[] {
    return this.pool.rows();
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
      agents: this.pool.rows(),
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
      this.publisher.log(`writing the views failed: ${err.message}`);
    });
  }

  detach(): void {
    this.watcher?.close();
    this.publisher.log(
      "manager exited; agents left running, views left on disk",
    );
  }

  shutdown(): void {
    this.watcher?.close();
    this.pool.shutdown();
  }
}
