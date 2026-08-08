import { describe, expect, test } from "bun:test";
import { Pool } from "./pool.ts";
import { Settler } from "./settler.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeAssignments,
  FakeTaskFiles,
  FakeJournal,
  FakePrompts,
  FakePublisher,
  FakeTasks,
  FakeWorkspaces,
  aSession,
  aSlot,
  aTask,
  fakeAgents,
  fakePaths,
} from "../testing/ports.ts";
import { ISSUES } from "../domain/issues.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

const DISPATCHED = "the goal\n\n## Implementation Notes\n";

function aRig(live = DISPATCHED) {
  const task: TaskMeta = aTask({
    claimed_by: "pi-fake-fake-1",
    claimed_pid: 4242,
  });
  const store = new FakeTasks(new Map<TaskId, TaskMeta>([[task.id, task]]));
  const workspaces = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const paths = fakePaths();
  const assignments = new FakeAssignments();
  assignments.write(task.id, live);

  const graph = new TaskGraph(
    store,
    workspaces,
    new FakeTaskFiles(),
    new FakeJournal(),
    publisher,
    paths,
  );
  const prompted: string[] = [];
  const pool = new Pool(
    fakeAgents([aSlot()]),
    workspaces,
    paths,
    publisher,
    () => false,
  );
  const settler = new Settler(
    graph,
    pool,
    assignments,
    new FakeTaskFiles(),
    new FakePrompts(),
    publisher,
    workspaces,
    "master",
  );

  const runner = pool.runner("pi-fake-fake-1");
  runner.state = "BUSY";
  runner.taskId = task.id;
  runner.taskState = "WORK";
  runner.role = "worker";
  runner.checkout = {
    branch: "task/000042",
    worktree: "/runtime/000042/worktree",
    head: "abc1234",
    dispatched: DISPATCHED,
  };
  runner.process = aSession({ kind: "none" }, true, prompted);

  return { settler, pool, runner, store, assignments, prompted, publisher };
}

describe("Feature: what the server does with a settled turn", () => {
  test("an agent that ended without a result is prompted again", async () => {
    // Given an agent whose turn ended without calling a result tool
    const { settler, runner, prompted, store } = aRig();

    // When the server settles that turn
    await settler.settle(runner);

    // Then it is prompted with the issue rather than the task being moved
    expect(prompted).toEqual(["issue:missing-result:WORK:{}"]);
    expect(store.applied).toEqual([]);
  });

  test("an agent that keeps ending without a result has its task held", async () => {
    // Given an agent that has already used every attempt it is given
    const { settler, runner, store } = aRig();
    runner.issues.set("missing-result", ISSUES["missing-result"].attempts);

    // When the server settles another turn with no result in it
    await settler.settle(runner);

    // Then the task is held for a person, saying what the agent never did
    expect(store.applied).toEqual([
      {
        id: "000042",
        name: "hold",
        args: {
          reason: "the agent stopped without calling a submit or blocked tool",
        },
      },
    ]);
  });

  test("a held task frees the slot that was working on it", async () => {
    // Given an agent that has already used every attempt it is given
    const { settler, pool, runner } = aRig();
    runner.issues.set("missing-result", ISSUES["missing-result"].attempts);

    // When the server settles another turn with no result in it
    await settler.settle(runner);

    // Then the slot goes back to idle rather than being left holding the task
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });

  test("an assignment the agent may not have changed is put back", async () => {
    // Given an agent that rewrote the part of the assignment it was given
    const { settler, runner, assignments, prompted } = aRig(
      "the goal, rewritten\n\n## Implementation Notes\n\nI did the work\n",
    );
    runner.results = [{ tool: "submit", args: {} }];

    // When the server settles that turn
    await settler.settle(runner);

    // Then what it changed is restored and only its own section survives
    expect(assignments.read("000042")).toBe(
      "the goal\n\n## Implementation Notes\n\nI did the work\n",
    );

    // Then it is prompted about the rule it broke rather than the task moving
    expect(prompted).toEqual(["issue:modified-assignment:WORK:{}"]);
  });

  test("an agent whose process died is finished with, not prompted", async () => {
    // Given an agent whose process exited without settling its turn
    const { settler, pool, runner, prompted } = aRig();
    runner.process = aSession({ kind: "none" }, false);

    // When the server settles that turn
    await settler.settle(runner);

    // Then nothing is asked of it and the slot goes back to idle
    expect(prompted).toEqual([]);
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });
});
