import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "./transition.ts";
import { takeClaim } from "./claim.ts";
import { repoKey } from "./runtime.ts";
import { type Fixture, makeFixture, readyTask, setPlan } from "./fixture.ts";
import type { Activity } from "./activity.ts";
import { writeCommand } from "./command.ts";
import {
  editTaskFile,
  reaches,
  serverFor,
  settle,
  stateOf,
  until,
} from "./server-jig.ts";

describe("the server: the views", () => {
  test("an idle slot is a row of nulls, never a missing row", async () => {
    const fixture = makeFixture(2);
    const server = await serverFor(fixture);
    await server.writeViews();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    expect(view.agents).toHaveLength(2);
    expect(view.agents[0].state).toBe("IDLE");
    expect(view.agents[0].task_id).toBeNull();
    expect(view.agents[1].name).toBe("pi-fake-fake-2");

    server.shutdown();
  }, 30000);

  test("a busy slot names its task, role, pid and activity", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, { [id]: { WORK: [{ notes: "still going" }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    const busy = view.agents.find(
      (agent: { task_id: string | null }) => agent.task_id === id,
    );
    expect(busy).toBeDefined();
    expect(["tool-call", "thinking", "compacting", "none"]).toContain(
      busy.activity.kind,
    );
    expect(busy.role).toBe("worker");
    expect(busy.pid).toBeGreaterThan(0);
    expect(busy.log).toBe(server.runtime.rpcLog(id));

    await server.drain();
    server.shutdown();
  }, 30000);

  test("every view carries the same transition cursor", async () => {
    const fixture = makeFixture();
    readyTask(fixture, "Do a thing");

    const server = await serverFor(fixture);
    await server.writeViews();

    const seqs = [
      server.runtime.agentsView,
      server.runtime.checksView,
      server.runtime.tasksView,
      server.runtime.inboxView,
    ].map((file) => JSON.parse(fs.readFileSync(file, "utf-8")).seq);

    expect(new Set(seqs).size).toBe(1);
    expect(seqs[0]).toBe(server.transitions.cursor);

    server.shutdown();
  }, 30000);

  test("the tasks view carries the blocking count and the held reason", async () => {
    const fixture = makeFixture();
    const dep = readyTask(fixture, "the dependency");
    const held = readyTask(fixture, "the held one");
    applyTransition(fixture.tasksDir, held, "hold", {
      reason: "waiting on its dependency",
    });
    editTaskFile(fixture, held, (meta) => {
      meta.depends_on = [dep];
    });
    applyTransition(fixture.tasksDir, held, "resume", {});

    const server = await serverFor(fixture);
    server.claim(dep, { agentName: "a", pid: process.pid });
    server.transition(dep, "hold", { reason: "waiting on a person" }, "test");
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    const row = view.tasks.find((task: { id: string }) => task.id === dep);
    expect(row.blocking).toBe(1);
    expect(row.held_reason).toBe("waiting on a person");
    expect(row.state).toBe("HELD_WORK");

    server.shutdown();
  }, 30000);
});

describe("the server: the queue view", () => {
  test("the queue is what the scheduler would dispatch next, with its own state", async () => {
    const fixture = makeFixture();
    const first = readyTask(fixture, "the first");
    const second = readyTask(fixture, "the second");
    applyTransition(fixture.tasksDir, second, "hold", {
      reason: "waiting on the first",
    });
    editTaskFile(fixture, second, (meta) => {
      meta.depends_on = [first];
    });
    applyTransition(fixture.tasksDir, second, "resume", {});

    const server = await serverFor(fixture);
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.queueView, "utf-8"));
    expect(view.scheduling).toBe(false);
    expect(view.queue).toHaveLength(1);
    expect(view.queue[0].task_id).toBe(first);
    expect(view.queue[0].rank).toBe("WORK_FRESH");
    expect(view.queue[0].blocking).toBe(1);

    server.setSchedulerEnabled(true);
    await server.writeViews();
    expect(
      JSON.parse(fs.readFileSync(server.runtime.queueView, "utf-8")).scheduling,
    ).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: the agent view", () => {
  test("tokens, context and the session file reach the view", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: { WORK: [{ notes: "still going", busy_ms: 3000 }] },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    const view = JSON.parse(
      fs.readFileSync(server.runtime.agentsView, "utf-8"),
    );
    const busy = view.agents.find(
      (agent: { task_id: string | null }) => agent.task_id === id,
    );

    expect(busy.state).toBe("BUSY");
    expect(busy.tokens).toBe(105000);
    expect(busy.context_percent).toBe(30);
    expect(busy).not.toHaveProperty("cost");
    expect(busy.session).toContain("session/worker");

    await server.drain();
    server.shutdown();
  }, 30000);

  test("compactions are counted in the view", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORK: [{ compact: "overflow", busy_ms: 3000, notes: "still going" }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    const compactions = () => {
      if (!fs.existsSync(server.runtime.agentsView)) {
        return null;
      }
      const view = JSON.parse(
        fs.readFileSync(server.runtime.agentsView, "utf-8"),
      );
      const busy = view.agents.find(
        (agent: { task_id: string | null }) => agent.task_id === id,
      );
      return busy?.compactions ?? null;
    };
    await until(server, () => compactions() === 1);

    expect(compactions()).toBe(1);

    await server.drain();
    server.shutdown();
  }, 30000);

  test("a closed task stays in the tasks view", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");
    server.setSchedulerEnabled(false);

    await server.attemptMerge(id);
    await server.writeViews();

    const view = JSON.parse(fs.readFileSync(server.runtime.tasksView, "utf-8"));
    const row = view.tasks.find((task: { id: string }) => task.id === id);

    expect(row).toBeDefined();
    expect(row.state).toBe("CLOSED");
    expect(row.title).toBe("A task");
    expect(row.claimed_by).toBeNull();

    server.shutdown();
  }, 30000);
});

describe("the server: the transition log", () => {
  test("every applied transition is one line with a from, a to and an author", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "Do a thing");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await reaches(server, id, "MANAGER_REVIEW");

    const entries = server.transitions.read();
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));

    const submit = entries.find((e) => e.transition === "submit")!;
    expect(submit.from).toBe("WORK");
    expect(submit.to).toBe("CHECK");
    expect(submit.by).toBe("pi-fake-fake-1");
    expect(entries.some((e) => e.by === "server")).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: console commands", () => {
  async function applied(done: () => boolean): Promise<void> {
    for (let waited = 0; waited < 200 && !done(); waited++) {
      await Bun.sleep(10);
    }
    if (!done()) {
      throw new Error("the server never applied the console command");
    }
  }

  test("a written command toggles the scheduler and an agent, and is consumed", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, { command: "scheduler", enabled: true });
    await applied(() => server.schedulerEnabled);
    expect(fs.existsSync(server.runtime.consoleCommand)).toBe(false);

    writeCommand(server.runtime, {
      command: "agent",
      agent: "pi-fake-fake",
      enabled: false,
    });
    await applied(() => !server.agentRows()[0]!.enabled);

    writeCommand(server.runtime, { command: "scheduler", enabled: false });
    await applied(() => !server.schedulerEnabled);

    server.shutdown();
  }, 30000);

  test("a command left behind by a dead server is applied at startup", async () => {
    const fixture = makeFixture();
    const first = await serverFor(fixture);
    first.shutdown();
    writeCommand(first.runtime, { command: "scheduler", enabled: true });

    const second = await serverFor(fixture);
    expect(second.schedulerEnabled).toBe(true);
    expect(fs.existsSync(second.runtime.consoleCommand)).toBe(false);

    second.shutdown();
  }, 30000);

  test("a command naming no agent in the pool is logged, not thrown", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, {
      command: "agent",
      agent: "pi-nobody-nothing",
      enabled: false,
    });
    await applied(() =>
      fs.readFileSync(server.runtime.serverLog, "utf-8").includes("refused"),
    );

    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "no agent named",
    );
    expect(server.agentRows()[0]!.enabled).toBe(true);

    server.shutdown();
  }, 30000);
});

describe("the server: enabling and disabling an agent", () => {
  function pool(fixture: Fixture, entries: Record<string, unknown>[]): void {
    fs.writeFileSync(fixture.agentsPath, JSON.stringify({ agents: entries }));
  }

  test("an agent configured disabled is never dispatched to", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task nobody picks up");
    pool(fixture, [
      { type: "pi", provider: "fake", model: "fake", enabled: false },
    ]);
    setPlan(fixture, { [id]: { WORK: [{ submit: true }] } });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await settle(server);

    expect(stateOf(server, id)).toBe("WORK");
    expect(server.agentRows()[0]!.state).toBe("DISABLED");
    expect(server.agentRows()[0]!.enabled).toBe(false);

    server.shutdown();
  }, 30000);

  test("disabling an agent disables every one of its slots", async () => {
    const fixture = makeFixture();
    pool(fixture, [
      { type: "pi", provider: "fake", model: "fake", slots: 3 },
      { type: "pi", provider: "other", model: "other", slots: 1 },
    ]);

    const server = await serverFor(fixture);
    expect(server.agentRows().every((row) => row.enabled)).toBe(true);

    const rows = server.setAgentEnabled("pi-fake-fake", false);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.state === "DISABLED")).toBe(true);

    const untouched = server
      .agentRows()
      .filter((row) => row.agent === "pi-other-other");
    expect(untouched).toHaveLength(1);
    expect(untouched[0]!.state).toBe("IDLE");

    server.shutdown();
  }, 30000);

  test("a disabled agent takes no work and a re-enabled one takes it again", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task", ["true"]);
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
        WORK_REVIEW: [{ submit: true }],
      },
    });

    const server = await serverFor(fixture);
    server.setAgentEnabled("pi-fake-fake", false);
    server.setSchedulerEnabled(true);
    await settle(server);

    expect(stateOf(server, id)).toBe("WORK");

    server.setAgentEnabled("pi-fake-fake", true);
    await reaches(server, id, "MANAGER_REVIEW");

    server.shutdown();
  }, 30000);

  test("a slot running when its agent is disabled finishes that task first", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A slow task");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            start_delay_ms: 250,
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a\n" },
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);

    await server.tick();
    expect(stateOf(server, id)).toBe("WORK");

    const disabled = server.setAgentEnabled("pi-fake-fake", false);
    expect(disabled[0]!.enabled).toBe(false);
    expect(disabled[0]!.state).not.toBe("DISABLED");
    expect(disabled[0]!.task_id).toBe(id);

    await server.drain();
    await settle(server);

    expect(server.agentRows()[0]!.state).toBe("DISABLED");
    expect(server.agentRows()[0]!.task_id).toBeNull();
    expect(stateOf(server, id)).toBe("WORK_REVIEW");

    server.shutdown();
  }, 30000);

  test("an agent that is not in the pool is refused", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.setAgentEnabled("pi-fake-fake-1", false)).toThrow(
      /no agent named "pi-fake-fake-1"/,
    );
    expect(() => server.setAgentEnabled("nope", true)).toThrow(
      /the pool has pi-fake-fake/,
    );

    server.shutdown();
  }, 30000);
});

describe("the server: aborting a tool call", () => {
  test("aborting a busy slot kills the bash call and the agent finishes its turn", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task to abort");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            busy_ms: 30000,
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();

    expect(stateOf(server, id)).toBe("WORK");
    const row = server.agentRows()[0]!;
    expect(row.state).toBe("BUSY");
    expect(row.activity.kind).toBe("tool-call");

    server.abortAgent(row.name);
    server.setSchedulerEnabled(false);
    await server.drain();

    await until(server, () => stateOf(server, id) !== "WORK", 20);

    expect(stateOf(server, id)).not.toBe("WORK");
    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "aborted bash: git status",
    );

    server.shutdown();
  }, 30000);

  test("aborting an IDLE slot throws", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-fake-fake-1")).toThrow(/not running/);

    server.shutdown();
  }, 30000);

  test("aborting an unknown slot name throws, listing the pool's slot names", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-nobody-1")).toThrow(
      /no agent slot named "pi-nobody-1"/,
    );
    expect(() => server.abortAgent("pi-nobody-1")).toThrow(/pi-fake-fake-1/);

    server.shutdown();
  }, 30000);

  test("aborting by agent key (no slot suffix) throws", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    expect(() => server.abortAgent("pi-fake-fake")).toThrow(
      /no agent slot named "pi-fake-fake"/,
    );

    server.shutdown();
  }, 30000);

  test("a slot that is not inside a bash call is refused", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);
    const workers = (
      server as unknown as {
        workers: Map<
          string,
          {
            process: {
              alive: boolean;
              stream: { state: { activity: Activity } };
              abortBash: () => void;
              kill: () => void;
              close: () => void;
            };
          }
        >;
      }
    ).workers;

    const fake = (activity: Activity) => ({
      alive: true,
      stream: { state: { activity } },
      abortBash: () => {},
      kill: () => {},
      close: () => {},
    });

    const worker = workers.get("pi-fake-fake-1")!;

    for (const activity of [
      { kind: "none" } as Activity,
      { kind: "thinking", started_at: Date.now() } as Activity,
      { kind: "compacting", reason: "overflow", started_at: Date.now() },
      {
        kind: "tool-call",
        tool: "read",
        target: "a.txt",
        started_at: Date.now(),
      } as Activity,
    ]) {
      worker.process = fake(activity as Activity);
      expect(() => server.abortAgent("pi-fake-fake-1")).toThrow(
        /not running a bash tool call to abort/,
      );
    }

    server.shutdown();
  }, 30000);

  test("a written agent_abort command file drives applyCommand and kills the tool call", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task to abort via command");
    setPlan(fixture, {
      [id]: {
        WORK: [
          {
            busy_ms: 30000,
            submit: true,
            notes: "did the work",
            commit: { path: "a.txt", contents: "a" },
          },
        ],
      },
    });

    const server = await serverFor(fixture);
    server.setSchedulerEnabled(true);
    await server.tick();
    expect(stateOf(server, id)).toBe("WORK");

    writeCommand(server.runtime, {
      command: "agent_abort",
      "agent-name-slot": "pi-fake-fake-1",
    });
    for (let waited = 0; waited < 200; waited++) {
      await Bun.sleep(10);
      const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
      if (log.includes("aborted bash")) {
        break;
      }
    }
    server.setSchedulerEnabled(false);
    await server.drain();
    await until(server, () => stateOf(server, id) !== "WORK", 20);

    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "aborted bash: git status",
    );

    server.shutdown();
  }, 30000);

  test("a written agent_abort naming an idle slot is logged and dropped", async () => {
    const fixture = makeFixture();
    const server = await serverFor(fixture);

    writeCommand(server.runtime, {
      command: "agent_abort",
      "agent-name-slot": "pi-fake-fake-1",
    });
    for (let waited = 0; waited < 200; waited++) {
      await Bun.sleep(10);
      const log = fs.readFileSync(server.runtime.serverLog, "utf-8");
      if (log.includes("refused")) {
        break;
      }
    }

    expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
      "not running",
    );

    server.shutdown();
  }, 30000);
});

describe("the server: detaching", () => {
  test("a slot still running for a previous manager is not offered as capacity", async () => {
    const fixture = makeFixture();
    const id = readyTask(fixture, "A task");

    const alive = Bun.spawn(["sleep", "30"]);
    const runtimeDir = path.join(fixture.serverRoot, repoKey(fixture.repo));
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "agents.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        seq: 1,
        agents: [
          {
            name: "pi-fake-fake-1",
            type: "pi",
            provider: "fake",
            model: "fake",
            slot: 1,
            state: "BUSY",
            task_id: id,
            role: "worker",
            pid: alive.pid,
            started_at: new Date().toISOString(),
            activity: { kind: "none" },
            tokens: null,
            context_percent: null,
            session: "/tmp/s.jsonl",
            log: null,
          },
        ],
      }),
    );

    takeClaim(fixture.tasksDir, id, {
      agentName: "pi-fake-fake-1",
      pid: alive.pid,
    });

    const second = await serverFor(fixture);
    second.setSchedulerEnabled(true);
    await second.tick();
    await second.drain();

    const view = JSON.parse(
      fs.readFileSync(second.runtime.agentsView, "utf-8"),
    );
    expect(view.agents[0].state).toBe("BUSY");
    expect(view.agents[0].pid).toBe(alive.pid);
    expect(stateOf(second, id)).toBe("WORK");

    alive.kill();
    second.shutdown();
  }, 30000);
});
