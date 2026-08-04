import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { type AgentSlot, agentModelKey } from "./agents.ts";
import { CheckRunner, tailOf } from "./checks.ts";
import { blockingCounts } from "./graph.ts";
import { inbox } from "./inbox.ts";
import { candidates, pickSlot, plan } from "./scheduler.ts";
import type { RateOf } from "./rates.ts";
import { ALL_ROLES } from "./states.ts";
import { type TaskMeta } from "./task.ts";
import { DEFAULT_WRITE } from "./sandbox.ts";

describe("the scheduler", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "WORK",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: null,
      claimed_pid: null,
      held_reason: null,
      workspace: null,
      checks: [],
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

  const unmeasured: RateOf = () => null;

  const rates =
    (measured: Record<string, number>): RateOf =>
    (agent) =>
      measured[agent] ?? null;

  function planOf(
    tasks: Map<string, TaskMeta>,
    resumable: Set<string>,
    free: AgentSlot[],
    rate: RateOf = unmeasured,
  ) {
    return plan(tasks, resumable, blockingCounts(tasks), free, rate);
  }

  function workspace(agent = "pi-anthropic-m-1") {
    return {
      branch: "work/000001",
      worktree: "/tmp/wt",
      agent,
      session: "/tmp/s.jsonl",
    };
  }

  const slot = (name: string) => ({
    name,
    agent: agentModelKey(name),
    type: "pi",
    provider: name.split("-")[1]!,
    model: "m",
    slot: 1,
    enabled: true,
    write: DEFAULT_WRITE,
    roles: [...ALL_ROLES],
  });

  test("blocking counts every transitive dependent", () => {
    const counts = blockingCounts(
      graph(
        task({ id: "000001" }),
        task({ id: "000002", depends_on: ["000001"] }),
        task({ id: "000003", depends_on: ["000002"] }),
        task({ id: "000004", depends_on: ["000001"] }),
      ),
    );

    expect(counts.get("000001")).toBe(3);
    expect(counts.get("000002")).toBe(1);
    expect(counts.get("000003")).toBe(0);
  });

  test("the queue runs right to left, closest to done first", () => {
    const queue = queueOf(
      graph(
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
      ),
      new Set(["000004"]),
    );

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
    const queue = queueOf(
      graph(
        task({ id: "000001" }),
        task({ id: "000002" }),
        task({ id: "000003", depends_on: ["000002"] }),
        task({ id: "000004", depends_on: ["000003"] }),
      ),
      new Set(),
    );

    expect(queue[0]!.task_id).toBe("000002");
    expect(queue[0]!.blocking).toBe(2);
  });

  test("a tie on blocking breaks on the id", () => {
    const queue = queueOf(
      graph(task({ id: "000001" }), task({ id: "000002" })),
      new Set(),
    );

    expect(queue.map((c) => c.task_id)).toEqual(["000001", "000002"]);
  });

  test("a held task is never a candidate", () => {
    const queue = queueOf(
      graph(
        task({ id: "000001", state: "HELD_WORK", held_reason: "a wall" }),
        task({ id: "000002", state: "HELD_PLAN", held_reason: "no plan" }),
      ),
      new Set(),
    );
    expect(queue).toEqual([]);
  });

  test("neither is a task somebody else is already holding", () => {
    const queue = queueOf(
      graph(
        task({
          id: "000001",
          state: "WORK",
          claimed_by: "pi-1",
          claimed_pid: 1,
        }),
        task({
          id: "000002",
          state: "CHECK",
          claimed_by: "server",
          claimed_pid: 1,
        }),
      ),
      new Set(),
    );
    expect(queue).toEqual([]);
  });

  test("a resume prefers a free slot of the same model", () => {
    const free = [slot("pi-openai-m-1"), slot("pi-anthropic-m-2")];
    const candidate = queueOf(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(["000001"]),
    )[0]!;

    expect(pickSlot(free, candidate, true, unmeasured)!.name).toBe(
      "pi-anthropic-m-2",
    );
  });

  test("a free choice goes to the fastest agent measured so far", () => {
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = queueOf(graph(task({ id: "000001" })), new Set())[0]!;
    const rate = rates({ "pi-anthropic-m": 12, "pi-openai-m": 30 });

    expect(pickSlot(free, candidate, true, rate)!.name).toBe("pi-openai-m-1");
  });

  test("an agent nobody has measured is tried before a measured one", () => {
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = queueOf(graph(task({ id: "000001" })), new Set())[0]!;

    expect(
      pickSlot(free, candidate, true, rates({ "pi-anthropic-m": 30 }))!.name,
    ).toBe("pi-openai-m-1");
  });

  test("equal rates keep the pool's own order", () => {
    const free = [slot("pi-anthropic-m-1"), slot("pi-openai-m-1")];
    const candidate = queueOf(graph(task({ id: "000001" })), new Set())[0]!;
    const rate = rates({ "pi-anthropic-m": 20, "pi-openai-m": 20 });

    expect(pickSlot(free, candidate, true, rate)!.name).toBe(
      "pi-anthropic-m-1",
    );
  });

  test("going back to the agent that holds the session beats going faster", () => {
    const free = [slot("pi-openai-m-1"), slot("pi-anthropic-m-2")];
    const candidate = queueOf(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(["000001"]),
    )[0]!;
    const rate = rates({ "pi-anthropic-m": 3, "pi-openai-m": 90 });

    expect(pickSlot(free, candidate, true, rate)!.name).toBe(
      "pi-anthropic-m-2",
    );
  });

  test("a task whose own agent is busy falls back to the fastest free one", () => {
    const free = [slot("pi-openai-m-1"), slot("pi-mistral-m-1")];
    const candidate = queueOf(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(),
    )[0]!;
    const rate = rates({ "pi-openai-m": 10, "pi-mistral-m": 50 });

    expect(pickSlot(free, candidate, true, rate)!.name).toBe("pi-mistral-m-1");
  });

  test("the top of the queue falls back to any free slot", () => {
    const free = [slot("pi-openai-m-1")];
    const candidate = queueOf(
      graph(task({ id: "000001", workspace: workspace("pi-anthropic-m-1") })),
      new Set(["000001"]),
    )[0]!;

    expect(pickSlot(free, candidate, true, unmeasured)!.name).toBe(
      "pi-openai-m-1",
    );
    expect(pickSlot(free, candidate, false, unmeasured)).toBeNull();
  });

  test("one slot is never handed to two tasks", () => {
    const dispatches = planOf(
      graph(task({ id: "000001" }), task({ id: "000002" })),
      new Set(),
      [slot("pi-anthropic-m-1")],
    );

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.candidate.task_id).toBe("000001");
  });

  test("a candidate carries the role its state claims", () => {
    const queue = queueOf(
      graph(
        task({ id: "000001", state: "PLAN_REVIEW" }),
        task({ id: "000002", state: "PLAN" }),
        task({ id: "000003", state: "DESIGN_REVIEW" }),
        task({ id: "000004", state: "DESIGN" }),
      ),
      new Set(),
    );

    expect(queue.map((c) => c.role)).toEqual([
      "reviewer",
      "planner",
      "reviewer",
      "designer",
    ]);
  });

  test("a slot that may not take the candidate's role is skipped", () => {
    const free: AgentSlot[] = [
      { ...slot("pi-openai-m-1"), roles: ["reviewer"] },
      slot("pi-anthropic-m-2"),
    ];
    const candidate = queueOf(graph(task({ id: "000001" })), new Set())[0]!;

    expect(pickSlot(free, candidate, true, unmeasured)!.name).toBe(
      "pi-anthropic-m-2",
    );
  });

  test("nothing is planned for a role the pool cannot serve", () => {
    const free: AgentSlot[] = [
      { ...slot("pi-openai-m-1"), roles: ["reviewer"] },
    ];

    expect(
      pickSlot(
        free,
        queueOf(graph(task({ id: "000001" })), new Set())[0]!,
        true,
        unmeasured,
      ),
    ).toBeNull();
    expect(planOf(graph(task({ id: "000001" })), new Set(), free)).toEqual([]);
  });

  test("nothing is planned when the pool is saturated", () => {
    expect(planOf(graph(task({ id: "000001" })), new Set(), [])).toEqual([]);
  });

  test("a review waiting to be redone is a resume like any other", () => {
    const queue = queueOf(
      graph(
        task({ id: "000001" }),
        task({
          id: "000002",
          state: "WORK_REVIEW",
          workspace: workspace(),
        }),
      ),
      new Set(["000002"]),
    );

    expect(queue[0]!.task_id).toBe("000002");
    expect(queue[0]!.rank).toBe("resume");
  });
});

describe("the manager inbox", () => {
  function task(overrides: Partial<TaskMeta>): TaskMeta {
    return {
      id: "000001",
      title: "a task",
      state: "NEW",
      state_entered: "2026-07-29T00:00:00Z",
      depends_on: [],
      claimed_by: null,
      claimed_pid: null,
      held_reason: null,
      workspace: null,
      checks: [],
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
    const rows = inboxOf(
      graph(
        task({ id: "000001", state: "NEW" }),
        task({ id: "000002", state: "HELD_WORK", held_reason: "a wall" }),
        task({ id: "000003", state: "HELD_PLAN", held_reason: "no plan" }),
        task({ id: "000005", state: "MANAGER_REVIEW" }),
      ),
    );

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

  test("only what is actually waiting on a person is in it", () => {
    const rows = inboxOf(
      graph(
        task({ id: "000001", state: "WORK" }),
        task({
          id: "000002",
          state: "WORK",
          claimed_by: "pi-1",
          claimed_pid: 1,
        }),
        task({ id: "000003", state: "WORK_REVIEW" }),
        task({ id: "000004", state: "BLOCKED", depends_on: ["000001"] }),
      ),
    );

    expect(rows).toEqual([]);
  });

  test("within a rank the task blocking the most goes first", () => {
    const rows = inboxOf(
      graph(
        task({ id: "000001", state: "MANAGER_REVIEW" }),
        task({ id: "000002", state: "MANAGER_REVIEW" }),
        task({ id: "000003", state: "BLOCKED", depends_on: ["000002"] }),
      ),
    );

    expect(rows.map((row) => row.task_id)).toEqual(["000002", "000001"]);
    expect(rows[0]!.blocking).toBe(1);
  });

  test("a held row carries the reason the manager has to answer", () => {
    const rows = inboxOf(
      graph(
        task({
          id: "000001",
          state: "HELD_WORK",
          held_reason: "the staging database is down",
          state_entered: "2026-07-29T01:00:00Z",
        }),
      ),
    );

    expect(rows[0]!.held_reason).toBe("the staging database is down");
    expect(rows[0]!.waiting_since).toBe("2026-07-29T01:00:00Z");
  });

  test("a row carries the branch to look at, not the worktree it was built in", () => {
    const rows = inboxOf(
      graph(
        task({
          id: "000001",
          state: "MANAGER_REVIEW",
          workspace: {
            branch: "work/000001",
            worktree: "/tmp/orchestrator/000001/worktree",
            agent: "pi-1",
            session: null,
          },
        }),
      ),
    );

    expect(rows[0]!.branch).toBe("work/000001");
    expect(rows[0]).not.toHaveProperty("worktree");
  });
});

describe("the check runner", () => {
  test("an exit code, a log and an output tail come back", async () => {
    const dir = tempDir("orchestrator-");
    const runner = new CheckRunner();
    const log = path.join(dir, "check-0.log");

    const result = await runner.start(
      "000042",
      0,
      "echo hello; echo bad >&2; exit 2",
      dir,
      log,
    );

    expect(result.code).toBe(2);
    expect(result.tail).toContain("hello");
    expect(result.tail).toContain("bad");
    expect(fs.readFileSync(log, "utf-8")).toContain("hello");
  });

  test("a running check appears in the view and leaves it when it ends", async () => {
    const dir = tempDir("orchestrator-");
    const runner = new CheckRunner();
    const running = runner.start(
      "000042",
      1,
      "sleep 0.2",
      dir,
      path.join(dir, "c.log"),
    );

    expect(runner.view).toHaveLength(1);
    expect(runner.view[0]!.command).toBe("sleep 0.2");
    expect(runner.view[0]!.pid).toBeGreaterThan(0);
    expect(runner.isRunning("000042")).toBe(true);

    await running;
    expect(runner.view).toEqual([]);
  });

  test("the tail keeps the last lines, not the first", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const tail = tailOf(output, 3);
    expect(tail).toBe("line 97\nline 98\nline 99");
  });
});
