import { describe, expect, test } from "bun:test";
import { type Run, Pool } from "./pool.ts";
import {
  FakePublisher,
  FakeWorkspaces,
  type Reservation,
  aRun,
  aSchedule,
  aSession,
  aSlot,
  fakeAgents,
} from "../../testing/ports.ts";
import type { AgentProcess } from "../ports/agents.ts";
import type { Activity } from "../../views/activity.ts";
import type { Slot } from "../domain/slots.ts";
import type { Cost } from "../../vocabulary/costs.ts";
import { at } from "../../testing/present.ts";

function aPool(
  slots: Slot[] = [aSlot()],
  alive = true,
  health: () => boolean = () => true,
  session: () => AgentProcess = () => aSession(),
) {
  const workspaces = new FakeWorkspaces();
  const publisher = new FakePublisher();
  const probed: string[] = [];
  const agents = fakeAgents(slots, session, (slot) => {
    probed.push(slot.provider);
    return health();
  });
  const costs: { id: string; cost: Cost; resumed: boolean }[] = [];
  const pool = new Pool(
    agents,
    workspaces,
    publisher,
    () => alive,
    (id, cost, resumed) => {
      costs.push({ id, cost, resumed });
    },
  );
  return {
    pool,
    log: publisher.lines,
    harvested: workspaces.harvested,
    workspaces,
    probed,
    costs,
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

  test("a slot inside a segment its agent declared is offered", async () => {
    // Given a pool whose only agent is allowed to run for the half hour either side of now
    const { pool } = aPool([aSlot({ schedule: aSchedule(-30, 30) })]);

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then the slot is dispatchable, because the clock is inside its schedule
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-fake-1"]);
  });

  test("a slot outside every segment its agent declared is held back", async () => {
    // Given a pool whose only agent is allowed to run in half an hour's time
    const { pool } = aPool([aSlot({ schedule: aSchedule(30, 90) })]);

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then nothing is dispatched, because the clock is outside its schedule
    expect(free).toEqual([]);
  });

  test("a slot outside its schedule reads as off schedule", () => {
    // Given a pool whose only agent is allowed to run in half an hour's time
    const { pool } = aPool([aSlot({ schedule: aSchedule(30, 90) })]);

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then it reads as off schedule with its switch still on, because the agent is enabled
    expect(row.state).toBe("OFF_SCHEDULE");
    expect(row.enabled).toBe(true);
  });

  test("a slot outside its schedule never has its provider reached for", async () => {
    // Given a pool whose only agent asks for a health check
    // Given that agent is allowed to run only in half an hour's time
    const { pool, probed } = aPool([
      aSlot({ healthCheck: true, schedule: aSchedule(30, 90) }),
    ]);

    // When the scheduler asks what is free
    await pool.freeSlots();

    // Then the provider was left alone, because a held slot is not capacity to check
    expect(probed).toEqual([]);
  });

  test("a slot holding a task keeps it when its schedule closes", async () => {
    // Given a pool of two slots of one agent, allowed to run only in half an hour's time
    // Given one of them is busy with a task and the other is idle
    const slots = [1, 2].map((index) =>
      aSlot({
        name: `pi-fake-fake-${index}`,
        index,
        schedule: aSchedule(30, 90),
      }),
    );
    const { pool } = aPool(slots);
    await onATask(pool);

    // When the pool is asked for its rows
    const rows = pool.rows();

    // Then only the idle slot reads as off schedule, because a schedule gates dispatch, not work in flight
    expect(rows.map((row) => row.state)).toEqual(["BUSY", "OFF_SCHEDULE"]);
  });

  test("a slot of an agent that is both off and outside its schedule reads as disabled", () => {
    // Given a pool whose only agent is turned off in the pool file
    // Given that agent is also allowed to run only in half an hour's time
    const { pool } = aPool([
      aSlot({ enabled: false, schedule: aSchedule(30, 90) }),
    ]);

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then it reads as disabled, because a switch a person threw outranks the clock
    expect(row.state).toBe("DISABLED");
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

  test("an idle slot of a provider that is down reads as unreachable", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it does not answer
    const { pool } = aPool([aSlot({ healthCheck: true })], true, () => false);
    await pool.freeSlots();

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then the slot is drawn as unreachable rather than as idle capacity
    expect(row.state).toBe("UNREACHABLE");
    expect(row.enabled).toBe(true);
  });

  test("a slot still holding a task keeps its own state while its provider is down", async () => {
    // Given a pool of two slots of one agent, both asking for a health check
    // Given one of them is busy with a task and the other is idle
    const slots = [1, 2].map((index) =>
      aSlot({ name: `pi-fake-fake-${index}`, index, healthCheck: true }),
    );
    const { pool } = aPool(slots, true, () => false);
    await onATask(pool);

    // When the provider behind them fails its health check
    await pool.freeSlots();

    // Then only the idle slot reads as unreachable, because the outage gates dispatch, not work in flight
    expect(pool.rows().map((row) => row.state)).toEqual([
      "BUSY",
      "UNREACHABLE",
    ]);
  });

  test("an idle slot of an agent that asks for no health check reads as idle", async () => {
    // Given a pool of two agents that share a provider
    // Given only one of them asks for a health check, and that provider is down
    const checked = aSlot({ name: "pi-fake-fake-1", healthCheck: true });
    const unchecked = aSlot({
      name: "pi-fake-other-1",
      agent: "pi-fake-other",
      model: "other",
    });
    const { pool } = aPool([checked, unchecked], true, () => false);

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then the agent that asked to be checked is held back and the other is untouched
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-other-1"]);
    expect(pool.rows().map((row) => row.state)).toEqual([
      "UNREACHABLE",
      "IDLE",
    ]);
  });
});

describe("Feature: what a running session has cost so far", () => {
  test("the console is shown the price pi reports", async () => {
    // Given a busy slot whose provider prices what it has spent
    const { pool } = aPool(
      [aSlot({ wattage: 300, costPerKwh: 0.2 })],
      true,
      () => true,
      () => aSession({ kind: "none" }, true, [], { cost: 0.45 }),
    );
    await onATask(pool);
    await pool.readStats();

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then the row carries the provider's price, not a second one off the meter
    expect(row.cost).toBe(0.45);
  });

  test("a slot on an unpriced model shows what its power has cost", async () => {
    // Given a busy slot on a 300W agent at 20 cents a kWh, an hour in, priced at nothing
    const { pool } = aPool([aSlot({ wattage: 300, costPerKwh: 0.2 })]);
    await onATask(pool, anHourAgo());

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then the console has a cost to draw for a model that bills no tokens
    expect(row.cost).toBe(0.06);
  });

  test("a slot with neither a price nor a meter costs nothing", async () => {
    // Given a busy slot on an agent that declares no wattage
    const { pool } = aPool();
    await onATask(pool);

    // When the pool is asked for its rows
    const row = at(pool.rows(), 0);

    // Then it reads zero, which the console draws as no column at all
    expect(row.cost).toBe(0);
  });
});

describe("Feature: aborting the tool call an agent is inside", () => {
  test("a slot running a bash call has that turn aborted", async () => {
    // Given a slot whose agent is inside a bash tool call
    const { pool, log } = aPool(
      [aSlot()],
      true,
      () => true,
      () =>
        aSession({
          kind: "tool-call",
          tool: "bash",
          target: "sleep 600",
          started_at: Date.now(),
        }),
    );
    await onATask(pool);

    // When the slot is aborted
    await pool.abortSlot("pi-fake-fake-1");

    // Then the pool records the command it killed, and that the turn went with it
    expect(log).toEqual([
      "pi-fake-fake-1 aborted the turn inside bash: sleep 600",
    ]);
  });

  test("a slot that is thinking is refused", async () => {
    // Given a busy slot that is thinking rather than running a command
    const activity: Activity = { kind: "thinking", started_at: 0 };
    const { pool } = aPool(
      [aSlot()],
      true,
      () => true,
      () => aSession(activity),
    );
    await onATask(pool);

    // When the slot is aborted
    const attempt = () => pool.abortSlot("pi-fake-fake-1");

    // Then it is refused, because there is no command to kill
    expect(attempt).toThrow(/not running a bash tool call/);
  });
});

function anHourAgo(): string {
  return new Date(Date.now() - 3600000).toISOString();
}

const A_SESSION = "/sessions/000042.jsonl";

function aReservation(
  startedAt?: string,
  carried?: { seconds: number; cost: number },
): Reservation {
  return {
    slotName: "pi-fake-fake-1",
    taskId: "000042",
    state: "WORK",
    role: "worker",
    startedAt,
    resumed: Boolean(carried),
    carried,
  };
}

function onATask(
  pool: Pool,
  startedAt?: string,
  carried?: { seconds: number; cost: number },
): Promise<Run> {
  return aRun(pool, aReservation(startedAt, carried), A_SESSION);
}

describe("Feature: releasing a slot when its work ends", () => {
  test("finishing a runner harvests its worktree and returns the slot to idle", async () => {
    // Given a slot busy on a task in its own worktree
    const { pool, harvested, workspaces } = aPool();
    workspaces.present.add("/runtime/000042/worktree");
    const run = await onATask(pool);

    // When the run is finished with
    await pool.finish(run);

    // Then the commits in its worktree are harvested onto its branch
    expect(harvested).toEqual(["/runtime/000042/worktree"]);

    // Then the slot reads idle again, holding nothing
    expect(at(pool.rows(), 0).state).toBe("IDLE");
    expect(at(pool.rows(), 0).task_id).toBeUndefined();
  });

  test("work that throws stops the slot and says which task it failed on", async () => {
    // Given a slot busy on a task
    const { pool, log } = aPool();
    const run = await onATask(pool);

    // When the work the pool is tracking rejects
    pool.track(run, Promise.reject(new Error("the provider hung up")));

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
      () => {},
    );
    const run = await onATask(pool);

    // When the work the pool is tracking fails, before the process check answers
    pool.track(run, Promise.reject(new Error("the provider hung up")));
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

  test("a session that ends puts what pi charged for it on the task", async () => {
    // Given a slot part way through a work session pi has priced
    const { pool, costs } = aPool(
      [aSlot()],
      true,
      () => true,
      () => aSession({ kind: "none" }, true, [], { cost: 0.45 }),
    );
    await onATask(pool);
    await pool.readStats();

    // When the slot is released
    await pool.release("pi-fake-fake-1");

    // Then the task carries what that session cost, against the state it ran
    expect(costs).toEqual([
      {
        id: "000042",
        cost: {
          state: "WORK",
          slot: "pi-fake-fake-1",
          seconds: 0,
          cost: 0.45,
        },
        resumed: false,
      },
    ]);
  });

  test("a session on an unpriced model is billed for the power it drew", async () => {
    // Given a slot on a 300W agent at 20 cents a kWh, an hour into a session pi prices at nothing
    const { pool, costs } = aPool([aSlot({ wattage: 300, costPerKwh: 0.2 })]);
    await onATask(pool, anHourAgo());

    // When the slot is released
    await pool.release("pi-fake-fake-1");

    // Then the hour it ran is billed as energy instead of tokens
    expect(costs).toEqual([
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

  test("a resumed session is recorded as the same session, not a second one", async () => {
    // Given a slot that resumed a work session which had already run 15 minutes
    const { pool, costs } = aPool(
      [aSlot()],
      true,
      () => true,
      () => aSession({ kind: "none" }, true, [], { cost: 0.7 }),
    );
    await onATask(pool, undefined, { seconds: 900, cost: 0.3 });
    await pool.readStats();

    // When the slot is released
    await pool.release("pi-fake-fake-1");

    // Then the entry is marked a resume, carrying the clock but taking pi's price whole
    expect(costs).toEqual([
      {
        id: "000042",
        cost: {
          state: "WORK",
          slot: "pi-fake-fake-1",
          seconds: 900,
          cost: 0.7,
        },
        resumed: true,
      },
    ]);
  });

  test("a slot released before it opened a session bills the task nothing", async () => {
    // Given a slot that took a task but died before pi gave it a session
    const { pool, costs } = aPool();
    await aRun(pool, aReservation(), undefined);

    // When the slot is released
    await pool.release("pi-fake-fake-1");

    // Then nothing is recorded, because an entry is a session and there was none
    expect(costs).toEqual([]);
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
