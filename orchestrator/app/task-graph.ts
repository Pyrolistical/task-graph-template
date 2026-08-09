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

  rememberMostRecent(): void {
    const sorted = [...this.list().values()].sort((a, b) =>
      (b.state_entered ?? "").localeCompare(a.state_entered ?? ""),
    );
    for (const task of sorted.slice(0, RECENT_TASKS)) {
      this.recent.push(task.id);
    }
  }

  list(): Map<TaskId, TaskMeta> {
    const { tasks, problems } = this.tasks.list();

    for (const [filePath, message] of problems) {
      if (this.problems.get(filePath) !== message) {
        this.publisher.log(`ignoring ${filePath}: ${message}`);
      }
    }
    for (const filePath of this.problems.keys()) {
      if (!problems.has(filePath)) {
        this.publisher.log(`${filePath} parses again`);
      }
    }
    this.problems = problems;
    this.reportCycles(tasks);

    return tasks;
  }

  private reportCycles(tasks: Map<TaskId, TaskMeta>): void {
    const cycling = new Set(detectCycles(tasks));

    for (const id of cycling) {
      if (!this.cycling.has(id)) {
        this.publisher.log(
          `task ${id} depends on itself through ${tasks.get(id)?.depends_on.join(", ")}; it can never unblock`,
        );
      }
    }
    this.cycling = cycling;
  }

  snapshot(): Snapshot {
    const tasks = this.list();
    return { tasks, blocking: blockingCounts(tasks) };
  }

  read(taskId: TaskId): TaskMeta | null {
    return this.tasks.read(taskId);
  }

  body(taskId: TaskId): string {
    return this.tasks.body(taskId);
  }

  create(title: string): CreatedTask {
    return this.tasks.create(title);
  }

  writeBody(taskId: TaskId, body: string): string {
    return this.tasks.writeBody(taskId, body);
  }

  claim(taskId: TaskId, args: ClaimArgs): void {
    this.tasks.claim(taskId, args);
    this.remember(taskId, this.list());
  }

  releaseClaim(taskId: TaskId): void {
    this.tasks.releaseClaim(taskId);
    this.remember(taskId, this.list());
  }

  transition(
    taskId: TaskId,
    name: TransitionName,
    args: TransitionArgs,
    by: string,
  ): TransitionResult {
    const tasks = this.list();
    const before = tasks.get(taskId);
    const result = this.tasks.apply(taskId, name, args);
    if (name === "submit" && isReviewState(result.from)) {
      this.reviews.clearFailures(taskId);
    }
    const to = result.to ?? before?.state ?? "NEW";

    if (to === "CLOSED" && before !== undefined) {
      this.closed.set(taskId, {
        ...taskRow(before, blockingCounts(tasks).get(taskId) ?? 0),
        state: "CLOSED",
        state_entered: new Date().toISOString(),
        claimed_by: null,
        worktree: null,
      });
      this.teardown(before);
      this.paths.discard(taskId);
    }

    this.transitions.append({
      task_id: taskId,
      transition: name,
      from: result.from,
      to,
      by,
    });
    this.remember(taskId, tasks);
    return result;
  }

  feedback(taskId: TaskId, findings: string[], by: string): TransitionResult {
    this.reviews.setFindings(taskId, findings);
    const state = this.tasks.read(taskId)?.state;
    if (state !== undefined && isReviewState(state)) {
      const failures = this.reviews.failures(taskId) + 1;
      if (failures >= REVIEW_FAILURE_LIMIT) {
        this.reviews.clearFailures(taskId);
        return this.transition(
          taskId,
          "hold",
          { reason: reviewFailureReason(state, findings) },
          by,
        );
      }
      this.reviews.setFailures(taskId, failures);
    }
    return this.transition(taskId, "feedback", { findings }, by);
  }

  teardown(task: TaskMeta): void {
    const workspace = task.workspace;
    if (workspace === null) {
      return;
    }

    this.workspaces.remove(workspace.worktree);
    if (this.workspaces.branchExists(workspace.branch)) {
      this.workspaces.deleteBranch(workspace.branch);
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

  private remember(taskId: TaskId, tasks: Map<TaskId, TaskMeta>): void {
    const at = this.recent.indexOf(taskId);
    if (at !== -1) {
      this.recent.splice(at, 1);
    }
    this.recent.unshift(taskId);

    for (const dropped of this.recent.splice(RECENT_TASKS)) {
      if (!tasks.has(dropped)) {
        this.closed.delete(dropped);
        this.paths.discard(dropped);
      }
    }
  }
}
