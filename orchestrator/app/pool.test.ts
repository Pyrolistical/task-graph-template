import { describe, expect, test } from "bun:test";
import { Pool } from "./pool.ts";
import {
  FakePublisher,
  FakeWorkspaces,
  aSession,
  aSlot,
  fakeAgents,
  fakePaths,
} from "../testing/ports.ts";
import type { Activity } from "../domain/activity.ts";
import type { AgentSlot } from "../domain/agents.ts";

function aPool(slots: AgentSlot[] = [aSlot()], alive = true) {
  const git = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const pool = new Pool(
    fakeAgents(slots),
    git,
    fakePaths(),
    publisher,
    () => alive,
  );
  return { pool, log: publisher.lines, harvested: git.harvested, git };
}

describe("Feature: the pool of agent slots", () => {
  test("every slot in the pool starts idle", () => {
    // Given a pool built from two enabled slots
    const { pool } = aPool([aSlot(), aSlot({ name: "pi-fake-fake-2" })]);

    // When the pool is asked for its rows
    const states = pool.rows().map((row) => row.state);

    // Then both slots read as idle, because the pool is fixed at load
    expect(states).toEqual(["IDLE", "IDLE"]);
  });

  test("a slot of an agent disabled in the pool file reads as disabled", () => {
    // Given a pool whose only agent is turned off in the pool file
    const { pool } = aPool([aSlot({ enabled: false })]);

    // When the pool is asked for its rows
    const row = pool.rows()[0]!;

    // Then the slot reads as disabled rather than idle
    expect(row.state).toBe("DISABLED");
  });

  test("disabling an agent takes its slots out of the free list", () => {
    // Given a pool with one idle slot
    const { pool } = aPool();
    expect(pool.freeSlots()).toHaveLength(1);

    // When the agent behind it is disabled
    pool.setAgentEnabled("pi-fake-fake", false);

    // Then nothing is left for the scheduler to dispatch to
    expect(pool.freeSlots()).toEqual([]);
  });

  test("enabling an agent puts its slots back in the free list", () => {
    // Given a pool whose only agent has been disabled
    const { pool } = aPool();
    pool.setAgentEnabled("pi-fake-fake", false);

    // When the agent is enabled again
    pool.setAgentEnabled("pi-fake-fake", true);

    // Then its slot is dispatchable once more
    expect(pool.freeSlots().map((slot) => slot.name)).toEqual([
      "pi-fake-fake-1",
    ]);
  });

  test("an agent the pool never loaded cannot be toggled", () => {
    // Given a pool that holds one agent
    const { pool } = aPool();

    // When some other agent is disabled
    const attempt = () => pool.setAgentEnabled("pi-other-other", false);

    // Then the pool refuses and names what it does hold
    expect(attempt).toThrow(/no agent named "pi-other-other"/);
  });
});

describe("Feature: aborting the tool call an agent is inside", () => {
  test("a slot running a bash call has that call aborted", () => {
    // Given a slot whose agent is inside a bash tool call
    const { pool, log } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.process = aSession({
      kind: "tool-call",
      tool: "bash",
      target: "sleep 600",
      started_at: Date.now(),
    });

    // When the slot is aborted
    pool.abortAgent("pi-fake-fake-1");

    // Then the pool records that it killed the command the agent was running
    expect(log).toEqual(["pi-fake-fake-1 aborted bash: sleep 600"]);
  });

  test("a busy slot doing nothing in particular is refused", () => {
    // Given a busy slot whose session reports no activity at all
    const activity: Activity = { kind: "none" };
    const { pool } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortAgent("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot that is thinking is refused", () => {
    // Given a busy slot that is thinking rather than running a command
    const activity: Activity = { kind: "thinking", started_at: 0 };
    const { pool } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortAgent("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot that is compacting is refused", () => {
    // Given a busy slot compacting an overflowing context rather than running a command
    const activity: Activity = {
      kind: "compacting",
      reason: "overflow",
      started_at: 0,
    };
    const { pool } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortAgent("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot inside a read call is refused", () => {
    // Given a busy slot reading a file rather than running a command
    const activity: Activity = {
      kind: "tool-call",
      tool: "read",
      target: "a.txt",
      started_at: 0,
    };
    const { pool } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortAgent("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot with no process at all is refused as not running", () => {
    // Given a slot the scheduler has never dispatched to
    const { pool } = aPool();

    // When that slot is asked to abort its tool call
    const attempt = () => pool.abortAgent("pi-fake-fake-1");

    // Then the pool says the slot is not running
    expect(attempt).toThrow(/pi-fake-fake-1 is not running/);
  });

  test("aborting by agent key rather than slot name is refused", () => {
    // Given a pool whose slots are suffixed with their number
    const { pool } = aPool();

    // When the agent key is passed where a slot name belongs
    const attempt = () => pool.abortAgent("pi-fake-fake");

    // Then the pool refuses and lists the slot names it has
    expect(attempt).toThrow(/no agent slot named "pi-fake-fake"/);
  });
});

describe("Feature: releasing a slot when its work ends", () => {
  test("finishing a worker harvests its worktree and returns the slot to idle", () => {
    // Given a slot busy on a task in its own worktree
    const { pool, harvested, git } = aPool();
    git.present.add("/tmp/000042/worktree");
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.task_id = "000042";
    worker.branch = "task/000042";
    worker.worktree = "/tmp/000042/worktree";
    worker.process = aSession({ kind: "none" });

    // When the worker is finished with
    pool.finish(worker);

    // Then the commits in its worktree are harvested onto its branch
    expect(harvested).toEqual(["/tmp/000042/worktree"]);

    // Then the slot reads idle again, holding nothing
    expect(pool.rows()[0]!.state).toBe("IDLE");
    expect(pool.worker("pi-fake-fake-1").task_id).toBeNull();
  });

  test("work that throws stops the slot and says which task it failed on", async () => {
    // Given a slot busy on a task
    const { pool, log } = aPool();
    const worker = pool.worker("pi-fake-fake-1");
    worker.state = "BUSY";
    worker.task_id = "000042";

    // When the work the pool is tracking rejects
    pool.track(worker, Promise.reject(new Error("the provider hung up")));
    await pool.settled();

    // Then the failure is logged against the slot and the task it was on
    expect(log).toEqual([
      "pi-fake-fake-1 on 000042 failed: the provider hung up",
    ]);

    // Then the slot is released rather than left holding a broken run
    expect(pool.rows()[0]!.state).toBe("IDLE");
  });

  test("a pool with nothing tracked has no work in flight", () => {
    // Given a pool that has dispatched nothing
    const { pool } = aPool();

    // When the amount of work in flight is read
    const running = pool.running;

    // Then there is none, so a tick has nothing to wait on
    expect(running).toBe(0);
  });
});
