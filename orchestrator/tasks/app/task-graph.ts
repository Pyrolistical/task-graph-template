import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import { Latch } from "../../kernel/domain/latch.ts";
import { Queue } from "../../kernel/domain/queue.ts";
import type { Paths } from "../../runtime/ports/paths.ts";
import type { Log } from "../../runtime/ports/log.ts";
import type { Reviews } from "../../runtime/ports/reviews.ts";
import type { ClaimArgs, CreatedTask, Tasks } from "../ports/tasks.ts";
import type { Transitions } from "../../runtime/ports/transitions.ts";
import type { Workspaces } from "../../workspaces/ports/workspaces.ts";
import { type TaskRow } from "../../views/tasks.ts";
import { RECENT_TASKS, taskRow, taskRows } from "../domain/rows.ts";
import { keepRecent } from "../policy/recent.ts";
import { blockingCounts } from "../../vocabulary/blocking.ts";
import type { Cost } from "../../vocabulary/costs.ts";
import {
  type TaskId,
  type TaskMeta,
  detectCycles,
} from "../../vocabulary/task.ts";
import {
  type EntryName,
  type TaskState,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  REVIEW_FAILURE_LIMIT,
  isReviewState,
} from "../../vocabulary/state-machine.ts";

function reviewFailureReason(state: TaskState, findings: string[]): string {
  const bullets = findings.map((finding) => `- ${finding}`).join("\n");
  return `failed ${REVIEW_FAILURE_LIMIT} rounds of ${state} with:\n${bullets}`;
}

export interface Snapshot {
  tasks: Map<TaskId, TaskMeta>;
  blocking: Map<TaskId, number>;
}

export interface TaskGraphOptions {
  tasks: Tasks;
  workspaces: Workspaces;
  reviews: Reviews;
  transitions: Transitions;
  log: Log;
  paths: Paths;
  wake?: Latch;
}

export class TaskGraph {
  private readonly edits = new Queue();
  private recent: TaskId[] = [];
  private readonly closed = new Map<TaskId, TaskRow>();
  private problems = new Map<string, string>();
  private cycling = new Set<TaskId>();

  private readonly tasks: Tasks;
  private readonly workspaces: Workspaces;
  private readonly reviews: Reviews;
  private readonly transitions: Transitions;
  private readonly log: Log;
  private readonly paths: Paths;
  private readonly wake: Latch;

  constructor(options: TaskGraphOptions) {
    this.tasks = options.tasks;
    this.workspaces = options.workspaces;
    this.reviews = options.reviews;
    this.transitions = options.transitions;
    this.log = options.log;
    this.paths = options.paths;
    this.wake = options.wake ?? new Latch();
  }

  private edit<T>(work: () => Awaitable<T>): Promise<T> {
    const done = this.edits.submit(work);
    this.wake.notify();
    return done;
  }

  settled(): Promise<void> {
    return this.edits.settled();
  }

  async close(): Promise<void> {
    this.edits.close();
    await this.transitions.close();
  }

  takeLock(): Awaitable<void> {
    return this.tasks.takeLock();
  }

  clearLock(): Awaitable<void> {
    return this.tasks.clearLock();
  }

  async rememberMostRecent(): Promise<void> {
    const sorted = [...(await this.list()).values()].sort((a, b) =>
      (b.state_entered ?? "").localeCompare(a.state_entered ?? ""),
    );
    for (const task of sorted.slice(0, RECENT_TASKS)) {
      this.recent.push(task.id);
    }
  }

  async list(): Promise<Map<TaskId, TaskMeta>> {
    const { tasks, problems } = await this.tasks.list();

    for (const [filePath, message] of problems) {
      if (this.problems.get(filePath) !== message) {
        await this.log(`ignoring ${filePath}: ${message}`);
      }
    }
    for (const filePath of this.problems.keys()) {
      if (!problems.has(filePath)) {
        await this.log(`${filePath} parses again`);
      }
    }
    this.problems = problems;
    await this.reportCycles(tasks);

    return tasks;
  }

  private async reportCycles(tasks: Map<TaskId, TaskMeta>): Promise<void> {
    const cycling = new Set(detectCycles(tasks));

    for (const id of cycling) {
      if (!this.cycling.has(id)) {
        await this.log(
          `task ${id} depends on itself through ${tasks.get(id)?.depends_on.join(", ")}; it can never unblock`,
        );
      }
    }
    this.cycling = cycling;
  }

  async snapshot(): Promise<Snapshot> {
    const tasks = await this.list();
    return { tasks, blocking: blockingCounts(tasks) };
  }

  read(taskId: TaskId): Awaitable<TaskMeta | undefined> {
    return this.tasks.read(taskId);
  }

  body(taskId: TaskId): Awaitable<string> {
    return this.tasks.body(taskId);
  }

  create(title: string): Promise<CreatedTask> {
    return this.edit(async () => {
      const created = await this.tasks.create(title);
      await this.transitions.append({
        task_id: created.id,
        transition: "create",
        from: "NEW",
        to: "NEW",
        by: "manager",
      });
      return created;
    });
  }

  async enter(taskId: TaskId, name: EntryName): Promise<TransitionResult> {
    const tasks = await this.list();
    if (detectCycles(tasks).includes(taskId)) {
      throw new Error(
        `task "${taskId}" is part of a dependency cycle through ${tasks.get(taskId)?.depends_on.join(", ")}; it could never unblock`,
      );
    }
    return this.transition(taskId, name, {}, "manager");
  }

  hold(taskId: TaskId, reason: string): Promise<TransitionResult> {
    return this.transition(taskId, "hold", { reason }, "manager");
  }

  resume(taskId: TaskId): Promise<TransitionResult> {
    return this.transition(taskId, "resume", {}, "manager");
  }

  writeBody(taskId: TaskId, body: string): Promise<string> {
    return this.edit(() => this.tasks.writeBody(taskId, body));
  }

  claim(taskId: TaskId, args: ClaimArgs): Promise<void> {
    return this.edit(async () => {
      await this.tasks.claim(taskId, args);
      await this.remember(taskId, await this.list());
    });
  }

  recordCost(taskId: TaskId, cost: Cost, resumed: boolean): Promise<void> {
    return this.edit(async () => {
      await this.tasks.recordCost(taskId, cost, resumed);
    });
  }

  releaseClaim(taskId: TaskId): Promise<void> {
    return this.edit(async () => {
      await this.tasks.releaseClaim(taskId);
      await this.remember(taskId, await this.list());
    });
  }

  transition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): Promise<TransitionResult> {
    return this.edit(() => this.applyTransition(taskId, name, args, by));
  }

  private async applyTransition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): Promise<TransitionResult> {
    const tasks = await this.list();
    const before = tasks.get(taskId);
    const result = await this.tasks.apply(taskId, name, args);
    if (name === "submit" && isReviewState(result.from)) {
      await this.reviews.clearFailures(taskId);
    }
    if (result.to === "CLOSED" && before) {
      this.closed.set(taskId, {
        ...taskRow(before, blockingCounts(tasks).get(taskId) ?? 0),
        state: "CLOSED",
        state_entered: new Date().toISOString(),
        claimed_by: undefined,
        worktree: undefined,
      });
      await this.teardown(before);
      await this.paths.discard(taskId);
    }

    await this.transitions.append({
      task_id: taskId,
      transition: name,
      from: result.from,
      to: result.to,
      by,
    });
    await this.remember(taskId, tasks);
    return result;
  }

  feedback(
    taskId: TaskId,
    findings: string[],
    by: string,
  ): Promise<TransitionResult> {
    return this.edit(() => this.applyFeedback(taskId, findings, by));
  }

  private async applyFeedback(
    taskId: TaskId,
    findings: string[],
    by: string,
  ): Promise<TransitionResult> {
    await this.reviews.setFindings(taskId, findings);
    const state = (await this.tasks.read(taskId))?.state;
    if (state && isReviewState(state)) {
      const failures = (await this.reviews.failures(taskId)) + 1;
      if (failures >= REVIEW_FAILURE_LIMIT) {
        await this.reviews.clearFailures(taskId);
        return this.applyTransition(
          taskId,
          "hold",
          { reason: reviewFailureReason(state, findings) },
          by,
        );
      }
      await this.reviews.setFailures(taskId, failures);
    }
    return this.applyTransition(taskId, "feedback", { findings }, by);
  }

  async teardown(task: TaskMeta): Promise<void> {
    const workspace = task.workspace;
    if (!workspace) {
      return;
    }

    await this.workspaces.remove(workspace.worktree);
    if (await this.workspaces.branchExists(workspace.branch)) {
      await this.workspaces.deleteBranch(workspace.branch);
    }
  }

  rows(snapshot: Snapshot): TaskRow[] {
    return taskRows(
      snapshot.tasks,
      snapshot.blocking,
      this.recent,
      this.closed,
    );
  }

  private async remember(
    taskId: TaskId,
    tasks: Map<TaskId, TaskMeta>,
  ): Promise<void> {
    const { recent, discards } = keepRecent(
      taskId,
      this.recent,
      new Set(tasks.keys()),
    );
    this.recent = recent;

    for (const dropped of discards) {
      this.closed.delete(dropped);
      await this.paths.discard(dropped);
    }
  }
}
