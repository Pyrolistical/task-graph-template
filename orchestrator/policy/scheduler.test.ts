import { describe, expect, test } from "bun:test";
import { at, present } from "../testing/present.ts";
import { type Slot, agentOf } from "../domain/agents.ts";
import { blockingCounts } from "../domain/graph.ts";
import { inbox } from "./inbox.ts";
import { candidates, pickSlot, schedule } from "./scheduler.ts";
import type { RateOf } from "../domain/rates.ts";
import { ALL_ROLES } from "../domain/state-machine.ts";
import { type TaskMeta } from "../domain/task.ts";

describe("Feature: which task is dispatched next", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "WORK",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: undefined,
      claimed_pid: undefined,
      held_reason: undefined,
      workspace: undefined,
      checks: [],
      costs: [],
      ...overrides,
    };
  }

  function graph(...tasks: TaskMeta[]): Map<string, TaskMeta> {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  function queueOf(
    tasks: Map<string, TaskMeta>,
    resumable: Set<string> = new Set(),
  ) {
    return candidates(tasks, resumable, blockingCounts(tasks));
  }

  const unmeasured: RateOf = () => undefined;

  const rates =
    (measured: Record<string, number>): RateOf =>
    (agent) =>
      measured[agent];

  function planOf(
    tasks: Map<string, TaskMeta>,
    resumable: Set<string>,
    free: Slot[],
    rate: RateOf = unmeasured,
  ) {
    return schedule(tasks, resumable, blockingCounts(tasks), free, rate);
  }

  function workspace(slot = "pi-anthropic-m-1") {
    return {
      branch: "work/000001",
      worktree: "/tmp/wt",
      slot,
      session: "/tmp/s.jsonl",
    };
  }

  const slot = (name: string): Slot => ({
    name,
    agent: agentOf(name),
    type: "pi",
    provider: at(name.split("-"), 1),
    model: "m",
    index: 1,
    enabled: true,
    healthCheck: false,
    wattage: 0,
    costPerKwh: 0,
    write: ["~/.cache/zig"],
    roles: [...ALL_ROLES],
  });

  test("a task is counted as blocking everything that waits on it, however far", () => {
    // Given a chain of tasks depending on one another, and a second branch off it
    const tasks = graph(
      task({ id: "000001" }),
      task({ id: "000002", depends_on: ["000001"] }),
      task({ id: "000003", depends_on: ["000002"] }),
      task({ id: "000004", depends_on: ["000001"] }),
    );

    // When each task is counted against what waits on it
    const counts = blockingCounts(tasks);

    // Then the count reaches through the chain, not just to its direct dependents
    expect(counts.get("000001")).toBe(3);
    expect(counts.get("000002")).toBe(1);
    expect(counts.get("000003")).toBe(0);
  });

  test("the queue runs right to left, closest to done first", () => {
    // Given one task in every stage of the pipeline, some already started
    const tasks = graph(
      task({ id: "000001" }),
      task({ id: "000002", workspace: workspace() }),
      task({ id: "000003", state: "WORK_REVIEW" }),
      task({ id: "000004", workspace: workspace() }),
      task({ id: "000005", state: "PLAN_REVIEW" }),
      task({ id: "000006", state: "PLAN" }),
      task({ id: "000007", state: "PLAN", workspace: workspace() }),
      task({ id: "000008", state: "DESIGN_REVIEW" }),
      task({ id: "000009", state: "DESIGN" }),
      task({ id: "000010", state: "DESIGN", workspace: workspace() }),
    );

    // When the queue is built, with one of them ready to be resumed
    const queue = queueOf(tasks, new Set(["000004"]));

    // Then work outranks planning, planning outranks design, and a resume leads
    expect(queue.map((c) => c.task_id)).toEqual([
      "000004",
      "000003",
      "000002",
      "000001",
      "000005",
      "000007",
      "000006",
      "000008",
      "000010",
      "000009",
    ]);
    expect(queue.map((c) => c.rank)).toEqual([
      "resume",
      "WORK_REVIEW",
      "WORK_STARTED",
      "WORK_FRESH",
      "PLAN_REVIEW",
      "PLAN_STARTED",
      "PLAN_FRESH",
      "DESIGN_REVIEW",
      "DESIGN_STARTED",
      "DESIGN_FRESH",
    ]);
  });

  test("within a rank the task blocking the most goes first", () => {
    // Given two tasks at the same rank, one of them holding up a chain
    const tasks = graph(
      task({ id: "000001" }),
      task({ id: "000002" }),
      task({ id: "000003", depends_on: ["000002"] }),
      task({ id: "000004", depends_on: ["000003"] }),
    );

    // When the queue is built
    const queue = queueOf(tasks, new Set());

    // Then the one unblocking the most work is dispatched first
    expect(at(queue, 0).task_id).toBe("000002");
    expect(at(queue, 0).blocking).toBe(2);
  });

  test("two tasks blocking the same amount are ordered by their id", () => {
    // Given two tasks at the same rank, neither blocking anything
    const tasks = graph(task({ id: "000001" }), task({ id: "000002" }));

    // When the queue is built
    const queue = queueOf(tasks, new Set());

    // Then the older task goes first, so the order is never arbitrary
    expect(queue.map((c) => c.task_id)).toEqual(["000001", "000002"]);
  });

  test("a task parked on the manager is never dispatched", () => {
    // Given two tasks held, waiting on a person
    const tasks = graph(
      task({ id: "000001", state: "HELD_WORK", held_reason: "a wall" }),
      task({ id: "000002", state: "HELD_PLAN", held_reason: "no plan" }),
    );

    // When the queue is built
    const queue = queueOf(tasks, new Set());

    // Then neither is a candidate, because no agent can move them
    expect(queue).toEqual([]);
  });

  test("a task something else is already holding is never dispatched", () => {
    // Given two tasks, each claimed by something still running
    const tasks = graph(
      task({ id: "000001", state: "WORK", claimed_by: "pi-1", claimed_pid: 1 }),
      task({
        id: "000002",
        state: "CHECK",
        claimed_by: "server",
        claimed_pid: 1,
      }),
    );

    // When the queue is built
    const queue = queueOf(tasks, new Set());

    // Then neither is a candidate, because two agents may not hold one task
    expect(queue).toEqual([]);
  });

  test("a resume goes back to a free slot of the model that holds the session", () => {
    // Given a task to resume, whose session belongs to one of two free agents
    const free = [slot("pi-openai-m-1"), slot("pi-anthropic-m-2")];
    const candidate = at(
      queueOf(
        graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
        new Set(["000001"]),
      ),
      0,
    );

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, unmeasured);

    // Then the other slot of the same model takes it, so the session is kept
    expect(present(picked, "a picked slot").name).toBe("pi-anthropic-m-2");
  });

  test("a task with no session of its own goes to the fastest agent measured", () => {
    // Given a fresh task and two free agents, one measured faster than the other
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = at(queueOf(graph(task({ id: "000001" })), new Set()), 0);
    const rate = rates({ "pi-anthropic-m": 12, "pi-openai-m": 30 });

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, rate);

    // Then the faster agent takes it
    expect(present(picked, "a picked slot").name).toBe("pi-openai-m-1");
  });

  test("an agent nobody has measured yet is tried before a measured one", () => {
    // Given a fresh task, one measured agent and one that has never run
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = at(queueOf(graph(task({ id: "000001" })), new Set()), 0);

    // When a slot is picked for it
    const picked = pickSlot(
      free,
      candidate,
      true,
      rates({ "pi-anthropic-m": 30 }),
    );

    // Then the unmeasured agent takes it, so the pool learns what it can do
    expect(present(picked, "a picked slot").name).toBe("pi-openai-m-1");
  });

  test("agents measured the same keep the order the pool file gave them", () => {
    // Given a fresh task and two agents measured at the same rate
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = at(queueOf(graph(task({ id: "000001" })), new Set()), 0);
    const rate = rates({ "pi-anthropic-m": 20, "pi-openai-m": 20 });

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, rate);

    // Then the first one in the pool takes it, so the choice is not arbitrary
    expect(present(picked, "a picked slot").name).toBe("pi-anthropic-m-1");
  });

  test("keeping the session outweighs going to a much faster agent", () => {
    // Given a task to resume whose own model is measured far slower than the other
    const free = [slot("pi-openai-m-1"), slot("pi-anthropic-m-2")];
    const candidate = at(
      queueOf(
        graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
        new Set(["000001"]),
      ),
      0,
    );
    const rate = rates({ "pi-anthropic-m": 3, "pi-openai-m": 90 });

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, rate);

    // Then the session's own model still takes it, because a resume needs it
    expect(present(picked, "a picked slot").name).toBe("pi-anthropic-m-2");
  });

  test("a task whose own agent is busy falls back to the fastest free one", () => {
    // Given a started task whose model has no free slot at all
    const free = [slot("pi-openai-m-1"), slot("pi-mistral-m-1")];
    const candidate = at(
      queueOf(
        graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
        new Set(),
      ),
      0,
    );
    const rate = rates({ "pi-openai-m": 10, "pi-mistral-m": 50 });

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, rate);

    // Then the fastest agent that is free takes it rather than nothing running
    expect(present(picked, "a picked slot").name).toBe("pi-mistral-m-1");
  });

  test("only the head of the queue gives up its session for any free slot", () => {
    // Given a task to resume, and no free slot of the model holding its session
    const free = [slot("pi-openai-m-1")];
    const candidate = at(
      queueOf(
        graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
        new Set(["000001"]),
      ),
      0,
    );

    // When a slot is picked for it, once at the head of the queue and once below
    const picked = [
      pickSlot(free, candidate, true, unmeasured)?.name,
      pickSlot(free, candidate, false, unmeasured)?.name,
    ];

    // Then only the head takes the wrong model, so lower tasks keep waiting
    expect(picked).toEqual(["pi-openai-m-1", undefined]);
  });

  test("one slot is never handed to two tasks in the same plan", () => {
    // Given two queued tasks and a single free slot
    const tasks = graph(task({ id: "000001" }), task({ id: "000002" }));

    // When the dispatch is planned
    const dispatches = planOf(tasks, new Set(), [slot("pi-anthropic-m-1")]);

    // Then only the task at the head of the queue is dispatched
    expect(dispatches).toHaveLength(1);
    expect(at(dispatches, 0).candidate.task_id).toBe("000001");
  });

  test("a candidate carries the role the state it sits in is run by", () => {
    // Given one task in each of the reviewed and reviewing states
    const tasks = graph(
      task({ id: "000001", state: "PLAN_REVIEW" }),
      task({ id: "000002", state: "PLAN" }),
      task({ id: "000003", state: "DESIGN_REVIEW" }),
      task({ id: "000004", state: "DESIGN" }),
    );

    // When the queue is built
    const queue = queueOf(tasks, new Set());

    // Then each candidate names the role its stage is run by
    expect(queue.map((c) => c.role)).toEqual([
      "reviewer",
      "planner",
      "reviewer",
      "designer",
    ]);
  });

  test("a slot restricted away from the candidate's role is passed over", () => {
    // Given a task needing a worker, and a free slot restricted to reviewing
    const free: Slot[] = [
      { ...slot("pi-openai-m-1"), roles: ["reviewer"] },
      slot("pi-anthropic-m-2"),
    ];
    const candidate = at(queueOf(graph(task({ id: "000001" })), new Set()), 0);

    // When a slot is picked for it
    const picked = pickSlot(free, candidate, true, unmeasured);

    // Then the unrestricted slot takes it
    expect(present(picked, "a picked slot").name).toBe("pi-anthropic-m-2");
  });

  test("nothing is dispatched when no free slot may take the role", () => {
    // Given a task needing a worker, and only reviewer slots free
    const free: Slot[] = [{ ...slot("pi-openai-m-1"), roles: ["reviewer"] }];
    const tasks = graph(task({ id: "000001" }));

    // When the dispatch is planned
    const dispatches = planOf(tasks, new Set(), free);

    // Then the task waits rather than going to an agent restricted from it
    expect(dispatches).toEqual([]);
  });

  test("nothing is dispatched when every slot is already busy", () => {
    // Given a queued task and no free slot at all
    const tasks = graph(task({ id: "000001" }));

    // When the dispatch is planned
    const dispatches = planOf(tasks, new Set(), []);

    // Then nothing is dispatched, and the task keeps its place in the queue
    expect(dispatches).toEqual([]);
  });

  test("a review with a session to pick back up outranks fresh work", () => {
    // Given fresh work and a review whose session can be resumed
    const tasks = graph(
      task({ id: "000001" }),
      task({ id: "000002", state: "WORK_REVIEW", workspace: workspace() }),
    );

    // When the queue is built
    const queue = queueOf(tasks, new Set(["000002"]));

    // Then the resume leads the queue, as any resume does
    expect(at(queue, 0).task_id).toBe("000002");
    expect(at(queue, 0).rank).toBe("resume");
  });
});

describe("Feature: what is waiting on the manager", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "NEW",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: undefined,
      claimed_pid: undefined,
      held_reason: undefined,
      workspace: undefined,
      checks: [],
      costs: [],
      ...overrides,
    };
  }

  function graph(...tasks: TaskMeta[]): Map<string, TaskMeta> {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  function inboxOf(tasks: Map<string, TaskMeta>) {
    return inbox(tasks, blockingCounts(tasks));
  }

  test("what is closest to closed comes first", () => {
    // Given a new task, two held ones and a task waiting on the manager
    const tasks = graph(
      task({ id: "000001", state: "NEW" }),
      task({ id: "000002", state: "HELD_WORK", held_reason: "a wall" }),
      task({ id: "000003", state: "HELD_PLAN", held_reason: "no plan" }),
      task({ id: "000005", state: "MANAGER_REVIEW" }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the manager sees what is nearest to done at the top of it
    expect(rows.map((row) => row.task_id)).toEqual([
      "000005",
      "000003",
      "000002",
      "000001",
    ]);
    expect(rows.map((row) => row.rank)).toEqual([
      "MANAGER_REVIEW",
      "HELD_PLAN",
      "HELD_WORK",
      "NEW",
    ]);
  });

  test("only what is actually waiting on a person is in the inbox", () => {
    // Given tasks that are queued, running, reviewable by an agent, or blocked
    const tasks = graph(
      task({ id: "000001", state: "WORK" }),
      task({ id: "000002", state: "WORK", claimed_by: "pi-1", claimed_pid: 1 }),
      task({ id: "000003", state: "WORK_REVIEW" }),
      task({ id: "000004", state: "BLOCKED_DESIGN", depends_on: ["000001"] }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then none of them appears, because the pipeline can move them all itself
    expect(rows).toEqual([]);
  });

  test("within a rank the task blocking the most goes first", () => {
    // Given two tasks waiting on the manager, one of them holding up a third
    const tasks = graph(
      task({ id: "000001", state: "MANAGER_REVIEW" }),
      task({ id: "000002", state: "MANAGER_REVIEW" }),
      task({ id: "000003", state: "BLOCKED_DESIGN", depends_on: ["000002"] }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the one unblocking other work is what the manager is shown first
    expect(rows.map((row) => row.task_id)).toEqual(["000002", "000001"]);
    expect(at(rows, 0).blocking).toBe(1);
  });

  test("a held row carries the reason the manager has to answer", () => {
    // Given a task held on something only a person can resolve
    const tasks = graph(
      task({
        id: "000001",
        state: "HELD_WORK",
        held_reason: "the staging database is down",
        state_entered: "2026-07-29T01:00:00Z",
      }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the row says what it is waiting on and since when
    expect(at(rows, 0).held_reason).toBe("the staging database is down");
    expect(at(rows, 0).waiting_since).toBe("2026-07-29T01:00:00Z");
  });

  test("a row names the branch to look at, not the worktree it was built in", () => {
    // Given a task waiting on the manager, with a workspace behind it
    const tasks = graph(
      task({
        id: "000001",
        state: "MANAGER_REVIEW",
        workspace: {
          branch: "work/000001",
          worktree: "/tmp/orchestrator/000001/worktree",
          slot: "pi-1",
          session: undefined,
        },
      }),
    );

    // When the inbox is built
    const rows = inboxOf(tasks);

    // Then the manager is pointed at the branch, which is what outlives the run
    expect(at(rows, 0).branch).toBe("work/000001");
    expect(rows[0]).not.toHaveProperty("worktree");
  });
});
