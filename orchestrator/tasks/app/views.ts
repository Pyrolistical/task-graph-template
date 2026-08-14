import type { Paths } from "../../runtime/ports/paths.ts";
import type { Publisher, ViewName } from "../../runtime/ports/publisher.ts";
import type { Transitions } from "../../runtime/ports/transitions.ts";
import type { ServerConfig } from "./config.ts";
import { Checker } from "./checker.ts";
import { Dispatcher } from "./dispatcher.ts";
import type { Pool } from "../../agents/app/pool.ts";
import { TaskGraph } from "./task-graph.ts";
import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import { inbox } from "../policy/inbox.ts";
import { candidates } from "../../agents/policy/scheduler.ts";

export interface PathReport {
  repo: string;
  tasks_dir: string;
  agents_file: string;
  overrides_prompts_dir: string;
  orchestrator_prompts_dir: string;
  runtime_root: string;
  server_log: string;
  transition_log: string;
  console_command: string;
  views: Record<ViewName, string>;
}

export class Views {
  constructor(
    private readonly config: ServerConfig,
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly dispatcher: Dispatcher,
    private readonly checker: Checker,
    private readonly transitions: Transitions,
    private readonly publisher: Publisher,
    private readonly paths: Paths,
  ) {}

  async write(): Promise<void> {
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
      scheduling: this.dispatcher.enabled,
    });
  }

  read(name: ViewName): Awaitable<string> {
    return this.publisher.read(name);
  }

  report(): PathReport {
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
}
