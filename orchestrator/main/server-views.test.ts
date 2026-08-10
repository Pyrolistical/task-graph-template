import { describe, expect } from "bun:test";
import { at, present } from "../testing/present.ts";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { applyTransition } from "../adapters/task-documents.ts";
import { takeClaim } from "../adapters/task-documents.ts";
import { writeAtomic } from "../adapters/files.ts";
import { viewJson } from "../adapters/runtime.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
} from "../testing/fixture.ts";
import { writeCommand } from "../adapters/command.ts";
import { readView } from "../adapters/tui.ts";
import { idleRow } from "../domain/agents.ts";
import { aSlot } from "../testing/ports.ts";
import {
  compactionsOf,
  editTaskFile,
  transitionsOf,
  pathsOf,
  reaches,
  runtimeOf,
  serverFor,
  settle,
  stateOf,
  ticksUntil,
  until,
  walkTo,
} from "../testing/server-jig.ts";

describe("Feature: the views the console and the manager read", () => {
  testInTempDirs(
    "an idle slot is a row of nulls, never a missing row",
    async () => {
      // Given a pool of two slots the scheduler has dispatched nothing to
      const fixture = await makeFixture(2);
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then every slot is a row, so the console shows the whole pool
      const view = await readView(await runtimeOf(fixture));
      expect(view.slots).toHaveLength(2);
      expect(at(view.slots, 0).state).toBe("IDLE");
      expect(at(view.slots, 0).task_id).toBeNull();
      expect(at(view.slots, 1).name).toBe("pi-fake-fake-2");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a busy slot names its task, role, pid and activity",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, { [id]: { WORK: [{ notes: "still going" }] } });

      // Given a task the scheduler is about to dispatch
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the agent is dispatched and the views are published
      await server.tick();

      // Then its row names the task, the role, the process and what it is doing
      const view = await readView(await runtimeOf(fixture));
      const busy = present(
        view.slots.find((agent) => agent.task_id === id),
        `a slot row for task `,
      );
      expect(["tool-call", "thinking", "compacting", "none"]).toContain(
        busy.activity.kind,
      );
      expect(busy.role).toBe("worker");
      expect(busy.pid).toBeGreaterThan(0);

      await server.drain();
      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "every view carries the same transition cursor",
    async () => {
      const fixture = await makeFixture();
      await readyTask(fixture, "Do a thing");

      // Given a server with a task in its graph
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then every one of them is stamped with the same cursor
      const seqs = [];
      for (const file of [
        pathsOf(server).slotsView,
        pathsOf(server).checksView,
        pathsOf(server).tasksView,
        pathsOf(server).inboxView,
      ]) {
        seqs.push(JSON.parse(await fs.readFile(file, "utf-8")).seq);
      }

      expect(new Set(seqs).size).toBe(1);
      expect(seqs[0]).toBe((await transitionsOf(server)).cursor);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the tasks view carries the blocking count and the held reason",
    async () => {
      const fixture = await makeFixture();
      const dep = await readyTask(fixture, "the dependency");
      const held = await readyTask(fixture, "the held one");
      await applyTransition(fixture.tasksDir, held, "hold", {
        reason: "waiting on its dependency",
      });
      await editTaskFile(fixture, held, (meta) => {
        meta.depends_on = [dep];
      });
      await applyTransition(fixture.tasksDir, held, "resume", {});

      // Given a task another task waits on, held on something only a person can fix
      const server = await serverFor(fixture);
      await server.claim(dep, { slotName: "a", pid: process.pid });
      await server.transition(
        dep,
        "hold",
        { reason: "waiting on a person" },
        "test",
      );

      // When the views are published
      await server.writeViews();

      // Then its row says how much it blocks and what it is waiting on
      const view = await readView(await runtimeOf(fixture));
      const row = present(
        view.tasks.find((task) => task.id === dep),
        `a task row for `,
      );
      expect(row.blocking).toBe(1);
      expect(row.held_reason).toBe("waiting on a person");
      expect(row.state).toBe("HELD_WORK");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: the queue view", () => {
  testInTempDirs(
    "the queue is what the scheduler would dispatch next, with its own state",
    async () => {
      const fixture = await makeFixture();
      const first = await readyTask(fixture, "the first");
      const second = await readyTask(fixture, "the second");
      await applyTransition(fixture.tasksDir, second, "hold", {
        reason: "waiting on the first",
      });
      await editTaskFile(fixture, second, (meta) => {
        meta.depends_on = [first];
      });
      await applyTransition(fixture.tasksDir, second, "resume", {});

      // Given one queued task and one blocked behind it
      const server = await serverFor(fixture);

      // When the views are published with the scheduler paused
      await server.writeViews();

      // Then the queue holds only what could be dispatched, with its own rank
      const view = await readView(await runtimeOf(fixture));
      expect(view.scheduling).toBe(false);
      expect(view.queue).toHaveLength(1);
      expect(at(view.queue, 0).task_id).toBe(first);
      expect(at(view.queue, 0).rank).toBe("WORK_FRESH");
      expect(at(view.queue, 0).blocking).toBe(1);

      // Then the switch in the view follows the scheduler it draws
      await server.setSchedulerEnabled(true);
      await server.writeViews();
      expect((await readView(await runtimeOf(fixture))).scheduling).toBe(true);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a pool with no agents in it", () => {
  async function emptyPoolFixture(): Promise<Fixture> {
    const fixture = await makeFixture();
    await fs.writeFile(fixture.agentsPath, JSON.stringify({ agents: [] }));
    return fixture;
  }

  testInTempDirs(
    "starting the scheduler is refused, naming the file to add an agent to",
    async () => {
      // Given a server whose pool file declares no agents
      const fixture = await emptyPoolFixture();
      const server = await serverFor(fixture);

      // When the scheduler is started
      const attempt = server.setSchedulerEnabled(true);

      // Then it is refused, naming the pool file a person can add an agent to
      await expect(attempt).rejects.toThrow(`add one to ${fixture.agentsPath}`);
      expect(server.schedulerEnabled).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a task authored with no agents still reaches the queue",
    async () => {
      // Given a server whose pool file declares no agents
      const fixture = await emptyPoolFixture();
      const id = await readyTask(fixture, "Do a thing");
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then the task is queued, waiting for an agent to be added
      const view = await readView(await runtimeOf(fixture));
      expect(view.queue.map((one) => one.task_id)).toEqual([id]);
      expect(view.slots).toEqual([]);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the slots view names the pool file the console tells a person to edit",
    async () => {
      // Given a server whose pool file declares no agents
      const fixture = await emptyPoolFixture();
      const server = await serverFor(fixture);

      // When the views are published
      await server.writeViews();

      // Then the slots view carries the path of that file
      expect(
        JSON.parse(await fs.readFile(pathsOf(server).slotsView, "utf-8"))
          .agents_file,
      ).toBe(fixture.agentsPath);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: what the slots view says about a running agent", () => {
  testInTempDirs(
    "tokens, context and the session file reach the view",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: { WORK: [{ notes: "still going", busy_ms: 3000 }] },
      });

      // Given a task the scheduler is about to dispatch
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the agent is dispatched and the views are published
      await server.tick();

      // Then the console can show how much context is left and where to read it
      const view = await readView(await runtimeOf(fixture));
      const busy = present(
        view.slots.find((agent) => agent.task_id === id),
        `a slot row for task `,
      );
      expect(busy.state).toBe("BUSY");
      expect(busy.tokens).toBe(105000);
      expect(busy.context_percent).toBe(30);
      expect(busy).not.toHaveProperty("cost");
      expect(busy.session).toContain("session/worker");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "compactions are counted in the view",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: {
          WORK: [{ compact: "overflow", busy_ms: 3000, notes: "still going" }],
        },
      });

      // Given an agent that will compact part way through its turn
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When it is dispatched and runs until it compacts
      await ticksUntil(
        server,
        async () => (await compactionsOf(server, id)) === 1,
      );

      // Then the console can see how often it has compacted on this task
      expect(await compactionsOf(server, id)).toBe(1);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a closed task stays in the tasks view",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
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
      await server.setSchedulerEnabled(true);
      await reaches(server, id, "MANAGER_REVIEW");
      await server.setSchedulerEnabled(false);

      // When the manager merges it
      await server.submit(id);

      // Then the closed task is still shown, so the manager sees what just landed
      await server.writeViews();
      const view = await readView(await runtimeOf(fixture));
      const row = present(
        view.tasks.find((task) => task.id === id),
        `a task row for `,
      );
      expect(row.state).toBe("CLOSED");
      expect(row.title).toBe("A task");
      expect(row.claimed_by).toBeNull();

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: the log of every transition applied", () => {
  testInTempDirs(
    "every applied transition is one line with a from, a to and an author",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "Do a thing");
      await setPlan(fixture, {
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
      await walkTo(server, id, "MANAGER_REVIEW");

      // Then every transition is one numbered line, in the order it happened
      const entries = await (await transitionsOf(server)).read();
      expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));

      // Then each line says where the task came from, went to, and who moved it
      const submit = present(
        entries.find((e) => e.transition === "submit"),
        "a submit entry",
      );
      expect(submit.from).toBe("WORK");
      expect(submit.to).toBe("CHECK");
      expect(submit.by).toBe("pi-fake-fake-1");
      expect(entries.some((e) => e.by === "server")).toBe(true);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: commands the console writes for the server", () => {
  testInTempDirs(
    "a written command toggles the scheduler and an agent, and is consumed",
    async () => {
      // Given a running server watching for console commands
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the console writes the first of the three commands
      await writeCommand(pathsOf(server), {
        command: "scheduler",
        enabled: true,
      });

      // Then each is applied and the file is consumed rather than reapplied
      await ticksUntil(server, () => server.schedulerEnabled);
      expect(await fs.exists(pathsOf(server).consoleCommand)).toBe(false);

      await writeCommand(pathsOf(server), {
        command: "agent",
        agent: "pi-fake-fake",
        enabled: false,
      });
      await ticksUntil(server, () => !at(server.slotRows(), 0).enabled);

      await writeCommand(pathsOf(server), {
        command: "scheduler",
        enabled: false,
      });
      await ticksUntil(server, () => !server.schedulerEnabled);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a command left behind by a dead server is applied at startup",
    async () => {
      // Given a command written while no server was listening
      const fixture = await makeFixture();
      const first = await serverFor(fixture);
      await first.shutdown();
      await writeCommand(pathsOf(first), {
        command: "scheduler",
        enabled: true,
      });

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then it applies the waiting command and consumes it
      expect(second.schedulerEnabled).toBe(true);
      expect(await fs.exists(pathsOf(second).consoleCommand)).toBe(false);

      await second.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a command naming no agent in the pool is logged, not thrown",
    async () => {
      // Given a running server watching for console commands
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the console names an agent that is not in the pool
      await writeCommand(pathsOf(server), {
        command: "agent",
        agent: "pi-nobody-nothing",
        enabled: false,
      });

      // Then the refusal is logged and the server carries on running
      await ticksUntil(server, async () =>
        (await fs.readFile(pathsOf(server).serverLog, "utf-8")).includes(
          "refused",
        ),
      );
      expect(await fs.readFile(pathsOf(server).serverLog, "utf-8")).toContain(
        "no agent named",
      );
      expect(at(server.slotRows(), 0).enabled).toBe(true);

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: turning an agent off and on", () => {
  async function pool(
    fixture: Fixture,
    entries: Record<string, unknown>[],
  ): Promise<void> {
    await fs.writeFile(fixture.agentsPath, JSON.stringify({ agents: entries }));
  }

  testInTempDirs(
    "an agent configured disabled is never dispatched to",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task nobody picks up");
      await pool(fixture, [
        { type: "pi", provider: "fake", model: "fake", enabled: false },
      ]);
      await setPlan(fixture, { [id]: { WORK: [{ submit: true }] } });

      // Given a queued task and a pool whose only agent is turned off
      const server = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await server.setSchedulerEnabled(true);

      // When the scheduler runs over the graph
      await settle(server);

      // Then nothing is dispatched, and the console says why
      expect(await stateOf(server, id)).toBe("WORK");
      expect(at(server.slotRows(), 0).state).toBe("DISABLED");
      expect(at(server.slotRows(), 0).enabled).toBe(false);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "disabling an agent disables every one of its slots",
    async () => {
      const fixture = await makeFixture();
      await pool(fixture, [
        { type: "pi", provider: "fake", model: "fake", slots: 3 },
        { type: "pi", provider: "other", model: "other", slots: 1 },
      ]);

      // Given a pool of two agents, one of them with three slots
      const server = await serverFor(fixture);
      expect(server.slotRows().every((row) => row.enabled)).toBe(true);

      // When one of them is disabled
      const rows = await server.setAgentEnabled("pi-fake-fake", false);

      // Then every slot of that agent is disabled, and the other agent is not
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.state === "DISABLED")).toBe(true);

      const untouched = server
        .slotRows()
        .filter((row) => row.agent === "pi-other-other");
      expect(untouched).toHaveLength(1);
      expect(at(untouched, 0).state).toBe("IDLE");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a disabled agent takes no work and a re-enabled one takes it again",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task", ["true"]);
      await setPlan(fixture, {
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
      await server.setAgentEnabled("pi-fake-fake", false);
      await server.setSchedulerEnabled(true);
      await settle(server);
      expect(await stateOf(server, id)).toBe("WORK");

      // When the agent is enabled again
      await server.setAgentEnabled("pi-fake-fake", true);

      // Then the task it could not take is dispatched and worked to the manager
      await reaches(server, id, "MANAGER_REVIEW");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot running when its agent is disabled finishes that task first",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A slow task");
      await setPlan(fixture, {
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
      await server.setSchedulerEnabled(true);
      await server.tick();
      expect(await stateOf(server, id)).toBe("WORK");

      // When its agent is disabled
      const disabled = await server.setAgentEnabled("pi-fake-fake", false);

      // Then the slot keeps its task, showing as running under a disabled agent
      const row = at(disabled, 0);
      expect(row.enabled).toBe(false);
      expect(row.state).not.toBe("DISABLED");
      expect(row.task_id).toBe(id);

      // Then it finishes the work before the slot is taken out of the pool
      await server.drain();
      await settle(server);
      expect(at(server.slotRows(), 0).state).toBe("DISABLED");
      expect(at(server.slotRows(), 0).task_id).toBeNull();
      expect(await stateOf(server, id)).toBe("WORK_REVIEW");

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot name passed where an agent belongs is refused",
    async () => {
      // Given a server whose pool holds the one agent pi-fake-fake
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the name of that agent's first slot is passed where an agent belongs
      const attempt = server.setAgentEnabled("pi-fake-fake-1", false);

      // Then it is refused as no agent of that name
      await expect(attempt).rejects.toThrow('no agent named "pi-fake-fake-1"');

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a name the pool never held is refused with the agents it does hold",
    async () => {
      // Given a server whose pool holds the one agent pi-fake-fake
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the name nope is passed where an agent belongs
      const attempt = server.setAgentEnabled("nope", false);

      // Then it is refused, and the pool it does have is named
      await expect(attempt).rejects.toThrow("the pool has pi-fake-fake");

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: aborting the command an agent is running", () => {
  testInTempDirs(
    "aborting a busy slot kills the bash call and the agent finishes its turn",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task to abort");
      await setPlan(fixture, {
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
      await server.setSchedulerEnabled(true);
      await server.tick();
      const row = at(server.slotRows(), 0);
      expect(row.state).toBe("BUSY");
      expect(row.activity.kind).toBe("tool-call");

      // When the manager aborts that command
      await server.abortSlot(row.name);

      // Then the command is killed and the agent finishes its turn from there
      await server.setSchedulerEnabled(false);
      await server.drain();
      await until(
        server,
        async () => (await stateOf(server, id)) !== "WORK",
        20,
      );
      expect(await stateOf(server, id)).not.toBe("WORK");
      expect(await fs.readFile(pathsOf(server).serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting an IDLE slot throws",
    async () => {
      // Given a slot the scheduler has dispatched nothing to
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts it
      const attempt = server.abortSlot("pi-fake-fake-1");

      // Then it is refused, because there is no command to kill
      await expect(attempt).rejects.toThrow(/not running/);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting an unknown slot name throws, listing the pool's slot names",
    async () => {
      // Given a server whose pool holds one slot
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts a slot that is not in the pool
      const attempt = server.abortSlot("pi-nobody-1");

      // Then it is refused, and the slot names it does have are listed
      await expect(attempt).rejects.toThrow(
        /no agent slot named "pi-nobody-1"/,
      );
      await expect(attempt).rejects.toThrow(/pi-fake-fake-1/);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "aborting by agent key (no slot suffix) throws",
    async () => {
      // Given a server whose slot names carry a number
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the manager aborts using the agent key rather than the slot name
      const attempt = server.abortSlot("pi-fake-fake");

      // Then it is refused, because an abort names one running process
      await expect(attempt).rejects.toThrow(
        /no agent slot named "pi-fake-fake"/,
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a written slot_abort command file drives applyCommand and kills the tool call",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task to abort via command");
      await setPlan(fixture, {
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
      await server.setSchedulerEnabled(true);
      await server.tick();
      expect(await stateOf(server, id)).toBe("WORK");

      // When the console writes an abort for that slot
      await writeCommand(pathsOf(server), {
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });

      // Then the command is killed, exactly as the manager's own abort would
      await ticksUntil(server, async () =>
        (await fs.readFile(pathsOf(server).serverLog, "utf-8")).includes(
          "aborted bash",
        ),
      );
      await server.setSchedulerEnabled(false);
      await server.drain();
      await until(
        server,
        async () => (await stateOf(server, id)) !== "WORK",
        20,
      );
      expect(await fs.readFile(pathsOf(server).serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a written slot_abort naming an idle slot is logged and dropped",
    async () => {
      // Given a slot the scheduler has dispatched nothing to
      const fixture = await makeFixture();
      const server = await serverFor(fixture);

      // When the console writes an abort for that slot
      await writeCommand(pathsOf(server), {
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });

      // Then the refusal is logged and the server carries on running
      await ticksUntil(server, async () =>
        (await fs.readFile(pathsOf(server).serverLog, "utf-8")).includes(
          "refused",
        ),
      );
      expect(await fs.readFile(pathsOf(server).serverLog, "utf-8")).toContain(
        "not running",
      );

      await server.shutdown();
    },
    30000,
  );
});

describe("Feature: a manager that exits while its agents run on", () => {
  testInTempDirs(
    "detaching stops the server listening on the console channel",
    async () => {
      // Given a running server that has applied a console command already
      const fixture = await makeFixture();
      const server = await serverFor(fixture);
      await writeCommand(pathsOf(server), {
        command: "scheduler",
        enabled: true,
      });
      await ticksUntil(server, () => server.schedulerEnabled);
      expect(server.schedulerEnabled).toBe(true);

      // When the manager detaches from it
      await server.detach();

      // Then a command written afterwards is neither consumed nor applied
      await writeCommand(pathsOf(server), {
        command: "scheduler",
        enabled: false,
      });
      await Bun.sleep(200);
      expect(await fs.exists(pathsOf(server).consoleCommand)).toBe(true);
      expect(server.schedulerEnabled).toBe(true);

      // Then the views it published are left on disk for the next manager
      expect(await fs.exists(pathsOf(server).slotsView)).toBe(true);

      await server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot still running for a previous manager is not offered as capacity",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");

      const alive = Bun.spawn(["sleep", "30"]);
      const runtime = await runtimeOf(fixture);
      await writeAtomic(
        runtime.slotsView,
        viewJson(
          1,
          "slots",
          [
            {
              ...idleRow(aSlot()),
              state: "BUSY",
              task_id: id,
              role: "worker",
              pid: alive.pid,
              started_at: new Date().toISOString(),
              session: "/tmp/s.jsonl",
            },
          ],
          { agents_file: path.join(fixture.repo, "agents.json") },
        ),
      );

      await takeClaim(fixture.tasksDir, id, {
        slotName: "pi-fake-fake-1",
        pid: alive.pid,
      });

      // Given a published view naming a slot whose process is still running
      const second = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await second.setSchedulerEnabled(true);

      // When a new server starts and ticks with the scheduler on
      await settle(second, 1);

      // Then the slot is reattached rather than dispatched to again
      const view = await readView(await runtimeOf(fixture));
      expect(at(view.slots, 0).state).toBe("BUSY");
      expect(at(view.slots, 0).pid).toBe(alive.pid);
      expect(await stateOf(second, id)).toBe("WORK");

      alive.kill();
      await second.shutdown();
    },
    30000,
  );
});
