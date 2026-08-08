import type {
  Assignments,
  Inbox,
  Prompts,
  Publisher,
  Workspaces,
} from "./ports.ts";
import {
  type Running,
  type Worker,
  BACKOFF_START_MS,
  Pool,
  running,
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
    private readonly inbox: Inbox,
    private readonly prompts: Prompts,
    private readonly publisher: Publisher,
    private readonly git: Workspaces,
    private readonly base: string,
  ) {}

  nudge(taskId: TaskId, state: ClaimState): string {
    const findings = this.inbox.findings(taskId);
    if (findings.length === 0) {
      return this.prompts.fragment(state);
    }
    return this.prompts.fragment(`${state}-with-findings`, {
      findings: findings.map((finding) => ({ finding })),
    });
  }

  async prompt(run: Running, message: string): Promise<void> {
    run.worker.results = [];
    await run.process.prompt(message);
  }

  watch(worker: Worker): void {
    this.pool.track(worker, this.settled(worker));
  }

  async settled(worker: Worker): Promise<void> {
    const run = running(worker);
    if (run === null) {
      return;
    }

    await run.process.stream.settled();

    if (!run.process.alive) {
      this.publisher.log(
        `${worker.slot.name} on ${run.taskId}: the process exited without settling: ${run.process.stream.state.failure}`,
      );
      this.pool.finish(worker);
      return;
    }

    worker.state = "SETTLED";
    const stopReason = run.process.stream.state.stopReason;

    const closing = await run.process.lastAssistantText().catch(() => null);
    if (closing !== null) {
      this.publisher.log(
        `${worker.slot.name} on ${run.taskId} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    await this.apply(run, decideSettle(this.observe(run)));
  }

  private observe(run: Running): Settlement {
    const stage = STAGE_OF[run.stage];
    const live = this.assignments.read(run.taskId);

    return {
      state: run.stage,
      alive: run.process.alive,
      stopReason: run.process.stream.state.stopReason,
      looping: run.process.stream.state.looping,
      calls: run.worker.results,
      diff: diffAssignment(run.checkout.dispatched, live),
      worktree:
        stage.guard === "none"
          ? { dirty: [], commits: 0 }
          : this.git.status(run.checkout.worktree, this.base),
      base: this.base,
    };
  }

  private async apply(run: Running, intents: Intent[]): Promise<void> {
    const { worker, taskId } = run;

    for (const intent of intents) {
      switch (intent.kind) {
        case "abandon": {
          this.pool.finish(worker);
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
          worker.backoff = BACKOFF_START_MS;
          await this.raise(run, intent.issue, intent.detail, intent.vars);
          return;
        }
        case "feedback": {
          worker.backoff = BACKOFF_START_MS;
          run.process.close();
          this.graph.feedback(taskId, intent.findings, "server");
          this.pool.finish(worker);
          return;
        }
        case "submit": {
          worker.backoff = BACKOFF_START_MS;
          const live = this.assignments.read(taskId);
          run.process.close();
          this.inbox.clearFindings(taskId);
          this.graph.transition(
            taskId,
            "submit",
            intent.body ? { body: live } : {},
            worker.slot.name,
          );
          this.pool.finish(worker);
          return;
        }
      }
    }
  }

  async compacted(worker: Worker): Promise<void> {
    const run = running(worker);
    if (run === null || !run.process.alive) {
      return;
    }

    if (worker.results.length > 0) {
      this.publisher.log(
        `${worker.slot.name} on ${run.taskId} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting = worker.role !== "worker";

    if (resetting) {
      this.git.resetTo(run.checkout.worktree, run.checkout.head);
    }

    this.publisher.log(
      `${worker.slot.name} on ${run.taskId} compacted: ${resetting ? "worktree reset, " : ""}steered back to the assignment`,
    );

    await run.process.steer(this.nudge(run.taskId, run.stage));
  }

  private async backOff(run: Running): Promise<void> {
    const { worker } = run;
    const message = run.process.stream.state.errorMessage ?? "";
    const loading = /503/.test(message) && /load/i.test(message);
    const delay = loading
      ? MODEL_LOADING_MS
      : Math.min(worker.backoff, BACKOFF_CAP_MS);

    const attempt = worker.retry?.attempt ?? 0;
    worker.state = "WAITING";
    worker.retry = {
      at: new Date(Date.now() + delay).toISOString(),
      attempt: loading ? attempt : attempt + 1,
    };
    if (!loading) {
      worker.backoff = Math.min(worker.backoff * 2, BACKOFF_CAP_MS);
    }

    this.publisher.log(
      `${worker.slot.name} waiting ${delay}ms on ${loading ? "model loading" : "provider error"}: ${message}`,
    );

    await Bun.sleep(delay);
    if (!run.process.alive) {
      this.pool.finish(worker);
      return;
    }

    worker.state = "BUSY";
    worker.retry = null;
    await this.prompt(run, this.nudge(run.taskId, run.stage));
    this.watch(worker);
  }

  private async raise(
    run: Running,
    name: IssueName,
    detail: string,
    vars: TemplateVars = {},
  ): Promise<void> {
    const { worker, taskId } = run;
    const issue = ISSUES[name];
    const used = worker.issues.get(name) ?? 0;

    this.publisher.log(
      `${worker.slot.name} on ${taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      run.process.close();
      this.graph.transition(
        taskId,
        "hold",
        { reason: issue.held(detail) },
        worker.slot.name,
      );
      this.pool.finish(worker);
      return;
    }

    if (!run.process.alive) {
      this.pool.finish(worker);
      return;
    }

    worker.issues.set(name, used + 1);
    worker.state = "BUSY";
    await this.prompt(run, this.prompts.issue(name, run.stage, vars));
    this.watch(worker);
  }
}
