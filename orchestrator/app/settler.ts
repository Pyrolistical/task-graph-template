import type { Assignments } from "./ports/assignments.ts";
import type { Prompts } from "./ports/prompts.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Reviews } from "./ports/reviews.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import {
  type Run,
  type Runner,
  BACKOFF_START_MS,
  Pool,
  runOf,
} from "./pool.ts";
import { TaskGraph } from "./task-graph.ts";
import { orNull } from "../domain/awaitable.ts";
import { Queue } from "../domain/queue.ts";
import { diffAssignment, restored } from "../domain/assignment.ts";
import { type IssueName, ISSUES } from "../domain/issues.ts";
import type { ClaimState } from "../domain/state-machine.ts";
import { STAGE_OF } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";
import type { FragmentVars } from "../domain/fragment.ts";
import {
  type Intent,
  type Settlement,
  decideSettle,
} from "../policy/settle.ts";

export const BACKOFF_CAP_MS = 64000;
export const MODEL_LOADING_MS = 5000;

export class Settler {
  constructor(
    private readonly graph: TaskGraph,
    private readonly edits: Queue,
    private readonly pool: Pool,
    private readonly assignments: Assignments,
    private readonly reviews: Reviews,
    private readonly prompts: Prompts,
    private readonly publisher: Publisher,
    private readonly workspaces: Workspaces,
    private readonly base: string,
  ) {}

  async nudge(taskId: TaskId, state: ClaimState): Promise<string> {
    const findings = await this.reviews.findings(taskId);
    if (findings.length === 0) {
      return this.prompts.fragment(state);
    }
    return this.prompts.fragment(`${state}-with-findings`, {
      findings: findings.map((finding) => ({ finding })),
    });
  }

  async prompt(run: Run, message: string): Promise<void> {
    run.runner.results = [];
    await run.process.prompt(message);
  }

  watch(runner: Runner): void {
    this.pool.track(runner, this.settle(runner));
  }

  async settle(runner: Runner): Promise<void> {
    const run = runOf(runner);
    if (run === null) {
      return;
    }

    await run.process.stream.settled();

    if (!run.process.alive) {
      await this.publisher.log(
        `${runner.slot.name} on ${run.taskId}: the process exited without settling: ${run.process.stream.state.failure}`,
      );
      await this.pool.finish(runner);
      return;
    }

    runner.state = "SETTLED";
    const stopReason = run.process.stream.state.stopReason;

    const closing = await orNull(run.process.lastAssistantText());
    if (closing !== null) {
      await this.publisher.log(
        `${runner.slot.name} on ${run.taskId} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    await this.apply(run, decideSettle(await this.observe(run)));
  }

  private async observe(run: Run): Promise<Settlement> {
    const stage = STAGE_OF[run.state];
    const live = await this.assignments.read(run.taskId);

    return {
      state: run.state,
      alive: run.process.alive,
      stopReason: run.process.stream.state.stopReason,
      looping: run.process.stream.state.looping,
      calls: run.runner.results,
      diff: diffAssignment(run.checkout.dispatched, live),
      worktree:
        stage.guard === "none"
          ? { dirty: [], commits: 0 }
          : await this.workspaces.status(run.checkout.worktree, this.base),
      base: this.base,
    };
  }

  private async apply(run: Run, intents: Intent[]): Promise<void> {
    const { runner, taskId } = run;

    for (const intent of intents) {
      switch (intent.kind) {
        case "abandon": {
          await this.pool.finish(runner);
          return;
        }
        case "back-off": {
          await this.backOff(run);
          return;
        }
        case "restore": {
          await this.assignments.write(
            taskId,
            restored(
              run.checkout.dispatched,
              await this.assignments.read(taskId),
              intent.section,
            ),
          );
          break;
        }
        case "raise": {
          runner.backoff = BACKOFF_START_MS;
          await this.raise(run, intent.issue, intent.detail, intent.vars);
          return;
        }
        case "feedback": {
          runner.backoff = BACKOFF_START_MS;
          await this.edits.submit(() => this.sendBack(run, intent.findings));
          return;
        }
        case "submit": {
          runner.backoff = BACKOFF_START_MS;
          const live = intent.body ? await this.assignments.read(taskId) : null;
          await this.edits.submit(() => this.accept(run, live));
          return;
        }
      }
    }
  }

  private async sendBack(run: Run, findings: string[]): Promise<void> {
    run.process.close();
    await this.graph.feedback(run.taskId, findings, "server");
    await this.pool.finish(run.runner);
  }

  private async accept(run: Run, body: string | null): Promise<void> {
    run.process.close();
    await this.reviews.clearFindings(run.taskId);
    await this.graph.transition(
      run.taskId,
      "submit",
      body === null ? {} : { body },
      run.runner.slot.name,
    );
    await this.pool.finish(run.runner);
  }

  private async park(run: Run, reason: string): Promise<void> {
    run.process.close();
    await this.graph.transition(
      run.taskId,
      "hold",
      { reason },
      run.runner.slot.name,
    );
    await this.pool.finish(run.runner);
  }

  async compacted(runner: Runner): Promise<void> {
    const run = runOf(runner);
    if (run === null || !run.process.alive) {
      return;
    }

    if (runner.results.length > 0) {
      await this.publisher.log(
        `${runner.slot.name} on ${run.taskId} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting = runner.role !== "worker";

    if (resetting) {
      await this.workspaces.resetTo(run.checkout.worktree, run.checkout.head);
    }

    await this.publisher.log(
      `${runner.slot.name} on ${run.taskId} compacted: ${resetting ? "worktree reset, " : ""}steered back to the assignment`,
    );

    await run.process.steer(await this.nudge(run.taskId, run.state));
  }

  private async backOff(run: Run): Promise<void> {
    const { runner } = run;
    const message = run.process.stream.state.errorMessage ?? "";
    const loading = /503/.test(message) && /load/i.test(message);
    const delay = loading
      ? MODEL_LOADING_MS
      : Math.min(runner.backoff, BACKOFF_CAP_MS);

    const attempt = runner.retry?.attempt ?? 0;
    runner.state = "WAITING";
    runner.retry = {
      at: new Date(Date.now() + delay).toISOString(),
      attempt: loading ? attempt : attempt + 1,
    };
    if (!loading) {
      runner.backoff = Math.min(runner.backoff * 2, BACKOFF_CAP_MS);
    }

    await this.publisher.log(
      `${runner.slot.name} waiting ${delay}ms on ${loading ? "model loading" : "provider error"}: ${message}`,
    );

    await Bun.sleep(delay);
    if (!run.process.alive) {
      await this.pool.finish(runner);
      return;
    }

    runner.state = "BUSY";
    runner.retry = null;
    await this.prompt(run, await this.nudge(run.taskId, run.state));
    this.watch(runner);
  }

  private async raise(
    run: Run,
    name: IssueName,
    detail: string,
    vars: FragmentVars = {},
  ): Promise<void> {
    const { runner, taskId } = run;
    const issue = ISSUES[name];
    const used = runner.issues.get(name) ?? 0;

    await this.publisher.log(
      `${runner.slot.name} on ${taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      await this.edits.submit(() => this.park(run, issue.held(detail)));
      return;
    }

    if (!run.process.alive) {
      await this.pool.finish(runner);
      return;
    }

    runner.issues.set(name, used + 1);
    runner.state = "BUSY";
    await this.prompt(run, this.prompts.issue(name, run.state, vars));
    this.watch(runner);
  }
}
