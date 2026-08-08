import type {
  Assignments,
  Reviews,
  Prompts,
  Publisher,
  Workspaces,
} from "./ports.ts";
import {
  type Run,
  type Runner,
  BACKOFF_START_MS,
  Pool,
  runOf,
} from "./pool.ts";
import { TaskGraph } from "./task-graph.ts";
import { diffAssignment, restored } from "../domain/assignment.ts";
import { type IssueName, ISSUES } from "../domain/issues.ts";
import type { ClaimState } from "../domain/state-machine.ts";
import { STAGE_OF } from "../domain/state-machine.ts";
import type { TaskId } from "../domain/task.ts";
import type { TemplateVars } from "../domain/template.ts";
import {
  type Intent,
  type Settlement,
  decideSettle,
} from "../policy/settle.ts";

export const BACKOFF_CAP_MS = 64000;
export const MODEL_LOADING_MS = 5000;

export class SettleAgent {
  constructor(
    private readonly graph: TaskGraph,
    private readonly pool: Pool,
    private readonly assignments: Assignments,
    private readonly reviews: Reviews,
    private readonly prompts: Prompts,
    private readonly publisher: Publisher,
    private readonly workspaces: Workspaces,
    private readonly base: string,
  ) {}

  nudge(taskId: TaskId, state: ClaimState): string {
    const findings = this.reviews.findings(taskId);
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
    this.pool.track(runner, this.settled(runner));
  }

  async settled(runner: Runner): Promise<void> {
    const run = runOf(runner);
    if (run === null) {
      return;
    }

    await run.process.stream.settled();

    if (!run.process.alive) {
      this.publisher.log(
        `${runner.slot.name} on ${run.taskId}: the process exited without settling: ${run.process.stream.state.failure}`,
      );
      this.pool.finish(runner);
      return;
    }

    runner.state = "SETTLED";
    const stopReason = run.process.stream.state.stopReason;

    const closing = await run.process.lastAssistantText().catch(() => null);
    if (closing !== null) {
      this.publisher.log(
        `${runner.slot.name} on ${run.taskId} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    await this.apply(run, decideSettle(this.observe(run)));
  }

  private observe(run: Run): Settlement {
    const stage = STAGE_OF[run.state];
    const live = this.assignments.read(run.taskId);

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
          : this.workspaces.status(run.checkout.worktree, this.base),
      base: this.base,
    };
  }

  private async apply(run: Run, intents: Intent[]): Promise<void> {
    const { runner, taskId } = run;

    for (const intent of intents) {
      switch (intent.kind) {
        case "abandon": {
          this.pool.finish(runner);
          return;
        }
        case "back-off": {
          await this.backOff(run);
          return;
        }
        case "restore": {
          this.assignments.write(
            taskId,
            restored(
              run.checkout.dispatched,
              this.assignments.read(taskId),
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
          run.process.close();
          this.graph.feedback(taskId, intent.findings, "server");
          this.pool.finish(runner);
          return;
        }
        case "submit": {
          runner.backoff = BACKOFF_START_MS;
          const live = this.assignments.read(taskId);
          run.process.close();
          this.reviews.clearFindings(taskId);
          this.graph.transition(
            taskId,
            "submit",
            intent.body ? { body: live } : {},
            runner.slot.name,
          );
          this.pool.finish(runner);
          return;
        }
      }
    }
  }

  async compacted(runner: Runner): Promise<void> {
    const run = runOf(runner);
    if (run === null || !run.process.alive) {
      return;
    }

    if (runner.results.length > 0) {
      this.publisher.log(
        `${runner.slot.name} on ${run.taskId} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting = runner.role !== "worker";

    if (resetting) {
      this.workspaces.resetTo(run.checkout.worktree, run.checkout.head);
    }

    this.publisher.log(
      `${runner.slot.name} on ${run.taskId} compacted: ${resetting ? "worktree reset, " : ""}steered back to the assignment`,
    );

    await run.process.steer(this.nudge(run.taskId, run.state));
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

    this.publisher.log(
      `${runner.slot.name} waiting ${delay}ms on ${loading ? "model loading" : "provider error"}: ${message}`,
    );

    await Bun.sleep(delay);
    if (!run.process.alive) {
      this.pool.finish(runner);
      return;
    }

    runner.state = "BUSY";
    runner.retry = null;
    await this.prompt(run, this.nudge(run.taskId, run.state));
    this.watch(runner);
  }

  private async raise(
    run: Run,
    name: IssueName,
    detail: string,
    vars: TemplateVars = {},
  ): Promise<void> {
    const { runner, taskId } = run;
    const issue = ISSUES[name];
    const used = runner.issues.get(name) ?? 0;

    this.publisher.log(
      `${runner.slot.name} on ${taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      run.process.close();
      this.graph.transition(
        taskId,
        "hold",
        { reason: issue.held(detail) },
        runner.slot.name,
      );
      this.pool.finish(runner);
      return;
    }

    if (!run.process.alive) {
      this.pool.finish(runner);
      return;
    }

    runner.issues.set(name, used + 1);
    runner.state = "BUSY";
    await this.prompt(run, this.prompts.issue(name, run.state, vars));
    this.watch(runner);
  }
}
