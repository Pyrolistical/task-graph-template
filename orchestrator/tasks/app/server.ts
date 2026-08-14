import { messageOf } from "../../kernel/domain/errors.ts";
import type { CommandChannel } from "../../runtime/ports/command-channel.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { Prompts } from "../../prompting/ports/prompts.ts";
import type { Publisher } from "../../runtime/ports/publisher.ts";
import type { ServerConfig } from "./config.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Health } from "./health.ts";
import { Pool } from "../../agents/app/pool.ts";
import { Settler } from "./settler.ts";
import { Recovery } from "./recovery.ts";
import { Checker } from "./checker.ts";
import { TaskGraph } from "./task-graph.ts";
import { Views } from "./views.ts";
import type { Command } from "../../runtime/domain/command.ts";
import { Latch } from "../../kernel/domain/latch.ts";

export class Server {
  private watcher: { close(): void } | undefined = undefined;

  constructor(
    readonly config: ServerConfig,
    private readonly wake: Latch,
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly dispatcher: Dispatcher,
    private readonly settler: Settler,
    private readonly checker: Checker,
    private readonly recovery: Recovery,
    private readonly commands: CommandChannel,
    private readonly prompts: Prompts,
    private readonly paths: Paths,
    private readonly publisher: Publisher,
    private readonly views: Views,
    private readonly health: Health,
  ) {}

  get pending(): Latch {
    return this.wake;
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

      await this.views.write();
      return this;
    } catch (err) {
      await this.release();
      throw err;
    }
  }

  async reloadPrompts(): Promise<string[]> {
    const paths = await this.prompts.reload();
    for (const filePath of paths) {
      await this.publisher.log(`cached ${filePath}`);
    }
    return paths;
  }

  async tick(): Promise<void> {
    this.wake.clear();
    await this.graph.settled();
    const snapshot = await this.graph.snapshot();
    await this.recovery.reap(snapshot.tasks);
    this.checker.start(snapshot.tasks);
    await this.settler.retryDue();
    await this.dispatcher.run(snapshot);
    await this.views.write();
    await this.health.recover();
  }

  async drain(): Promise<void> {
    for (;;) {
      await this.graph.settled();
      if (this.pool.inflight === 0 && this.checker.inflight === 0) {
        return;
      }
      this.wake.clear();
      const done: AbortController = new AbortController();
      await Promise.race([
        Promise.all([this.pool.settled(), this.checker.settled()]),
        this.wake.wait(done.signal),
      ]);
      done.abort();
    }
  }

  private async listen(): Promise<void> {
    const stale = await this.commands.take();
    if (stale) {
      await this.applyCommand(stale);
    }
    this.watcher = this.commands.watch(
      (command) => this.applyCommand(command),
      (err) =>
        this.health.fail(`the console channel failed: ${messageOf(err)}`),
    );
  }

  private async applyCommand(command: Command): Promise<void> {
    await this.publisher.log(`console: ${JSON.stringify(command)}`);
    try {
      if (command.command === "scheduler") {
        await this.dispatcher.setEnabled(command.enabled);
      } else if (command.command === "slot_abort") {
        await this.pool.abortSlot(command.slot);
      } else {
        await this.pool.setAgentEnabled(command.agent, command.enabled);
      }
    } catch (err) {
      await this.publisher.log(`console command refused: ${messageOf(err)}`);
      return;
    }
    try {
      await this.views.write();
    } catch (err) {
      await this.health.fail(`writing the views failed: ${messageOf(err)}`);
    }
    this.wake.notify();
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
    this.pool.shutdown();
    await this.pool.settled();
    await this.release();
    await this.close();
  }

  private stopTaking(): void {
    this.watcher?.close();
  }

  private async release(): Promise<void> {
    await this.paths.clearLock();
    await this.graph.clearLock();
  }

  private async close(): Promise<void> {
    await this.graph.close();
    await this.paths.close();
  }
}
