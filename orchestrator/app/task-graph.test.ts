import { describe, expect, test } from "bun:test";
import { TaskGraph } from "./task-graph.ts";
import {
  FakePublisher,
  FakeTaskFiles,
  FakeTasks,
  FakeTransitions,
  FakeWorkspaces,
  aTask,
  fakePaths,
} from "../testing/ports.ts";
import { REVIEW_FAILURE_LIMIT } from "../domain/state-machine.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

function aRig(state: TaskMeta["state"]) {
  const task = aTask({ state });
  const store = new FakeTasks(new Map<TaskId, TaskMeta>([[task.id, task]]));
  const reviews = new FakeTaskFiles();
  const graph = new TaskGraph(
    store,
    new FakeWorkspaces(),
    reviews,
    new FakeTransitions(),
    new FakePublisher(),
    fakePaths(),
  );
  return { graph, store, reviews, task };
}

describe("Feature: counting the rounds a review has sent work back", () => {
  test("the round that reaches the limit parks the task", async () => {
    // Given a task under review, one round short of the limit that holds it
    expect(REVIEW_FAILURE_LIMIT).toBe(2);
    const { graph, store, task } = aRig("WORK_REVIEW");
    await graph.feedback(task.id, ["the tests do not run"], "pi-1");

    // When a second reviewer sends it back
    await graph.feedback(task.id, ["the tests still do not run"], "pi-2");

    // Then the second round takes it past the limit and parks it
    expect(store.applied.map((one) => one.name)).toEqual(["feedback", "hold"]);
  });

  test("a round that is not a review is never counted", async () => {
    // Given a task the manager is sending back from outside a review state
    const { graph, reviews, task } = aRig("MANAGER_REVIEW");
    await graph.feedback(task.id, ["needs a rethink"], "manager");

    // When a second round of feedback arrives
    await graph.feedback(task.id, ["still needs a rethink"], "manager");

    // Then nothing was counted against it, because only reviews count
    expect(await reviews.failures(task.id)).toBe(0);
  });
});
