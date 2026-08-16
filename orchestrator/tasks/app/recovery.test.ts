import { describe, expect, test } from "bun:test";
import { Pool } from "../../agents/app/pool.ts";
import { Recovery } from "./recovery.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeTaskFiles,
  FakeTransitions,
  FakePublisher,
  fakeLog,
  FakeTasks,
  FakeWorkspaces,
  aRun,
  aSession,
  aSlot,
  aTask,
  fakeAgents,
  fakePaths,
} from "../../testing/ports.ts";
import type { Reservation } from "../../testing/ports.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";
import { at } from "../../testing/present.ts";

const DEAD_PID = 9001;
const LIVE_PID = 9002;
const A_SESSION = "/sessions/000042.jsonl";

function aReservation(taskId: TaskId): Reservation {
  return {
    slotName: "pi-fake-fake-1",
    taskId,
    state: "WORK",
    role: "worker",
  };
}

function aRig(tasks: TaskMeta[], slots = [aSlot()], alive = true) {
  const byId = new Map<TaskId, TaskMeta>(tasks.map((task) => [task.id, task]));
  const store = new FakeTasks(byId);
  const workspaces = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const { log, lines } = fakeLog();
  const paths = fakePaths();

  const graph = new TaskGraph({
    tasks: store,
    workspaces,
    reviews: new FakeTaskFiles(),
    transitions: new FakeTransitions(),
    log,
    paths,
  });
  const pool = new Pool({
    agents: fakeAgents(slots, () => aSession({ kind: "none" }, alive)),
    workspaces,
    log,
    alive: (pid) => pid === LIVE_PID,
    costs: (id, cost, resumed) => graph.recordCost(id, cost, resumed),
  });
  const recover = new Recovery({
    graph,
    pool,
    workspaces,
    paths,
    publisher,
    log,
    alive: (pid) => pid === LIVE_PID,
    base: "master",
  });

  return { recover, pool, workspaces, store, log: lines, publisher };
}

describe("Feature: reaping claims whose process is gone", () => {
  test("a claim held by a dead process is released", async () => {
    // Given a task claimed by an agent whose process has exited
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, store } = aRig([task]);

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then the claim is cleared, putting the task back in the queue where it stands
    expect(store.released).toEqual(["000042"]);
  });

  test("a claim held by a live process is left alone", async () => {
    // Given a task claimed by an agent that is still running
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: LIVE_PID,
    });
    const { recover, store } = aRig([task]);

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then nothing is released, because the agent is still working
    expect(store.released).toEqual([]);
  });

  test("a slot whose own process is alive shields its task from the reaper", async () => {
    // Given a task whose recorded pid is gone
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, pool, store } = aRig([task]);

    // Given the slot holding it still has a live process of its own
    await aRun(pool, aReservation(task.id), A_SESSION);

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then the claim is left alone, because the agent is still running
    expect(store.released).toEqual([]);
  });

  test("a slot that still holds a dead process is left to the settler", async () => {
    // Given a task whose recorded pid is gone
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: undefined,
      },
    });
    const { recover, pool, store, workspaces } = aRig([task], [aSlot()], false);
    workspaces.present.add("/runtime/000042/worktree");

    // Given the slot holding it kept the process that has already exited
    await aRun(pool, aReservation(task.id), A_SESSION);

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then it drops neither the claim nor the harvest onto the settler's turn
    expect(store.released).toEqual([]);
    expect(workspaces.harvested).toEqual([]);
  });

  test("a slot the settler has released stops shielding its task", async () => {
    // Given a task whose recorded pid is gone
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, pool, store } = aRig([task]);

    // Given the settler has finished with the slot and handed it back
    await aRun(pool, aReservation(task.id), A_SESSION);
    await pool.release("pi-fake-fake-1");

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then the claim is released and the slot goes back to idle
    expect(store.released).toEqual(["000042"]);
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });

  test("what a reaped agent drew from the wall is billed to its task", async () => {
    // Given a task claimed by a detached agent whose process has since exited
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, pool, store } = aRig(
      [task],
      [aSlot({ wattage: 300, costPerKwh: 0.2 })],
    );

    // Given the slot was reattached to an hour ago and priced by nobody
    pool.reattach(
      {
        name: at(pool.rows(), 0).name,
        task_id: task.id,
        role: "worker",
        pid: DEAD_PID,
        started_at: new Date(Date.now() - 3600000).toISOString(),
        session: A_SESSION,
      },
      "WORK",
    );

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then the hour it ran is on the task, because a detached run still costs power
    expect(store.costs).toEqual([
      {
        id: "000042",
        cost: {
          state: "WORK",
          slot: "pi-fake-fake-1",
          seconds: 3600,
          cost: 0.06,
        },
        resumed: false,
      },
    ]);
  });

  test("the work a reaped agent committed is harvested onto its branch", async () => {
    // Given a dead agent's task with a workspace still on disk
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: undefined,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.present.add("/runtime/000042/worktree");

    // When the reaper runs over the graph
    await recover.reap(new Map([[task.id, task]]));

    // Then the commits in the worktree are harvested before the claim is dropped
    expect(workspaces.harvested).toEqual(["/runtime/000042/worktree"]);
  });
});

describe("Feature: picking the pool back up after a restart", () => {
  test("a slot whose pid is still alive is left running", async () => {
    // Given a published view naming a slot that is still running a task
    const { recover, pool, publisher, log } = aRig([]);
    publisher.rows = [
      {
        name: at(pool.rows(), 0).name,
        task_id: "000042",
        role: "worker",
        pid: LIVE_PID,
        started_at: "2026-07-29T00:00:00Z",
        session: "/sessions/000042.jsonl",
      },
    ];

    // When the server reattaches to what the last one left behind
    await recover.reattach();

    // Then the slot is taken as busy on that task rather than dispatched again
    const row = at(pool.rows(), 0);
    expect(row.state).toBe("BUSY");
    expect(row.task_id).toBe("000042");
    expect(log).toEqual([
      `pi-fake-fake-1 is still running 000042 as pid ${LIVE_PID}; leaving it alone`,
    ]);
  });

  test("a slot picked back up knows which state it is running", async () => {
    // Given a task in WORK whose agent outlived the server that dispatched it
    const task = aTask({
      state: "WORK",
      claimed_by: "pi-fake-fake-1",
      claimed_pid: LIVE_PID,
    });
    const { recover, pool, publisher, store } = aRig([task]);
    publisher.rows = [
      {
        name: at(pool.rows(), 0).name,
        task_id: task.id,
        role: "worker",
        pid: LIVE_PID,
        started_at: "2026-07-29T00:00:00Z",
        session: "/sessions/000042.jsonl",
      },
    ];

    // When the server reattaches to what the last one left behind
    await recover.reattach();

    // Then the state comes off the graph, since the view does not carry it and a cost needs one
    await pool.release("pi-fake-fake-1");
    expect(store.costs.map((one) => one.cost.state)).toEqual(["WORK"]);
  });

  test("a slot whose pid is gone is left idle for the scheduler", async () => {
    // Given a published view naming a slot whose process has since exited
    const { recover, pool, publisher } = aRig([]);
    publisher.rows = [
      {
        name: at(pool.rows(), 0).name,
        task_id: "000042",
        role: "worker",
        pid: DEAD_PID,
        started_at: undefined,
        session: undefined,
      },
    ];

    // When the server reattaches to what the last one left behind
    await recover.reattach();

    // Then the slot reads idle, so the scheduler may use it again
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });

  test("no view on disk leaves every slot idle", async () => {
    // Given a first start, with no published view to read
    const { recover, pool } = aRig([]);

    // When the server reattaches to the pool it left behind
    await recover.reattach();

    // Then the whole pool is idle
    expect(pool.rows().map((row) => row.state)).toEqual(["IDLE"]);
  });
});

describe("Feature: recloning a workspace that went missing", () => {
  test("a task whose worktree is gone is recloned from its branch", async () => {
    // Given a task whose worktree is gone but whose branch survives
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: undefined,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.branches.add("task/000042");

    // When the server recovers its workspaces
    await recover.reclone();

    // Then the worktree is recloned, so the work is not lost
    expect(workspaces.created).toEqual(["/runtime/000042/worktree"]);
  });

  test("a task that lost both its worktree and its branch is only reported", async () => {
    // Given a task whose worktree and branch are both gone
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: undefined,
      },
    });
    const { recover, workspaces, log } = aRig([task]);

    // When the server recovers its workspaces
    await recover.reclone();

    // Then nothing is recloned, and the loss is written to the log
    expect(workspaces.created).toEqual([]);
    expect(log).toEqual([
      "task 000042 lost both its worktree and branch task/000042",
    ]);
  });

  test("a task whose worktree is still there is left alone", async () => {
    // Given a task whose worktree is where it was left
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: undefined,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.present.add("/runtime/000042/worktree");

    // When the server recovers its workspaces
    await recover.reclone();

    // Then nothing is recloned over it
    expect(workspaces.created).toEqual([]);
  });
});
