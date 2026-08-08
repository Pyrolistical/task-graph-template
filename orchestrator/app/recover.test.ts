import { describe, expect, test } from "bun:test";
import { Pool } from "./pool.ts";
import { Recover } from "./recover.ts";
import { TaskGraph } from "./task-graph.ts";
import {
  FakeTaskFiles,
  FakeJournal,
  FakePublisher,
  FakeTasks,
  FakeWorkspaces,
  aSession,
  aSlot,
  aTask,
  fakeAgents,
  fakePaths,
} from "../testing/ports.ts";
import type { TaskId, TaskMeta } from "../domain/task.ts";

const DEAD_PID = 9001;
const LIVE_PID = 9002;

function aRig(tasks: TaskMeta[]) {
  const byId = new Map<TaskId, TaskMeta>(tasks.map((task) => [task.id, task]));
  const store = new FakeTasks(byId);
  const workspaces = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const paths = fakePaths();

  const graph = new TaskGraph(
    store,
    workspaces,
    new FakeTaskFiles(),
    new FakeJournal(),
    publisher,
    paths,
  );
  const pool = new Pool(
    fakeAgents([aSlot()]),
    workspaces,
    paths,
    publisher,
    (pid) => pid === LIVE_PID,
  );
  const recover = new Recover(
    graph,
    pool,
    workspaces,
    paths,
    publisher,
    (pid) => pid === LIVE_PID,
    "master",
  );

  return { recover, pool, workspaces, store, log: publisher.lines, publisher };
}

describe("Feature: reaping claims whose process is gone", () => {
  test("a claim held by a dead process is released", () => {
    // Given a task claimed by an agent whose process has exited
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, store } = aRig([task]);

    // When the reaper runs over the graph
    recover.reap(new Map([[task.id, task]]));

    // Then the claim is cleared, putting the task back in the queue where it stands
    expect(store.released).toEqual(["000042"]);
  });

  test("a claim held by a live process is left alone", () => {
    // Given a task claimed by an agent that is still running
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: LIVE_PID,
    });
    const { recover, store } = aRig([task]);

    // When the reaper runs over the graph
    recover.reap(new Map([[task.id, task]]));

    // Then nothing is released, because the agent is still working
    expect(store.released).toEqual([]);
  });

  test("a slot whose own process is alive shields its task from the reaper", () => {
    // Given a task whose recorded pid is gone
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, pool, store } = aRig([task]);

    // Given the slot holding it still has a live process of its own
    const runner = pool.runner("pi-fake-fake-1");
    runner.taskId = task.id;
    runner.process = aSession({ kind: "none" }, true);

    // When the reaper runs over the graph
    recover.reap(new Map([[task.id, task]]));

    // Then the claim is left alone, because the agent is still running
    expect(store.released).toEqual([]);
  });

  test("a slot still holding a dead process does not shield its task", () => {
    // Given a task whose recorded pid is gone
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
    });
    const { recover, pool, store } = aRig([task]);

    // Given the slot holding it kept a process that has already exited
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.taskId = task.id;
    runner.process = aSession({ kind: "none" }, false);

    // When the reaper runs over the graph
    recover.reap(new Map([[task.id, task]]));

    // Then the claim is released and the slot goes back to idle
    expect(store.released).toEqual(["000042"]);
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });

  test("the work a reaped agent committed is harvested onto its branch", () => {
    // Given a dead agent's task with a workspace still on disk
    const task = aTask({
      claimed_by: "pi-fake-fake-1",
      claimed_pid: DEAD_PID,
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: null,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.present.add("/runtime/000042/worktree");

    // When the reaper runs over the graph
    recover.reap(new Map([[task.id, task]]));

    // Then the commits in the worktree are harvested before the claim is dropped
    expect(workspaces.harvested).toEqual(["/runtime/000042/worktree"]);
  });
});

describe("Feature: picking the pool back up after a restart", () => {
  test("a slot whose pid is still alive is left running", () => {
    // Given a published view naming a slot that is still running a task
    const { recover, pool, publisher, log } = aRig([]);
    publisher.rows = [
      {
        ...pool.rows()[0]!,
        state: "BUSY",
        task_id: "000042",
        role: "worker",
        pid: LIVE_PID,
        started_at: "2026-07-29T00:00:00Z",
        session: "/sessions/000042.jsonl",
      },
    ];

    // When the server reattaches to what the last one left behind
    recover.reattach();

    // Then the slot is taken as busy on that task rather than dispatched again
    const row = pool.rows()[0]!;
    expect(row.state).toBe("BUSY");
    expect(row.task_id).toBe("000042");
    expect(log).toEqual([
      `pi-fake-fake-1 is still running 000042 as pid ${LIVE_PID}; leaving it alone`,
    ]);
  });

  test("a slot whose pid is gone is left idle for the scheduler", () => {
    // Given a published view naming a slot whose process has since exited
    const { recover, pool, publisher } = aRig([]);
    publisher.rows = [
      {
        ...pool.rows()[0]!,
        state: "BUSY",
        task_id: "000042",
        role: "worker",
        pid: DEAD_PID,
      },
    ];

    // When the server reattaches to what the last one left behind
    recover.reattach();

    // Then the slot reads idle, so the scheduler may use it again
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });

  test("no view on disk leaves every slot idle", () => {
    // Given a first start, with no published view to read
    const { recover, pool } = aRig([]);

    // When the server reattaches to the pool it left behind
    recover.reattach();

    // Then the whole pool is idle
    expect(pool.rows().map((row) => row.state)).toEqual(["IDLE"]);
  });
});

describe("Feature: recloning a workspace that went missing", () => {
  test("a task whose worktree is gone is recloned from its branch", () => {
    // Given a task whose worktree is gone but whose branch survives
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: null,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.branches.add("task/000042");

    // When the server recovers its workspaces
    recover.reclone();

    // Then the worktree is recloned, so the work is not lost
    expect(workspaces.created).toEqual(["/runtime/000042/worktree"]);
  });

  test("a task that lost both its worktree and its branch is only reported", () => {
    // Given a task whose worktree and branch are both gone
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: null,
      },
    });
    const { recover, workspaces, log } = aRig([task]);

    // When the server recovers its workspaces
    recover.reclone();

    // Then nothing is recloned, and the loss is written to the log
    expect(workspaces.created).toEqual([]);
    expect(log).toEqual([
      "task 000042 lost both its worktree and branch task/000042",
    ]);
  });

  test("a task whose worktree is still there is left alone", () => {
    // Given a task whose worktree is where it was left
    const task = aTask({
      workspace: {
        branch: "task/000042",
        worktree: "/runtime/000042/worktree",
        slot: "pi-fake-fake-1",
        session: null,
      },
    });
    const { recover, workspaces } = aRig([task]);
    workspaces.present.add("/runtime/000042/worktree");

    // When the server recovers its workspaces
    recover.reclone();

    // Then nothing is recloned over it
    expect(workspaces.created).toEqual([]);
  });
});
