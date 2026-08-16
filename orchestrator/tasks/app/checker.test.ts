import { describe, expect, test } from "bun:test";
import { Checker } from "./checker.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeChecks,
  FakePrompts,
  fakeLog,
  FakeTaskFiles,
  FakeTasks,
  FakeTransitions,
  FakeWorkspaces,
  aTask,
  fakePaths,
} from "../../testing/ports.ts";
import type { TransitionResult } from "../../vocabulary/state-machine.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";

class RefusingTasks extends FakeTasks {
  override apply(): Promise<TransitionResult> {
    return Promise.reject(
      new Error(`Task "000042" is in HELD_WORK, which cannot pass`),
    );
  }
}

function aRig(store: FakeTasks) {
  const { log, lines } = fakeLog();
  const graph = new TaskGraph({
    tasks: store,
    workspaces: new FakeWorkspaces(),
    reviews: new FakeTaskFiles(),
    transitions: new FakeTransitions(),
    log,
    paths: fakePaths(),
  });
  const checker = new Checker({
    graph,
    checks: new FakeChecks(),
    messages: new FakeTaskFiles(),
    prompts: new FakePrompts(),
    log,
    repo: "/repo",
  });

  const runChecks = async (task: TaskMeta): Promise<void> => {
    checker.start(new Map([[task.id, task]]));
    await checker.settled();
  };

  return { checker, runChecks, log: lines };
}

const CHECKING = aTask({ state: "CHECK", checks: ["bun test"] });

describe("Feature: a check run that cannot finish", () => {
  test("a task that vanishes mid-run is logged, not thrown into the void", async () => {
    // Given a task in CHECK whose document has gone by the time the run starts
    const { runChecks, log } = aRig(new FakeTasks(new Map()));

    // When the checker runs it
    await runChecks(CHECKING);

    // Then the failure is on the server log rather than an unhandled rejection
    expect(log).toEqual([
      `the checks for 000042 could not run: task "000042" vanished before its checks could run`,
    ]);
  });

  test("a transition the graph refuses is logged", async () => {
    // Given a task whose checks pass, but which has left CHECK by the time they do
    const store = new RefusingTasks(
      new Map<TaskId, TaskMeta>([[CHECKING.id, CHECKING]]),
    );
    const { runChecks, log } = aRig(store);

    // When the checker runs it and its queued transition is refused
    await runChecks(CHECKING);

    // Then that too is logged rather than left to crash the server
    expect(log).toEqual([
      `the checks for 000042 could not run: Task "000042" is in HELD_WORK, which cannot pass`,
    ]);
  });

  test("a run is only forgotten once its transition has landed", async () => {
    // Given a task in CHECK whose checks all pass
    const store = new FakeTasks(
      new Map<TaskId, TaskMeta>([[CHECKING.id, CHECKING]]),
    );
    const { checker, runChecks } = aRig(store);

    // When the checker runs it through to its queued transition
    const running = runChecks(CHECKING);

    // Then it reads as running until the transition lands, so no tick restarts it
    expect(checker.isRunning(CHECKING.id)).toBe(true);
    await running;
    expect(store.applied.map((one) => one.name)).toEqual(["pass"]);
    expect(checker.isRunning(CHECKING.id)).toBe(false);
  });
});
