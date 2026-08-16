import { describe, expect, test } from "bun:test";
import { Pool } from "../../agents/app/pool.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Settler } from "./settler.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeAssignments,
  FakePrompts,
  fakeLog,
  FakeTaskFiles,
  FakeTasks,
  FakeTransitions,
  FakeWorkspaces,
  aSession,
  aSlot,
  aTask,
  fakeAgents,
  fakePaths,
} from "../../testing/ports.ts";
import { at } from "../../testing/present.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";

const QUEUED = "the manager says the null case matters";

async function aRig(task: TaskMeta) {
  const store = new FakeTasks(new Map<TaskId, TaskMeta>([[task.id, task]]));
  const workspaces = new FakeWorkspaces();
  const { log } = fakeLog();
  const paths = fakePaths();
  const assignments = new FakeAssignments();
  const files = new FakeTaskFiles();
  const prompted: string[] = [];

  const graph = new TaskGraph(
    store,
    workspaces,
    files,
    new FakeTransitions(),
    log,
    paths,
  );
  const pool = new Pool(
    fakeAgents([aSlot()], () => aSession({ kind: "none" }, true, prompted)),
    workspaces,
    log,
    () => false,
    (id, cost, resumed) => graph.recordCost(id, cost, resumed),
  );
  const settler = new Settler({
    graph,
    pool,
    assignments,
    reviews: files,
    prompts: new FakePrompts(),
    log,
    workspaces,
    base: "master",
  });
  const dispatcher = new Dispatcher({
    graph,
    pool,
    settler,
    workspaces,
    assignments,
    messages: files,
    paths,
    log,
    base: "master",
    agentsPath: "/agents.json",
  });

  await dispatcher.setEnabled(true);
  await files.queue(task.id, "WORK", QUEUED);

  return {
    prompted,
    dispatch: async () => {
      await dispatcher.run(await graph.snapshot());
    },
  };
}

describe("Feature: what a dispatched agent is prompted with", () => {
  test("a fresh session is told what was queued and then what the phase is", async () => {
    // Given a task waiting in WORK with a message queued for it
    const rig = await aRig(aTask());

    // When the scheduler dispatches it to a slot
    await rig.dispatch();

    // Then the agent is prompted with the message and the phase fragment under it
    expect(at(rig.prompted, 0)).toBe(`${QUEUED}\n\nprompt:WORK`);
  });

  test("a resumed session is told what was queued and nothing else", async () => {
    // Given the same task holding a session the pool can still reach
    const rig = await aRig(
      aTask({
        workspace: {
          branch: "task/000042",
          worktree: "/worktrees/000042",
          slot: "pi-fake-fake-1",
          session: "/sessions/000042.jsonl",
        },
      }),
    );

    // When the scheduler dispatches it to a slot
    await rig.dispatch();

    // Then the phase fragment is left out, because that session was already told it
    expect(at(rig.prompted, 0)).toBe(QUEUED);
  });
});
