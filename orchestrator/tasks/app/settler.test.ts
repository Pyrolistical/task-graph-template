import { describe, expect, test } from "bun:test";
import { type Run, Pool } from "../../agents/app/pool.ts";
import { Settler } from "./settler.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeAssignments,
  FakeTaskFiles,
  FakeTransitions,
  FakePrompts,
  fakeLog,
  FakeTasks,
  FakeWorkspaces,
  aCheckout,
  aRun,
  aSession,
  aSlot,
  aTask,
  fakeAgents,
  fakePaths,
} from "../../testing/ports.ts";
import type { SlotRow } from "../../views/slots.ts";
import { BACKOFF_CAP_MS } from "../../agents/domain/backoff.ts";
import { type IssueName, ISSUES } from "../../prompting/domain/issues.ts";
import type { Activity } from "../../views/activity.ts";
import type { StreamState } from "../../agents/domain/protocol.ts";
import type { ResultCall } from "../../agents/domain/results.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";
import { at } from "../../testing/present.ts";

const DISPATCHED = "the goal\n\n## Implementation Notes\n";

async function aRig(
  live = DISPATCHED,
  alive = true,
  results: ResultCall[] = [],
  stream: Partial<StreamState> = {},
  activity: Activity = { kind: "none" },
) {
  const task: TaskMeta = aTask({
    claimed_by: "pi-fake-fake-1",
    claimed_pid: 4242,
  });
  const store = new FakeTasks(new Map<TaskId, TaskMeta>([[task.id, task]]));
  const workspaces = new FakeWorkspaces();
  const { log } = fakeLog();
  const paths = fakePaths();
  const assignments = new FakeAssignments();
  await assignments.write(task.id, live);

  const graph = new TaskGraph(
    store,
    workspaces,
    new FakeTaskFiles(),
    new FakeTransitions(),
    log,
    paths,
  );
  const prompted: string[] = [];
  const pool = new Pool(
    fakeAgents(
      [aSlot()],
      () => aSession(activity, alive, prompted, {}, stream),
      () => undefined,
      results,
    ),
    workspaces,
    log,
    () => false,
    (id, cost, resumed) => graph.recordCost(id, cost, resumed),
  );
  const settler = new Settler({
    graph,
    pool,
    assignments,
    reviews: new FakeTaskFiles(),
    prompts: new FakePrompts(),
    log,
    workspaces,
    base: "master",
  });

  const run = await aRun(
    pool,
    {
      slotName: "pi-fake-fake-1",
      taskId: task.id,
      state: "WORK",
      role: "worker",
    },
    "/sessions/000042.jsonl",
    aCheckout({ dispatched: DISPATCHED }),
  );

  const settle = (): Promise<void> => settler.settle(run);
  const rowOf = (): SlotRow => at(pool.rows(), 0);

  return {
    settle,
    settler,
    rowOf,
    pool,
    run,
    store,
    assignments,
    prompted,
  };
}

function anAbortedRig(): ReturnType<typeof aRig> {
  return aRig(
    DISPATCHED,
    true,
    [],
    { stopReason: "aborted" },
    { kind: "tool-call", tool: "bash", target: "sleep 600", started_at: 0 },
  );
}

function exhausted(pool: Pool, run: Run, issue: IssueName): void {
  for (let used = 0; used < ISSUES[issue].attempts; used++) {
    pool.raised(run, issue);
  }
}

describe("Feature: what the server does with a settled turn", () => {
  test("an agent that ended without a result is prompted again", async () => {
    // Given an agent whose turn ended without calling a result tool
    const { settle, prompted, store } = await aRig();

    // When the server settles that turn
    await settle();

    // Then it is prompted with the issue rather than the task being moved
    expect(prompted).toEqual(["issue:missing-result:WORK:{}"]);
    expect(store.applied).toEqual([]);
  });

  test("an agent that keeps ending without a result has its task held", async () => {
    // Given an agent that has already used every attempt it is given
    const { settle, pool, run, store } = await aRig();
    exhausted(pool, run, "missing-result");

    // When the server settles another turn with no result in it
    await settle();

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
    const { settle, pool, run } = await aRig();
    exhausted(pool, run, "missing-result");

    // When the server settles another turn with no result in it
    await settle();

    // Then the slot goes back to idle rather than being left holding the task
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });

  test("an assignment the agent may not have changed is put back", async () => {
    // Given an agent that rewrote the part of the assignment it was given
    const { settle, assignments, prompted } = await aRig(
      "the goal, rewritten\n\n## Implementation Notes\n\nI did the work\n",
      true,
      [{ tool: "submit", args: {} }],
    );

    // When the server settles that turn
    await settle();

    // Then what it changed is restored and only its own section survives
    expect(await assignments.read("000042")).toBe(
      "the goal\n\n## Implementation Notes\n\nI did the work\n",
    );

    // Then it is prompted about the rule it broke rather than the task moving
    expect(prompted).toEqual(["issue:modified-assignment:WORK:{}"]);
  });

  test("an agent whose process died is finished with, not prompted", async () => {
    // Given an agent whose process exited without settling its turn
    const { settle, pool, prompted } = await aRig(DISPATCHED, false);

    // When the server settles that turn
    await settle();

    // Then nothing is asked of it and the slot goes back to idle
    expect(prompted).toEqual([]);
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });
});

describe("Feature: an agent whose command was aborted", () => {
  test("the same session is told which command died, not thrown away", async () => {
    // Given an agent inside a bash call the manager aborts
    const { settle, pool, prompted, store, rowOf } = await anAbortedRig();
    await pool.abortSlot("pi-fake-fake-1");

    // When the server settles the turn the abort ended
    await settle();

    // Then it is prompted with the command it lost, and keeps its task
    expect(prompted).toEqual(['issue:aborted:WORK:{"command":"sleep 600"}']);
    expect(store.applied).toEqual([]);
    expect(rowOf().state).toBe("BUSY");
  });

  test("an agent aborted once too often has its task held", async () => {
    // Given an agent that has already used every abort it is given
    const { settle, pool, run, store } = await anAbortedRig();
    exhausted(pool, run, "aborted");
    await pool.abortSlot("pi-fake-fake-1");

    // When the server settles another aborted turn
    await settle();

    // Then the task is held for a person, naming the command that died
    expect(store.applied).toEqual([
      {
        id: "000042",
        name: "hold",
        args: {
          reason: ISSUES.aborted.held("sleep 600"),
        },
      },
    ]);
  });
});

describe("Feature: a provider that is not answering", () => {
  test("a turn that ends on a provider error leaves the slot waiting, not sleeping", async () => {
    // Given an agent whose turn ended on an error from its provider
    const { settle, rowOf, prompted } = await aRig(DISPATCHED, true, [], {
      stopReason: "error",
      errorMessage: "502 bad gateway",
    });

    // When the server settles that turn
    await settle();

    // Then the slot is parked with the time it will retry, and nothing was asked of it yet
    expect(rowOf().state).toBe("WAITING");
    expect(rowOf().retry?.attempt).toBe(1);
    expect(prompted).toEqual([]);
  });

  test("the tick that finds the wait over prompts the same session again", async () => {
    // Given a slot waiting out a provider error
    const { settle, settler, rowOf, prompted } = await aRig(
      DISPATCHED,
      true,
      [],
      { stopReason: "error", errorMessage: "502 bad gateway" },
    );
    await settle();

    // When a tick comes round after the time it named
    await settler.retryDue(Date.now() + BACKOFF_CAP_MS);

    // Then it is prompted with its assignment again, on the slot it never left
    expect(prompted).toEqual(["prompt:WORK"]);
    expect(rowOf().state).toBe("BUSY");
  });

  test("a wait that is not over yet is left alone", async () => {
    // Given a slot waiting out a provider error
    const { settle, settler, rowOf, prompted } = await aRig(
      DISPATCHED,
      true,
      [],
      { stopReason: "error", errorMessage: "502 bad gateway" },
    );
    await settle();

    // When a tick comes round before the time it named
    await settler.retryDue(Date.now());

    // Then nothing is asked of it, because the provider has not been given its second
    expect(prompted).toEqual([]);
    expect(rowOf().state).toBe("WAITING");
  });
});
