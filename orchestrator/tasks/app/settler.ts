import type { Assignments } from "../../runtime/ports/assignments.ts";
import type { Prompts } from "../../prompting/ports/prompts.ts";
import type { Log } from "../../runtime/ports/log.ts";
import type { Reviews } from "../../runtime/ports/reviews.ts";
import type { Workspaces } from "../../workspaces/ports/workspaces.ts";
import type { Run, Pool } from "../../agents/app/pool.ts";
import { TaskGraph } from "./task-graph.ts";
import { orUndefined } from "../../kernel/domain/awaitable.ts";
import { nextWait } from "../../agents/domain/backoff.ts";
import { diffAssignment, restored } from "../../vocabulary/assignment.ts";
import { type IssueName, ISSUES } from "../../prompting/domain/issues.ts";
import type { ClaimState } from "../../vocabulary/state-machine.ts";
import { STAGE_OF } from "../../vocabulary/state-machine.ts";
import type { TaskId } from "../../vocabulary/task.ts";
import type { FragmentVars } from "../../prompting/domain/fragment.ts";
import {
  type Intent,
  type Settlement,
  decideSettle,
} from "../policy/settle.ts";

export interface SettlerOptions {
  graph: TaskGraph;
  pool: Pool;
  assignments: Assignments;
  reviews: Reviews;
  prompts: Prompts;
  log: Log;
  workspaces: Workspaces;
  base: string;
}

export class Settler {
  private readonly graph: TaskGraph;
  private readonly pool: Pool;
  private readonly assignments: Assignments;
  private readonly reviews: Reviews;
  private readonly prompts: Prompts;
  private readonly log: Log;
  private readonly workspaces: Workspaces;
  private readonly base: string;

  constructor(options: SettlerOptions) {
    this.graph = options.graph;
    this.pool = options.pool;
    this.assignments = options.assignments;
    this.reviews = options.reviews;
    this.prompts = options.prompts;
    this.log = options.log;
    this.workspaces = options.workspaces;
    this.base = options.base;
  }

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
    this.pool.clearResults(run);
    await run.process.prompt(message);
  }

  watch(run: Run): void {
    this.pool.track(run, this.settle(run));
  }

  async settle(run: Run): Promise<void> {
    await run.process.stream.settled();

    if (!run.process.alive) {
      await this.log(
        `${run.slot.name} on ${run.taskId}: the process exited without settling: ${run.process.stream.state.failure}`,
      );
      await this.pool.finish(run);
      return;
    }

    this.pool.settling(run);
    const stopReason = run.process.stream.state.stopReason;

    const closing = await orUndefined(run.process.lastAssistantText());
    if (closing) {
      await this.log(
        `${run.slot.name} on ${run.taskId} settled (${stopReason}): ${closing.split("\n")[0]}`,
      );
    }

    await this.apply(run, decideSettle(await this.observe(run)));
  }

  async retryDue(nowMs = Date.now()): Promise<void> {
    for (const run of this.pool.due(nowMs)) {
      if (!run.process.alive) {
        await this.pool.finish(run);
        continue;
      }
      this.pool.busy(run);
      await this.prompt(run, await this.nudge(run.taskId, run.state));
      this.watch(run);
    }
  }

  private async observe(run: Run): Promise<Settlement> {
    const stage = STAGE_OF[run.state];
    const live = await this.assignments.read(run.taskId);

    return {
      state: run.state,
      alive: run.process.alive,
      stopReason: run.process.stream.state.stopReason,
      looping: run.process.stream.state.looping,
      aborted: run.aborted,
      calls: run.results,
      diff: diffAssignment(run.checkout.dispatched, live),
      worktree:
        stage.guard === "none"
          ? { dirty: [], commits: 0 }
          : await this.workspaces.status(run.checkout.worktree, this.base),
      base: this.base,
    };
  }

  private async apply(run: Run, intents: Intent[]): Promise<void> {
    const { taskId } = run;

    for (const intent of intents) {
      switch (intent.kind) {
        case "abandon": {
          await this.pool.finish(run);
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
          this.pool.recovered(run);
          await this.raise(run, intent.issue, intent.detail, intent.vars);
          return;
        }
        case "feedback": {
          this.pool.recovered(run);
          await this.sendBack(run, intent.findings);
          return;
        }
        case "submit": {
          this.pool.recovered(run);
          const live = intent.body
            ? await this.assignments.read(taskId)
            : undefined;
          await this.accept(run, live);
          return;
        }
      }
    }
  }

  private async sendBack(run: Run, findings: string[]): Promise<void> {
    run.process.close();
    await this.graph.feedback(run.taskId, findings, "server");
    await this.pool.finish(run);
  }

  private async accept(run: Run, body?: string): Promise<void> {
    run.process.close();
    await this.reviews.clearFindings(run.taskId);
    await this.graph.transition(
      run.taskId,
      "submit",
      body ? { body } : {},
      run.slot.name,
    );
    await this.pool.finish(run);
  }

  private async park(run: Run, reason: string): Promise<void> {
    run.process.close();
    await this.graph.transition(run.taskId, "hold", { reason }, run.slot.name);
    await this.pool.finish(run);
  }

  async compacted(run: Run): Promise<void> {
    if (!run.process.alive) {
      return;
    }

    if (run.results.length > 0) {
      await this.log(
        `${run.slot.name} on ${run.taskId} compacted after its result: left alone to settle`,
      );
      return;
    }

    const resetting = run.role !== "worker";

    if (resetting) {
      await this.workspaces.resetTo(run.checkout.worktree, run.checkout.head);
    }

    await this.log(
      `${run.slot.name} on ${run.taskId} compacted: ${resetting ? "worktree reset, " : ""}steered back to the assignment`,
    );

    await run.process.steer(await this.nudge(run.taskId, run.state));
  }

  private async backOff(run: Run): Promise<void> {
    const message = run.process.stream.state.errorMessage ?? "";
    const wait = nextWait(message, run.wait);

    this.pool.waiting(run, wait);

    await this.log(
      `${run.slot.name} waiting ${wait.delayMs}ms on ${wait.loading ? "model loading" : "provider error"}: ${message}`,
    );
  }

  private async raise(
    run: Run,
    name: IssueName,
    detail: string,
    vars: FragmentVars = {},
  ): Promise<void> {
    const issue = ISSUES[name];
    const used = run.attempts(name);

    await this.log(
      `${run.slot.name} on ${run.taskId}: ${name} (${used}/${issue.attempts} retried)${detail === "" ? "" : `: ${detail}`}`,
    );

    if (used >= issue.attempts) {
      await this.park(run, issue.held(detail));
      return;
    }

    if (!run.process.alive) {
      await this.pool.finish(run);
      return;
    }

    this.pool.raised(run, name);
    await this.prompt(run, this.prompts.issue(name, run.state, vars));
    this.watch(run);
  }
}
