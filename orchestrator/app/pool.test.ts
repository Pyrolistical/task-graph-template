import { describe, expect, test } from "bun:test";
import { Pool } from "./pool.ts";
import {
  FakePublisher,
  FakeWorkspaces,
  aSession,
  aSlot,
  fakeAgents,
} from "../testing/ports.ts";
import type { Activity } from "../domain/activity.ts";
import type { Slot } from "../domain/agents.ts";
import { at } from "../testing/present.ts";

function aPool(
  slots: Slot[] = [aSlot()],
  alive = true,
  health: () => boolean = () => true,
) {
  const workspaces = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const probed: string[] = [];
  const agents = fakeAgents(
    slots,
    () => aSession(),
    (slot) => {
      probed.push(slot.provider);
      return health();
    },
  );
  const pool = new Pool(agents, workspaces, publisher, () => alive);
  return {
    pool,
    log: publisher.lines,
    harvested: workspaces.harvested,
    workspaces,
    probed,
  };
}

describe("Feature: the pool of agent slots", () => {
  test("every slot in the pool starts idle", () => {
    // Given a pool built from two enabled slots
    const { pool } = aPool([aSlot(), aSlot({ name: "pi-fake-fake-2" })]);

    // When the pool is asked for its rows
    const rows = pool.rows();

    // Then both slots read as idle, because the pool is fixed at load
    expect(rows.map((row) => row.state)).toEqual(["IDLE", "IDLE"]);
  });

  test("a slot of an agent disabled in the pool file reads as disabled", () => {
    // Given a pool whose only agent is turned off in the pool file
    const { pool } = aPool([aSlot({ enabled: false })]);

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then the slot reads as disabled rather than idle
    expect(row.state).toBe("DISABLED");
  });

  test("disabling an agent takes its slots out of the free list", async () => {
    // Given a pool with one idle slot
    const { pool } = aPool();
    expect(await pool.freeSlots()).toHaveLength(1);

    // When the agent behind it is disabled
    await pool.setAgentEnabled("pi-fake-fake", false);

    // Then nothing is left for the scheduler to dispatch to
    expect(await pool.freeSlots()).toEqual([]);
  });

  test("enabling an agent puts its slots back in the free list", async () => {
    // Given a pool whose only agent has been disabled
    const { pool } = aPool();
    await pool.setAgentEnabled("pi-fake-fake", false);

    // When the agent is enabled again
    await pool.setAgentEnabled("pi-fake-fake", true);

    // Then its slot is dispatchable once more
    expect((await pool.freeSlots()).map((slot) => slot.name)).toEqual([
      "pi-fake-fake-1",
    ]);
  });

  test("a slot whose agent asks for no health check is offered unasked", async () => {
    // Given a pool whose only agent leaves healthCheck off
    const { pool, probed } = aPool([aSlot()], true, () => false);

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then the slot is offered and its provider was never reached for
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-fake-1"]);
    expect(probed).toEqual([]);
  });

  test("a slot whose provider answers its health check is offered", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it answers
    const { pool } = aPool([aSlot({ healthCheck: true })], true, () => true);

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then the slot is dispatchable
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-fake-1"]);
  });

  test("a slot whose provider fails its health check is held back", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it does not answer
    const { pool, log } = aPool(
      [aSlot({ healthCheck: true })],
      true,
      () => false,
    );

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then nothing is dispatched into a provider that is down, and the log says which one
    expect(free).toEqual([]);
    expect(log).toEqual([
      "provider fake failed its health check: its slots are held back",
    ]);
  });

  test("the provider behind several slots is asked once", async () => {
    // Given a pool of three slots of one agent, all asking for a health check
    const slots = [1, 2, 3].map((index) =>
      aSlot({ name: `pi-fake-fake-${index}`, index, healthCheck: true }),
    );
    const { pool, probed } = aPool(slots);

    // When the scheduler asks what is free
    await pool.freeSlots();

    // Then the provider was reached for once, not once per slot
    expect(probed).toEqual(["fake"]);
  });

  test("a provider that stays down is named once, not once a tick", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it has already been found down
    const { pool, log } = aPool(
      [aSlot({ healthCheck: true })],
      true,
      () => false,
    );
    await pool.freeSlots();

    // When the scheduler asks what is free again
    await pool.freeSlots();

    // Then the outage is still one line in the log
    expect(log).toEqual([
      "provider fake failed its health check: its slots are held back",
    ]);
  });

  test("a provider that comes back is said to be dispatchable again", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it has already been found down
    let up = false;
    const { pool, log } = aPool([aSlot({ healthCheck: true })], true, () => up);
    await pool.freeSlots();
    up = true;

    // When the scheduler asks what is free again
    const free = await pool.freeSlots();

    // Then the slot is offered once more and the log says the provider answered
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-fake-1"]);
    expect(at(log, 1)).toBe(
      "provider fake answered its health check: its slots are dispatchable again",
    );
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
  test("a slot running a bash call has that call aborted", async () => {
    // Given a slot whose agent is inside a bash tool call
    const { pool, log } = aPool();
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.process = aSession({
      kind: "tool-call",
      tool: "bash",
      target: "sleep 600",
      started_at: Date.now(),
    });

    // When the slot is aborted
    await pool.abortSlot("pi-fake-fake-1");

    // Then the pool records that it killed the command the agent was running
    expect(log).toEqual(["pi-fake-fake-1 aborted bash: sleep 600"]);
  });

  test("a busy slot doing nothing in particular is refused", () => {
    // Given a busy slot whose session reports no activity at all
    const activity: Activity = { kind: "none" };
    const { pool } = aPool();
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot that is thinking is refused", () => {
    // Given a busy slot that is thinking rather than running a command
    const activity: Activity = { kind: "thinking", started_at: 0 };
    const { pool } = aPool();
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

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
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

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
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.process = aSession(activity);

    // When the slot is aborted
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });

  test("a slot with no process at all is refused as not running", () => {
    // Given a slot the scheduler has never dispatched to
    const { pool } = aPool();

    // When that slot is asked to abort its tool call
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

    // Then the pool says the slot is not running
    expect(attempt).toThrow(/pi-fake-fake-1 is not running/);
  });

  test("aborting by agent key rather than slot name is refused", () => {
    // Given a pool whose slots are suffixed with their number
    const { pool } = aPool();

    // When the agent key is passed where a slot name belongs
    const attempt = () => pool.abortSlot("pi-fake-fake");

    // Then the pool refuses and lists the slot names it has
    expect(attempt).toThrow(/no agent slot named "pi-fake-fake"/);
  });
});

describe("Feature: releasing a slot when its work ends", () => {
  test("finishing a runner harvests its worktree and returns the slot to idle", async () => {
    // Given a slot busy on a task in its own worktree
    const { pool, harvested, workspaces } = aPool();
    workspaces.present.add("/tmp/000042/worktree");
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.taskId = "000042";
    runner.checkout = {
      branch: "task/000042",
      worktree: "/tmp/000042/worktree",
      head: "abc1234",
      dispatched: "the assignment\n",
    };
    runner.process = aSession({ kind: "none" });

    // When the runner is finished with
    await pool.finish(runner);

    // Then the commits in its worktree are harvested onto its branch
    expect(harvested).toEqual(["/tmp/000042/worktree"]);

    // Then the slot reads idle again, holding nothing
    expect(at(pool.rows(), 0).state).toBe("IDLE");
    expect(pool.runner("pi-fake-fake-1").taskId).toBeUndefined();
  });

  test("work that throws stops the slot and says which task it failed on", async () => {
    // Given a slot busy on a task
    const { pool, log } = aPool();
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.taskId = "000042";

    // When the work the pool is tracking rejects
    pool.track(runner, Promise.reject(new Error("the provider hung up")));

    // Then the failure is logged against the slot and the task it was on
    await pool.settled();
    expect(log).toEqual([
      "pi-fake-fake-1 on 000042 failed: the provider hung up",
    ]);

    // Then the slot is released rather than left holding a broken run
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });

  test("a slot is released only once its process is confirmed dead", async () => {
    // Given a pool whose process check waits to be answered
    const workspaces = new FakeWorkspaces();
    const publisher = new FakePublisher();
    let confirm: (dead: boolean) => void = () => {};
    const pool = new Pool(
      fakeAgents([aSlot()]),
      workspaces,
      publisher,
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const runner = pool.runner("pi-fake-fake-1");
    runner.state = "BUSY";
    runner.taskId = "000042";
    runner.process = aSession({ kind: "none" });

    // When the work the pool is tracking fails, before the process check answers
    pool.track(runner, Promise.reject(new Error("the provider hung up")));
    const released = pool.settled();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Then the failure is still settling until the process check answers
    expect(pool.inflight).toBe(1);
    expect(at(pool.rows(), 0).state).toBe("BUSY");

    // The process check answers, and only then does the slot go idle
    confirm(true);
    await released;
    expect(at(pool.rows(), 0).state).toBe("IDLE");
  });

  test("a pool with nothing tracked has no work in flight", () => {
    // Given a pool that has dispatched nothing
    const { pool } = aPool();

    // When the amount of work in flight is read
    const running = pool.inflight;

    // Then there is none, so a tick has nothing to wait on
    expect(running).toBe(0);
  });
});
