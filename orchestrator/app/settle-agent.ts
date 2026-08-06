import type {
  Assignments,
  Inbox,
  Prompts,
  Publisher,
  Workspaces,
} from "./ports.ts";
import { type Worker, BACKOFF_START_MS, Pool } from "./pool.ts";
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

  async prompt(worker: Worker, message: string): Promise<void> {
    worker.results = [];
    await worker.process!.prompt(message);
  }

  watch(worker: Worker): void {
    this.pool.track(worker, this.settled(worker));
  }

  async settled(worker: Worker): Promise<void> {
    const process = worker.process;
    if (process === null) {
      return;
    }

    await process.stream.settled();

    if (!process.alive) {
      this.publisher.log(
        `${worker.slot.name} on ${worker.task_id}: the process exited without settling: ${process.stream.state.failure}`,
      );
      this.pool.finish(worker);
      return;
    }

    worker.state = "SETTLED";
    const stopReason = process.stream.state.stopReason;

    const closing = await process.lastAssistantText().catch(() => null);
    if (closing !== null) {
      this.publisher.log(
        `${worker.slot.name} on ${worker.task_id} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    await this.apply(worker, decideSettle(this.observe(worker)));
  }

  private observe(worker: Worker): Settlement {
    const process = worker.process!;
    const stage = STAGE_OF[worker.stage!];
    const live = this.assignments.read(worker.task_id!);

    return {
      state: worker.stage!,
      alive: process.alive,
      stopReason: process.stream.state.stopReason,
      looping: process.stream.state.looping,
      calls: worker.results,
      diff: diffAssignment(worker.dispatched!, live),
      worktree:
        stage.guard === "none"
          ? { dirty: [], commits: 0 }
          : this.git.status(worker.worktree!, this.base),
      base: this.base,
    };
  }

  private async apply(worker: Worker, intents: Intent[]): Promise<void> {
    const taskId = worker.task_id!;

    for (const intent of intents) {
      switch (intent.kind) {
        case "abandon": {
          this.pool.finish(worker);
          return;
        }
        case "back-off": {
          await this.backOff(worker);
          return;
        }
        case "restore": {
          this.assignments.write(
            taskId,
            restored(
              worker.dispatched!,
              this.assignments.read(taskId),
              intent.section,
            ),
          );
          break;
        }
        case "raise": {
          worker.backoff = BACKOFF_START_MS;
          await this.raise(worker, intent.issue, intent.detail, intent.vars);
          return;
        }
        case "feedback": {
          worker.backoff = BACKOFF_START_MS;
          worker.process!.close();
          this.graph.feedback(taskId, intent.findings, "server");
          this.pool.finish(worker);
          return;
        }
        case "submit": {
          worker.backoff = BACKOFF_START_MS;
          const live = this.assignments.read(taskId);
          worker.process!.close();
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
    const process = worker.process;
    if (process === null || !process.alive) {
      return;
    }

    if (worker.results.length > 0) {
      this.publisher.log(
        `${worker.slot.name} on ${worker.task_id} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting =
      worker.role !== "worker" &&
      worker.worktree !== null &&
      worker.head !== null;

    if (resetting) {
      this.git.resetTo(worker.worktree!, worker.head!);
    }

    this.publisher.log(
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
    if (worker.process === null || !worker.process.alive) {
      this.pool.finish(worker);
      return;
    }

    worker.state = "BUSY";
    worker.retry = null;
    await this.prompt(worker, this.nudge(worker.task_id!, worker.stage!));
    this.watch(worker);
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

    this.publisher.log(
      `${worker.slot.name} on ${taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      worker.process?.close();
      this.graph.transition(
        taskId,
        "hold",
        { reason: issue.held(detail) },
        worker.slot.name,
      );
      this.pool.finish(worker);
      return;
    }

    if (worker.process === null || !worker.process.alive) {
      this.pool.finish(worker);
      return;
    }

    worker.issues.set(name, used + 1);
    worker.state = "BUSY";
    await this.prompt(worker, this.prompts.issue(name, worker.stage!, vars));
    this.watch(worker);
  }
}
