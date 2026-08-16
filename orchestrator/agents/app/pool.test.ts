import { describe, expect, test } from "bun:test";
import { type Run, Pool } from "./pool.ts";
import {
  fakeLog,
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
import { at, present } from "../../testing/present.ts";

function aPool(
  slots: Slot[] = [aSlot()],
  alive = true,
  health: () => string | undefined = () => undefined,
  session: () => AgentProcess = () => aSession(),
) {
  const workspaces = new FakeWorkspaces();
  const { log, lines } = fakeLog();
  const probed: string[] = [];
  const agents = fakeAgents(slots, session, (slot) => {
    probed.push(slot.provider);
    return health();
  });
  const costs: { id: string; cost: Cost; resumed: boolean }[] = [];
  const pool = new Pool(
    agents,
    workspaces,
    log,
    () => alive,
    (id, cost, resumed) => {
      costs.push({ id, cost, resumed });
    },
  );
  return {
    pool,
    log: lines,
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

    // Then both slots read as idle, because a slot holds nothing until it is dispatched
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
    const { pool, probed } = aPool([aSlot()], true, () => "nothing answered");

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then the slot is offered and its provider was never reached for
    expect(free.map((slot) => slot.name)).toEqual(["pi-fake-fake-1"]);
    expect(probed).toEqual([]);
  });

  test("a slot whose provider answers its health check is offered", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it answers
    const { pool } = aPool(
      [aSlot({ healthCheck: true })],
      true,
      () => undefined,
    );

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
      () => "nothing answered",
    );

    // When the scheduler asks what is free
    const free = await pool.freeSlots();

    // Then nothing is dispatched into a provider that is down, and the log says which one
    expect(free).toEqual([]);
    expect(log).toEqual([
      "provider fake failed its health check: nothing answered; its slots are held back",
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
      () => "nothing answered",
    );
    await pool.freeSlots();

    // When the scheduler asks what is free again
    await pool.freeSlots();

    // Then the outage is still one line in the log
    expect(log).toEqual([
      "provider fake failed its health check: nothing answered; its slots are held back",
    ]);
  });

  test("a provider that comes back is said to be dispatchable again", async () => {
    // Given a pool whose only agent asks for a health check
    // Given the provider behind it has already been found down
    let down: string | undefined = "nothing answered";
    const { pool, log } = aPool(
      [aSlot({ healthCheck: true })],
      true,
      () => down,
    );
    await pool.freeSlots();
    down = undefined;

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
    const { pool } = aPool(
      [aSlot({ healthCheck: true })],
      true,
      () => "nothing answered",
    );
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
    const { pool } = aPool(slots, true, () => "nothing answered");
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
    const { pool } = aPool(
      [checked, unchecked],
      true,
      () => "nothing answered",
    );

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
      () => undefined,
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
      () => undefined,
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
      () => undefined,
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
    const { log } = fakeLog();
    let confirm: (dead: boolean) => void = () => {};
    const pool = new Pool(
      fakeAgents([aSlot()]),
      workspaces,
      log,
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
      () => undefined,
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
      () => undefined,
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

describe("Feature: changing how many slots an agent runs with", () => {
  const twoSlots = () =>
    aPool([aSlot(), aSlot({ name: "pi-fake-fake-2", index: 2 })]);

  const onASecondTask = (pool: Pool) =>
    aRun(
      pool,
      { ...aReservation(), slotName: "pi-fake-fake-2", taskId: "000043" },
      A_SESSION,
    );

  test("every row says how many slots its agent is meant to have", () => {
    // Given a pool built from two slots of one agent
    const { pool } = twoSlots();

    // When the pool is asked for its rows
    const rows = pool.rows();

    // Then each row carries the count, so a reader can say which of how many it is
    expect(rows.map((row) => [row.index, row.total])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  test("a slot added at runtime takes the next free number and starts idle", async () => {
    // Given a pool of two slots
    const { pool, log } = twoSlots();

    // When the agent is set to three slots
    const rows = await pool.setAgentSlots("pi-fake-fake", 3);

    // Then the new slot is named for the number it took, and holds nothing
    expect(rows.map((row) => row.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-2",
      "pi-fake-fake-3",
    ]);
    expect(at(rows, 2).state).toBe("IDLE");
    expect(rows.map((row) => row.total)).toEqual([3, 3, 3]);
    expect(log).toEqual([
      "agent pi-fake-fake set to 3 slots; took pi-fake-fake-3",
    ]);
  });

  test("a slot added at runtime is dispatchable", async () => {
    // Given a pool of one slot the scheduler can have
    const { pool } = aPool();
    expect(await pool.freeSlots()).toHaveLength(1);

    // When the agent is set to two slots
    await pool.setAgentSlots("pi-fake-fake", 2);

    // Then the free list has both, because a runtime slot is a slot like any other
    expect((await pool.freeSlots()).map((slot) => slot.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-2",
    ]);
  });

  test("a slot added at runtime is spawned against its agent's settings", async () => {
    // Given a pool whose only agent may only work
    const { pool } = aPool([aSlot({ roles: ["worker"], wattage: 300 })]);

    // When a second slot is added
    await pool.setAgentSlots("pi-fake-fake", 2);

    // Then it carries the same settings as the slot it was copied from
    const added = present(
      pool.slots.find((slot) => slot.name === "pi-fake-fake-2"),
      "the added slot",
    );
    expect(added.roles).toEqual(["worker"]);
    expect(added.wattage).toBe(300);
  });

  test("dropping a slot takes an idle one out of the pool at once", async () => {
    // Given a pool of two idle slots
    const { pool, log } = twoSlots();

    // When the agent is set to one slot
    const rows = await pool.setAgentSlots("pi-fake-fake", 1);

    // Then the last one is gone rather than kept as a row that cannot be dispatched
    expect(rows.map((row) => row.name)).toEqual(["pi-fake-fake-1"]);
    expect(log).toEqual([
      "agent pi-fake-fake set to 1 slots; dropped pi-fake-fake-2",
    ]);
  });

  test("dropping a slot leaves the busy ones alone and takes the idle one", async () => {
    // Given a pool of two slots, the first of them busy on a task
    const { pool } = twoSlots();
    await onATask(pool);

    // When the agent is set to one slot
    const rows = await pool.setAgentSlots("pi-fake-fake", 1);

    // Then the idle slot is what leaves, and the task keeps running
    expect(rows.map((row) => row.name)).toEqual(["pi-fake-fake-1"]);
    expect(at(rows, 0).task_id).toBe("000042");
  });

  test("with every slot busy the first one to go idle is the one that leaves", async () => {
    // Given a pool of two slots, both of them busy on a task
    const { pool } = twoSlots();
    const run = await onATask(pool);
    await onASecondTask(pool);

    // When the agent is set to one slot
    const rows = await pool.setAgentSlots("pi-fake-fake", 1);

    // Then both keep their task, the extra one reading as a number above the count
    expect(rows.map((row) => [row.index, row.total])).toEqual([
      [1, 1],
      [2, 1],
    ]);

    // Then the one whose work ends first is the one that leaves the pool
    await pool.finish(run);
    expect(pool.rows().map((row) => row.name)).toEqual(["pi-fake-fake-2"]);
  });

  test("a slot waiting to be dropped is kept if the count goes back up", async () => {
    // Given a pool of two busy slots the agent has been told to drop one of
    const { pool } = twoSlots();
    const run = await onATask(pool);
    await onASecondTask(pool);
    await pool.setAgentSlots("pi-fake-fake", 1);

    // When the agent is set back to two slots
    await pool.setAgentSlots("pi-fake-fake", 2);

    // Then work ending returns that slot to the pool rather than taking it out
    await pool.finish(run);
    expect(pool.rows().map((row) => row.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-2",
    ]);
  });

  test("a number freed by a dropped slot is the one the next slot takes", async () => {
    // Given a pool of three slots whose middle one has been dropped
    const { pool } = aPool([
      aSlot(),
      aSlot({ name: "pi-fake-fake-2", index: 2 }),
      aSlot({ name: "pi-fake-fake-3", index: 3 }),
    ]);
    const run = await aRun(
      pool,
      { ...aReservation(), slotName: "pi-fake-fake-3" },
      A_SESSION,
    );
    await pool.setAgentSlots("pi-fake-fake", 2);
    expect(pool.rows().map((row) => row.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-3",
    ]);

    // When the agent is set to three slots again
    await pool.setAgentSlots("pi-fake-fake", 3);

    // Then the gap is filled rather than the numbers climbing past the busy slot
    expect(pool.rows().map((row) => row.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-2",
      "pi-fake-fake-3",
    ]);
    await pool.finish(run);
  });

  test("the last slot of an agent cannot be dropped", async () => {
    // Given a pool of one slot
    const { pool } = aPool();

    // When the agent is set to no slots at all
    const attempt = pool.setAgentSlots("pi-fake-fake", 0);

    // Then it is refused, because an agent with no slots is one that should be disabled
    await expect(attempt).rejects.toThrow(/cannot go below one slot/);
  });

  test("a count above the agent's limit is refused", async () => {
    // Given a pool of one slot whose agent may run two
    const { pool } = aPool([aSlot({ maxSlots: 2 })]);

    // When the agent is set to three slots
    const attempt = pool.setAgentSlots("pi-fake-fake", 3);

    // Then it is refused, naming the limit the file declared
    await expect(attempt).rejects.toThrow(/cannot go above its 2 slot limit/);
    expect(pool.rows()).toHaveLength(1);
  });

  test("a count at the agent's limit is taken", async () => {
    // Given a pool of one slot whose agent may run two
    const { pool } = aPool([aSlot({ maxSlots: 2 })]);

    // When the agent is set to two slots
    const rows = await pool.setAgentSlots("pi-fake-fake", 2);

    // Then the limit is a ceiling to reach, not one to stop below
    expect(rows.map((row) => row.name)).toEqual([
      "pi-fake-fake-1",
      "pi-fake-fake-2",
    ]);
    expect(rows.map((row) => row.max)).toEqual([2, 2]);
  });

  test("an agent the pool does not have is refused", async () => {
    // Given a pool of one agent
    const { pool } = aPool();

    // When another agent's count is set
    const attempt = pool.setAgentSlots("pi-fake-other", 2);

    // Then it is refused by name, as enabling an unknown agent is
    await expect(attempt).rejects.toThrow(/no agent named "pi-fake-other"/);
  });

  test("a slot dropped as it goes idle says so, so a reader sees it leave", async () => {
    // Given a pool of two busy slots the agent has been told to drop one of
    const { pool, log } = twoSlots();
    const run = await onATask(pool);
    await onASecondTask(pool);
    await pool.setAgentSlots("pi-fake-fake", 1);
    log.length = 0;

    // When its work ends
    await pool.finish(run);

    // Then the pool says which slot left and what the agent is down to
    expect(log).toEqual([
      "pi-fake-fake-1 went idle and left the pool: agent pi-fake-fake is down to 1 slots",
    ]);
  });
});
