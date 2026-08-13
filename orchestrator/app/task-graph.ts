import type { Awaitable } from "../domain/awaitable.ts";
import type { Paths } from "./ports/paths.ts";
import type { Publisher } from "./ports/publisher.ts";
import type { Reviews } from "./ports/reviews.ts";
import type { ClaimArgs, CreatedTask, Tasks } from "./ports/tasks.ts";
import type { Transitions } from "./ports/transitions.ts";
import type { Workspaces } from "./ports/workspaces.ts";
import {
  type TaskRow,
  RECENT_TASKS,
  blockingCounts,
  taskRow,
  taskRows,
} from "../domain/graph.ts";
import type { Cost } from "../domain/costs.ts";
import { type TaskId, type TaskMeta, detectCycles } from "../domain/task.ts";
import {
  type TaskState,
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  REVIEW_FAILURE_LIMIT,
  isReviewState,
} from "../domain/state-machine.ts";

function reviewFailureReason(state: TaskState, findings: string[]): string {
  const bullets = findings.map((finding) => `- ${finding}`).join("\n");
  return `failed ${REVIEW_FAILURE_LIMIT} rounds of ${state} with:\n${bullets}`;
}

export interface Snapshot {
  tasks: Map<TaskId, TaskMeta>;
  blocking: Map<TaskId, number>;
}

export class TaskGraph {
  private readonly recent: TaskId[] = [];
  private readonly closed = new Map<TaskId, TaskRow>();
  private problems = new Map<string, string>();
  private cycling = new Set<TaskId>();

  constructor(
    private readonly tasks: Tasks,
    private readonly workspaces: Workspaces,
    private readonly reviews: Reviews,
    private readonly transitions: Transitions,
    private readonly publisher: Publisher,
    private readonly paths: Paths,
  ) {}

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
        await this.publisher.log(`ignoring ${filePath}: ${message}`);
      }
    }
    for (const filePath of this.problems.keys()) {
      if (!problems.has(filePath)) {
        await this.publisher.log(`${filePath} parses again`);
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
        await this.publisher.log(
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

  create(title: string): Awaitable<CreatedTask> {
    return this.tasks.create(title);
  }

  writeBody(taskId: TaskId, body: string): Awaitable<string> {
    return this.tasks.writeBody(taskId, body);
  }

  async claim(taskId: TaskId, args: ClaimArgs): Promise<void> {
    await this.tasks.claim(taskId, args);
    await this.remember(taskId, await this.list());
  }

  recordCost(taskId: TaskId, cost: Cost, resumed: boolean): Awaitable<void> {
    return this.tasks.recordCost(taskId, cost, resumed);
  }

  async releaseClaim(taskId: TaskId): Promise<void> {
    await this.tasks.releaseClaim(taskId);
    await this.remember(taskId, await this.list());
  }

  async transition(
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
    const to = result.to ?? before?.state ?? "NEW";

    if (to === "CLOSED" && before) {
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
      to,
      by,
    });
    await this.remember(taskId, tasks);
    return result;
  }

  async feedback(
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
        return this.transition(
          taskId,
          "hold",
          { reason: reviewFailureReason(state, findings) },
          by,
        );
      }
      await this.reviews.setFailures(taskId, failures);
    }
    return this.transition(taskId, "feedback", { findings }, by);
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
    const at = this.recent.indexOf(taskId);
    if (at !== -1) {
      this.recent.splice(at, 1);
    }
    this.recent.unshift(taskId);

    for (const dropped of this.recent.splice(RECENT_TASKS)) {
      if (!tasks.has(dropped)) {
        this.closed.delete(dropped);
        await this.paths.discard(dropped);
      }
    }
  }
}
