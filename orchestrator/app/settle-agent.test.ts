import { describe, expect, test } from "bun:test";
import { Pool } from "./pool.ts";
import { SettleAgent } from "./settle-agent.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeAssignments,
  FakeInbox,
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
  const git = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const paths = fakePaths();
  const assignments = new FakeAssignments();
  assignments.write(task.id, live);

  const graph = new TaskGraph(
    store,
    git,
    new FakeInbox(),
    new FakeJournal(),
    publisher,
    paths,
  );
  const prompted: string[] = [];
  const pool = new Pool(
    fakeAgents([aSlot()]),
    git,
    paths,
    publisher,
    () => false,
  );
  const settle = new SettleAgent(
    graph,
    pool,
    assignments,
    new FakeInbox(),
    new FakePrompts(),
    publisher,
    git,
    "master",
  );

  const worker = pool.worker("pi-fake-fake-1");
  worker.state = "BUSY";
  worker.task_id = task.id;
  worker.stage = "WORK";
  worker.role = "worker";
  worker.checkout = {
    branch: "task/000042",
    worktree: "/runtime/000042/worktree",
    head: "abc1234",
    dispatched: DISPATCHED,
  };
  worker.process = aSession({ kind: "none" }, true, prompted);

  return { settle, pool, worker, store, assignments, prompted, publisher };
}

describe("Feature: what the server does with a settled turn", () => {
  test("an agent that ended without a result is prompted again", async () => {
    // Given an agent whose turn ended without calling a result tool
    const { settle, worker, prompted, store } = aRig();

    // When the server settles that turn
    await settle.settled(worker);

    // Then it is prompted with the issue rather than the task being moved
    expect(prompted).toEqual(["issue:missing-result:WORK:{}"]);
    expect(store.applied).toEqual([]);
  });

  test("an agent that keeps ending without a result has its task held", async () => {
    // Given an agent that has already used every attempt it is given
    const { settle, worker, store } = aRig();
    worker.issues.set("missing-result", ISSUES["missing-result"].attempts);

    // When the server settles another turn with no result in it
    await settle.settled(worker);

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
    const { settle, pool, worker } = aRig();
    worker.issues.set("missing-result", ISSUES["missing-result"].attempts);

    // When the server settles another turn with no result in it
    await settle.settled(worker);

    // Then the slot goes back to idle rather than being left holding the task
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });

  test("an assignment the agent may not have changed is put back", async () => {
    // Given an agent that rewrote the part of the assignment it was given
    const { settle, worker, assignments, prompted } = aRig(
      "the goal, rewritten\n\n## Implementation Notes\n\nI did the work\n",
    );
    worker.results = [{ tool: "submit", args: {} }];

    // When the server settles that turn
    await settle.settled(worker);

    // Then what it changed is restored and only its own section survives
    expect(assignments.read("000042")).toBe(
      "the goal\n\n## Implementation Notes\n\nI did the work\n",
    );

    // Then it is prompted about the rule it broke rather than the task moving
    expect(prompted).toEqual(["issue:modified-assignment:WORK:{}"]);
  });

  test("an agent whose process died is finished with, not prompted", async () => {
    // Given an agent whose process exited without settling its turn
    const { settle, pool, worker, prompted } = aRig();
    worker.process = aSession({ kind: "none" }, false);

    // When the server settles that turn
    await settle.settled(worker);

    // Then nothing is asked of it and the slot goes back to idle
    expect(prompted).toEqual([]);
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });
});
