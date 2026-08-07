import { describe, expect } from "bun:test";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs";
import path from "node:path";
import { applyTransition } from "../adapters/transition-store.ts";
import { takeClaim } from "../adapters/claim.ts";
import { repoKey } from "../adapters/runtime.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
} from "../testing/fixture.ts";
import { writeCommand } from "../adapters/command.ts";
import { eventually } from "../testing/wait.ts";
import {
  compactionsOf,
  editTaskFile,
  reaches,
  serverFor,
  settle,
  stateOf,
  until,
} from "../testing/server-jig.ts";

describe("Feature: the views the console and the manager read", () => {
  testInTempDirs(
    "an idle slot is a row of nulls, never a missing row",
    async () => {
      // Given a pool of two slots the scheduler has dispatched nothing to
      const fixture = makeFixture(2);
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then every slot is a row, so the console shows the whole pool
      const view = JSON.parse(
        fs.readFileSync(server.runtime.agentsView, "utf-8"),
      );
      expect(view.agents).toHaveLength(2);
      expect(view.agents[0].state).toBe("IDLE");
      expect(view.agents[0].task_id).toBeNull();
      expect(view.agents[1].name).toBe("pi-fake-fake-2");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a busy slot names its task, role, pid and activity",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "Do a thing");
      setPlan(fixture, { [id]: { WORK: [{ notes: "still going" }] } });

      // Given a task the scheduler is about to dispatch
      const server = await serverFor(fixture);

      // When the agent is dispatched and the views are published
      server.setSchedulerEnabled(true);
      await server.tick();

      // Then its row names the task, the role, the process and what it is doing
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
    },
    30000,
  );

  testInTempDirs(
    "every view carries the same transition cursor",
    async () => {
      const fixture = makeFixture();
      readyTask(fixture, "Do a thing");

      // Given a server with a task in its graph
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then every one of them is stamped with the same cursor
      const seqs = [
        server.runtime.agentsView,
        server.runtime.checksView,
        server.runtime.tasksView,
        server.runtime.inboxView,
      ].map((file) => JSON.parse(fs.readFileSync(file, "utf-8")).seq);

      expect(new Set(seqs).size).toBe(1);
      expect(seqs[0]).toBe(server.transitions.cursor);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the tasks view carries the blocking count and the held reason",
    async () => {
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

      // Given a task another task waits on, held on something only a person can fix
      const server = await serverFor(fixture);
      server.claim(dep, { agentName: "a", pid: process.pid });
      server.transition(dep, "hold", { reason: "waiting on a person" }, "test");

      // When the views are published
      await server.writeViews();

      // Then its row says how much it blocks and what it is waiting on
      const view = JSON.parse(
        fs.readFileSync(server.runtime.tasksView, "utf-8"),
      );
      const row = view.tasks.find((task: { id: string }) => task.id === dep);
      expect(row.blocking).toBe(1);
      expect(row.held_reason).toBe("waiting on a person");
      expect(row.state).toBe("HELD_WORK");

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: the queue view", () => {
  testInTempDirs(
    "the queue is what the scheduler would dispatch next, with its own state",
    async () => {
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

      // Given one queued task and one blocked behind it
      const server = await serverFor(fixture);

      // When the views are published with the scheduler paused
      await server.writeViews();

      // Then the queue holds only what could be dispatched, with its own rank
      const view = JSON.parse(
        fs.readFileSync(server.runtime.queueView, "utf-8"),
      );
      expect(view.scheduling).toBe(false);
      expect(view.queue).toHaveLength(1);
      expect(view.queue[0].task_id).toBe(first);
      expect(view.queue[0].rank).toBe("WORK_FRESH");
      expect(view.queue[0].blocking).toBe(1);

      // Then the switch in the view follows the scheduler it draws
      server.setSchedulerEnabled(true);
      await server.writeViews();
      expect(
        JSON.parse(fs.readFileSync(server.runtime.queueView, "utf-8"))
          .scheduling,
      ).toBe(true);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: what the agents view says about a running agent", () => {
  testInTempDirs(
    "tokens, context and the session file reach the view",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      setPlan(fixture, {
        [id]: { WORK: [{ notes: "still going", busy_ms: 3000 }] },
      });

      // Given a task the scheduler is about to dispatch
      const server = await serverFor(fixture);

      // When the agent is dispatched and the views are published
      server.setSchedulerEnabled(true);
      await server.tick();

      // Then the console can show how much context is left and where to read it
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
    },
    30000,
  );

  testInTempDirs(
    "compactions are counted in the view",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task");
      setPlan(fixture, {
        [id]: {
          WORK: [{ compact: "overflow", busy_ms: 3000, notes: "still going" }],
        },
      });

      // Given an agent that will compact part way through its turn
      const server = await serverFor(fixture);

      // When it is dispatched and runs until it compacts
      server.setSchedulerEnabled(true);
      await until(server, () => compactionsOf(server, id) === 1);

      // Then the console can see how often it has compacted on this task
      expect(compactionsOf(server, id)).toBe(1);

      await server.drain();
      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a closed task stays in the tasks view",
    async () => {
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

      // Given work that has been reviewed and is waiting on the manager
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      server.setSchedulerEnabled(false);

      // When the manager merges it and the views are published
      await server.attemptMerge(id);
      await server.writeViews();

      // Then the closed task is still shown, so the manager sees what just landed
      const view = JSON.parse(
        fs.readFileSync(server.runtime.tasksView, "utf-8"),
      );
      const row = view.tasks.find((task: { id: string }) => task.id === id);
      expect(row).toBeDefined();
      expect(row.state).toBe("CLOSED");
      expect(row.title).toBe("A task");
      expect(row.claimed_by).toBeNull();

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: the log of every transition applied", () => {
  testInTempDirs(
    "every applied transition is one line with a from, a to and an author",
    async () => {
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

      // Given a task worked on, checked and reviewed
      const server = await serverFor(fixture);

      // When it runs to the manager
      server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");

      // Then every transition is one numbered line, in the order it happened
      const entries = server.transitions.read();
      expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));

      // Then each line says where the task came from, went to, and who moved it
      const submit = entries.find((e) => e.transition === "submit")!;
      expect(submit.from).toBe("WORK");
      expect(submit.to).toBe("CHECK");
      expect(submit.by).toBe("pi-fake-fake-1");
      expect(entries.some((e) => e.by === "server")).toBe(true);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: commands the console writes for the server", () => {
  const applied = (done: () => boolean) =>
    eventually(done, "applied the console command");

  testInTempDirs(
    "a written command toggles the scheduler and an agent, and is consumed",
    async () => {
      // Given a running server watching for console commands
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the console writes each of the three commands in turn
      writeCommand(server.runtime, { command: "scheduler", enabled: true });
      await applied(() => server.schedulerEnabled);

      // Then each is applied and the file is consumed rather than reapplied
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
    },
    30000,
  );

  testInTempDirs(
    "a command left behind by a dead server is applied at startup",
    async () => {
      // Given a command written while no server was listening
      const fixture = makeFixture();
      const first = await serverFor(fixture);
      first.shutdown();
      writeCommand(first.runtime, { command: "scheduler", enabled: true });

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then it applies the waiting command and consumes it
      expect(second.schedulerEnabled).toBe(true);
      expect(fs.existsSync(second.runtime.consoleCommand)).toBe(false);

      second.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a command naming no agent in the pool is logged, not thrown",
    async () => {
      // Given a running server watching for console commands
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the console names an agent that is not in the pool
      writeCommand(server.runtime, {
        command: "agent",
        agent: "pi-nobody-nothing",
        enabled: false,
      });
      await eventually(
        () =>
          fs
            .readFileSync(server.runtime.serverLog, "utf-8")
            .includes("refused"),
        "logged the refusal",
      );

      // Then the refusal is logged and the server carries on running
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "no agent named",
      );
      expect(server.agentRows()[0]!.enabled).toBe(true);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: turning an agent off and on", () => {
  function pool(fixture: Fixture, entries: Record<string, unknown>[]): void {
    fs.writeFileSync(fixture.agentsPath, JSON.stringify({ agents: entries }));
  }

  testInTempDirs(
    "an agent configured disabled is never dispatched to",
    async () => {
      const fixture = makeFixture();
      const id = readyTask(fixture, "A task nobody picks up");
      pool(fixture, [
        { type: "pi", provider: "fake", model: "fake", enabled: false },
      ]);
      setPlan(fixture, { [id]: { WORK: [{ submit: true }] } });

      // Given a queued task and a pool whose only agent is turned off
      const server = await serverFor(fixture);

      // When the scheduler runs over the graph
      server.setSchedulerEnabled(true);
      await settle(server);

      // Then nothing is dispatched, and the console says why
      expect(stateOf(server, id)).toBe("WORK");
      expect(server.agentRows()[0]!.state).toBe("DISABLED");
      expect(server.agentRows()[0]!.enabled).toBe(false);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "disabling an agent disables every one of its slots",
    async () => {
      const fixture = makeFixture();
      pool(fixture, [
        { type: "pi", provider: "fake", model: "fake", slots: 3 },
        { type: "pi", provider: "other", model: "other", slots: 1 },
      ]);

      // Given a pool of two agents, one of them with three slots
      const server = await serverFor(fixture);
      expect(server.agentRows().every((row) => row.enabled)).toBe(true);

      // When one of them is disabled
      const rows = server.setAgentEnabled("pi-fake-fake", false);

      // Then every slot of that agent is disabled, and the other agent is not
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.state === "DISABLED")).toBe(true);

      const untouched = server
        .agentRows()
        .filter((row) => row.agent === "pi-other-other");
      expect(untouched).toHaveLength(1);
      expect(untouched[0]!.state).toBe("IDLE");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a disabled agent takes no work and a re-enabled one takes it again",
    async () => {
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

      // Given a queued task and an agent that has been disabled
      const server = await serverFor(fixture);
      server.setAgentEnabled("pi-fake-fake", false);
      server.setSchedulerEnabled(true);
      await settle(server);
      expect(stateOf(server, id)).toBe("WORK");

      // When the agent is enabled again
      server.setAgentEnabled("pi-fake-fake", true);

      // Then the task it could not take is dispatched and worked to the manager
      await reaches(server, id, "MANAGER_REVIEW");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot running when its agent is disabled finishes that task first",
    async () => {
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

      // Given an agent part way through a task
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      expect(stateOf(server, id)).toBe("WORK");

      // When its agent is disabled
      const disabled = server.setAgentEnabled("pi-fake-fake", false);

      // Then the slot keeps its task, showing as running under a disabled agent
      expect(disabled[0]!.enabled).toBe(false);
      expect(disabled[0]!.state).not.toBe("DISABLED");
      expect(disabled[0]!.task_id).toBe(id);

      // Then it finishes the work before the slot is taken out of the pool
      await server.drain();
      await settle(server);
      expect(server.agentRows()[0]!.state).toBe("DISABLED");
      expect(server.agentRows()[0]!.task_id).toBeNull();
      expect(stateOf(server, id)).toBe("WORK_REVIEW");

      server.shutdown();
    },
    30000,
  );

  testInTempDirs.each([
    ["pi-fake-fake-1", 'no agent named "pi-fake-fake-1"'],
    ["nope", "the pool has pi-fake-fake"],
  ])(
    "the name %p, which is not an agent in the pool, is refused",
    async (name, refusal) => {
      // Given a server whose pool holds one agent
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When a name the pool does not hold is passed where an agent belongs
      const attempt = () => server.setAgentEnabled(name, false);

      // Then it is refused, and the pool it does have is named
      expect(attempt).toThrow(refusal);

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: aborting the command an agent is running", () => {
  testInTempDirs(
    "aborting a busy slot kills the bash call and the agent finishes its turn",
    async () => {
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

      // Given an agent stuck inside a long-running command
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      const row = server.agentRows()[0]!;
      expect(row.state).toBe("BUSY");
      expect(row.activity.kind).toBe("tool-call");

      // When the manager aborts that command
      server.abortAgent(row.name);
      server.setSchedulerEnabled(false);
      await server.drain();
      await until(server, () => stateOf(server, id) !== "WORK", 20);

      // Then the command is killed and the agent finishes its turn from there
      expect(stateOf(server, id)).not.toBe("WORK");
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting an IDLE slot throws",
    async () => {
      // Given a slot the scheduler has dispatched nothing to
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts it
      const attempt = () => server.abortAgent("pi-fake-fake-1");

      // Then it is refused, because there is no command to kill
      expect(attempt).toThrow(/not running/);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting an unknown slot name throws, listing the pool's slot names",
    async () => {
      // Given a server whose pool holds one slot
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts a slot that is not in the pool
      const attempt = () => server.abortAgent("pi-nobody-1");

      // Then it is refused, and the slot names it does have are listed
      expect(attempt).toThrow(/no agent slot named "pi-nobody-1"/);
      expect(attempt).toThrow(/pi-fake-fake-1/);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting by agent key (no slot suffix) throws",
    async () => {
      // Given a server whose slot names carry a number
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts using the agent key rather than the slot name
      const attempt = () => server.abortAgent("pi-fake-fake");

      // Then it is refused, because an abort names one running process
      expect(attempt).toThrow(/no agent slot named "pi-fake-fake"/);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a written agent_abort command file drives applyCommand and kills the tool call",
    async () => {
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

      // Given an agent stuck inside a long-running command
      const server = await serverFor(fixture);
      server.setSchedulerEnabled(true);
      await server.tick();
      expect(stateOf(server, id)).toBe("WORK");

      // When the console writes an abort for that slot
      writeCommand(server.runtime, {
        command: "agent_abort",
        "agent-name-slot": "pi-fake-fake-1",
      });
      await eventually(
        () =>
          fs
            .readFileSync(server.runtime.serverLog, "utf-8")
            .includes("aborted bash"),
        "killed the command",
      );
      server.setSchedulerEnabled(false);
      await server.drain();
      await until(server, () => stateOf(server, id) !== "WORK", 20);

      // Then the command is killed, exactly as the manager's own abort would
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a written agent_abort naming an idle slot is logged and dropped",
    async () => {
      // Given a slot the scheduler has dispatched nothing to
      const fixture = makeFixture();
      const server = await serverFor(fixture);

      // When the console writes an abort for that slot
      writeCommand(server.runtime, {
        command: "agent_abort",
        "agent-name-slot": "pi-fake-fake-1",
      });
      await eventually(
        () =>
          fs
            .readFileSync(server.runtime.serverLog, "utf-8")
            .includes("refused"),
        "logged the refusal",
      );

      // Then the refusal is logged and the server carries on running
      expect(fs.readFileSync(server.runtime.serverLog, "utf-8")).toContain(
        "not running",
      );

      server.shutdown();
    },
    30000,
  );
});

describe("Feature: a manager that exits while its agents run on", () => {
  testInTempDirs(
    "detaching stops the server listening on the console channel",
    async () => {
      // Given a running server that has applied a console command already
      const fixture = makeFixture();
      const server = await serverFor(fixture);
      writeCommand(server.runtime, { command: "scheduler", enabled: true });
      await eventually(() => server.schedulerEnabled, "started its scheduler");
      expect(server.schedulerEnabled).toBe(true);

      // When the manager detaches from it
      server.detach();

      // Then a command written afterwards is neither consumed nor applied
      writeCommand(server.runtime, { command: "scheduler", enabled: false });
      await Bun.sleep(200);
      expect(fs.existsSync(server.runtime.consoleCommand)).toBe(true);
      expect(server.schedulerEnabled).toBe(true);

      // Then the views it published are left on disk for the next manager
      expect(fs.existsSync(server.runtime.agentsView)).toBe(true);

      server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot still running for a previous manager is not offered as capacity",
    async () => {
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

      // Given a published view naming a slot whose process is still running
      const second = await serverFor(fixture);

      // When a new server starts and ticks with the scheduler on
      second.setSchedulerEnabled(true);
      await second.tick();
      await second.drain();

      // Then the slot is reattached rather than dispatched to again
      const view = JSON.parse(
        fs.readFileSync(second.runtime.agentsView, "utf-8"),
      );
      expect(view.agents[0].state).toBe("BUSY");
      expect(view.agents[0].pid).toBe(alive.pid);
      expect(stateOf(second, id)).toBe("WORK");

      alive.kill();
      second.shutdown();
    },
    30000,
  );
});
