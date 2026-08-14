import { describe, expect, test } from "bun:test";
import { at } from "../../testing/present.ts";
import { blockingCounts } from "../../vocabulary/blocking.ts";
import { type TaskMeta } from "../../vocabulary/task.ts";
import { inbox } from "./inbox.ts";

describe("Feature: what is waiting on the manager", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "NEW",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: undefined,
      claimed_pid: undefined,
      held_reason: undefined,
      workspace: undefined,
      checks: [],
      costs: [],
      ...overrides,
    };
  }

  function graph(...tasks: TaskMeta[]): Map<string, TaskMeta> {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  function inboxOf(tasks: Map<string, TaskMeta>) {
    return inbox(tasks, blockingCounts(tasks));
  }

  test("what is closest to closed comes first", () => {
    // Given a new task, two held ones and a task waiting on the manager
    const tasks = graph(
      task({ id: "000001", state: "NEW" }),
      task({ id: "000002", state: "HELD_WORK", held_reason: "a wall" }),
      task({ id: "000003", state: "HELD_PLAN", held_reason: "no plan" }),
      task({ id: "000005", state: "MANAGER_REVIEW" }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the manager sees what is nearest to done at the top of it
    expect(rows.map((row) => row.task_id)).toEqual([
      "000005",
      "000003",
      "000002",
      "000001",
    ]);
    expect(rows.map((row) => row.rank)).toEqual([
      "MANAGER_REVIEW",
      "HELD_PLAN",
      "HELD_WORK",
      "NEW",
    ]);
  });

  test("only what is actually waiting on a person is in the inbox", () => {
    // Given tasks that are queued, running, reviewable by an agent, or blocked
    const tasks = graph(
      task({ id: "000001", state: "WORK" }),
      task({ id: "000002", state: "WORK", claimed_by: "pi-1", claimed_pid: 1 }),
      task({ id: "000003", state: "WORK_REVIEW" }),
      task({ id: "000004", state: "BLOCKED_DESIGN", depends_on: ["000001"] }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then none of them appears, because the pipeline can move them all itself
    expect(rows).toEqual([]);
  });

  test("within a rank the task blocking the most goes first", () => {
    // Given two tasks waiting on the manager, one of them holding up a third
    const tasks = graph(
      task({ id: "000001", state: "MANAGER_REVIEW" }),
      task({ id: "000002", state: "MANAGER_REVIEW" }),
      task({ id: "000003", state: "BLOCKED_DESIGN", depends_on: ["000002"] }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the one unblocking other work is what the manager is shown first
    expect(rows.map((row) => row.task_id)).toEqual(["000002", "000001"]);
    expect(at(rows, 0).blocking).toBe(1);
  });

  test("a held row carries the reason the manager has to answer", () => {
    // Given a task held on something only a person can resolve
    const tasks = graph(
      task({
        id: "000001",
        state: "HELD_WORK",
        held_reason: "the staging database is down",
        state_entered: "2026-07-29T01:00:00Z",
      }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the row says what it is waiting on and since when
    expect(at(rows, 0).held_reason).toBe("the staging database is down");
    expect(at(rows, 0).waiting_since).toBe("2026-07-29T01:00:00Z");
  });

  test("a row names the branch to look at, not the worktree it was built in", () => {
    // Given a task waiting on the manager, with a workspace behind it
    const tasks = graph(
      task({
        id: "000001",
        state: "MANAGER_REVIEW",
        workspace: {
          branch: "work/000001",
          worktree: "/tmp/orchestrator/000001/worktree",
          slot: "pi-1",
          session: undefined,
        },
      }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the manager is pointed at the branch, which is what outlives the run
    expect(at(rows, 0).branch).toBe("work/000001");
    expect(rows[0]).not.toHaveProperty("worktree");
  });
});
