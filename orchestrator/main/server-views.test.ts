import { describe, expect } from "bun:test";
import { at, present } from "../testing/present.ts";
import { testInTempDirs } from "../testing/temp-dirs.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { applyTransition } from "../tasks/adapters/task-documents.ts";
import { takeClaim } from "../tasks/adapters/task-documents.ts";
import { writeAtomic } from "../kernel/adapters/files.ts";
import { viewJson } from "../runtime/adapters/runtime.ts";
import {
  type Fixture,
  makeFixture,
  readyTask,
  setPlan,
} from "../testing/fixture.ts";
import { writeCommand } from "../runtime/adapters/command.ts";
import { readView } from "../console/adapters/tui.ts";
import { idleRow } from "../agents/domain/slots.ts";
import { aSlot } from "../testing/ports.ts";
import {
  compactionsOf,
  editTaskFile,
  transitionsOf,
  pathsOf,
  reaches,
  serverFor,
  settle,
  stateOf,
  ticksUntil,
  until,
  walkTo,
} from "../testing/server-jig.ts";

describe("Feature: the views the console and the manager read", () => {
  testInTempDirs(
    "an idle slot is a row with no task in it, never a missing row",
    async () => {
      // Given a pool of two slots the scheduler has dispatched nothing to
      const fixture = await makeFixture(2);
      const app = await serverFor(fixture);

      // When the views are published
      await app.views.write();

      // Then every slot is a row, so the console shows the whole pool
      const view = await readView(fixture.runtime);
      expect(view.slots).toHaveLength(2);
      expect(at(view.slots, 0).state).toBe("IDLE");
      expect(at(view.slots, 0).task_id).toBeUndefined();
      expect(at(view.slots, 1).name).toBe("pi-fake-fake-2");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When the agent is dispatched and the views are published
      await app.server.tick();

      // Then its row names the task, the role, the process and what it is doing
      const view = await readView(fixture.runtime);
      const busy = present(
        view.slots.find((agent) => agent.task_id === id),
        `a slot row for task `,
      );
      expect(["tool-call", "thinking", "compacting", "none"]).toContain(
        busy.activity.kind,
      );
      expect(busy.role).toBe("worker");
      expect(busy.pid).toBeGreaterThan(0);

      await app.server.drain();
      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "every view carries the same transition cursor",
    async () => {
      const fixture = await makeFixture();
      await readyTask(fixture, "Do a thing");

      // Given a server with a task in its graph
      const app = await serverFor(fixture);

      // When the views are published
      await app.views.write();

      // Then every one of them is stamped with the same cursor
      const seqs = [];
      for (const file of [
        pathsOf(app).slotsView,
        pathsOf(app).checksView,
        pathsOf(app).tasksView,
        pathsOf(app).inboxView,
      ]) {
        seqs.push(JSON.parse(await fs.readFile(file, "utf-8")).seq);
      }

      expect(new Set(seqs).size).toBe(1);
      expect(seqs[0]).toBe((await transitionsOf(app)).cursor);

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.graph.claim(dep, { slotName: "a", pid: process.pid });
      await app.graph.transition(
        dep,
        "hold",
        { reason: "waiting on a person" },
        "test",
      );

      // When the views are published
      await app.views.write();

      // Then its row says how much it blocks and what it is waiting on
      const view = await readView(fixture.runtime);
      const row = present(
        view.tasks.find((task) => task.id === dep),
        `a task row for `,
      );
      expect(row.blocking).toBe(1);
      expect(row.held_reason).toBe("waiting on a person");
      expect(row.state).toBe("HELD_WORK");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // When the views are published with the scheduler paused
      await app.views.write();

      // Then the queue holds only what could be dispatched, with its own rank
      const view = await readView(fixture.runtime);
      expect(view.scheduling).toBe(false);
      expect(view.queue).toHaveLength(1);
      expect(at(view.queue, 0).task_id).toBe(first);
      expect(at(view.queue, 0).rank).toBe("WORK_FRESH");
      expect(at(view.queue, 0).blocking).toBe(1);

      // Then the switch in the view follows the scheduler it draws
      await app.dispatcher.setEnabled(true);
      await app.views.write();
      expect((await readView(fixture.runtime)).scheduling).toBe(true);

      await app.server.shutdown();
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
    "a task authored with no agents still reaches the queue",
    async () => {
      // Given a server whose pool file declares no agents
      const fixture = await emptyPoolFixture();
      const id = await readyTask(fixture, "Do a thing");
      const app = await serverFor(fixture);

      // When the views are published
      await app.views.write();

      // Then the task is queued, waiting for an agent to be added
      const view = await readView(fixture.runtime);
      expect(view.queue.map((one) => one.task_id)).toEqual([id]);
      expect(view.slots).toEqual([]);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "the slots view names the pool file the console tells a person to edit",
    async () => {
      // Given a server whose pool file declares no agents
      const fixture = await emptyPoolFixture();
      const app = await serverFor(fixture);

      // When the views are published
      await app.views.write();

      // Then the slots view carries the path of that file
      expect(
        JSON.parse(await fs.readFile(pathsOf(app).slotsView, "utf-8"))
          .agents_file,
      ).toBe(fixture.agentsPath);

      await app.server.shutdown();
    },
    30000,
  );
});

describe("Feature: what the slots view says about a running agent", () => {
  testInTempDirs(
    "tokens, cost, context and the session file reach the view",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");
      await setPlan(fixture, {
        [id]: { WORK: [{ notes: "still going", busy_ms: 3000 }] },
      });

      // Given a task the scheduler is about to dispatch
      const app = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When the agent is dispatched and the views are published
      await app.server.tick();

      // Then the console can show how much context is left and where to read it
      const view = await readView(fixture.runtime);
      const busy = present(
        view.slots.find((agent) => agent.task_id === id),
        `a slot row for task `,
      );
      expect(busy.state).toBe("BUSY");
      expect(busy.tokens).toBe(105000);
      expect(busy.context_percent).toBe(30);
      expect(busy.cost).toBe(0.45);
      expect(busy.session).toContain("session/worker");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When it is dispatched and runs until it compacts
      await ticksUntil(app, async () => (await compactionsOf(app, id)) === 1);

      // Then the console can see how often it has compacted on this task
      expect(await compactionsOf(app, id)).toBe(1);

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await reaches(app, id, "MANAGER_REVIEW");
      await app.dispatcher.setEnabled(false);

      // When the manager merges it
      await app.lander.merge(id);

      // Then the closed task is still shown, so the manager sees what just landed
      await app.views.write();
      const view = await readView(fixture.runtime);
      const row = present(
        view.tasks.find((task) => task.id === id),
        `a task row for `,
      );
      expect(row.state).toBe("CLOSED");
      expect(row.title).toBe("A task");
      expect(row.claimed_by).toBeUndefined();

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // When it runs to the manager
      await walkTo(app, id, "MANAGER_REVIEW");

      // Then every transition is one numbered line, in the order it happened
      const entries = await (await transitionsOf(app)).read();
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

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // When the console writes the first of the three commands
      await writeCommand(pathsOf(app), {
        command: "scheduler",
        enabled: true,
      });

      // Then each is applied and the file is consumed rather than reapplied
      await ticksUntil(app, () => app.dispatcher.enabled);
      expect(await fs.exists(pathsOf(app).consoleCommand)).toBe(false);

      await writeCommand(pathsOf(app), {
        command: "agent",
        agent: "pi-fake-fake",
        enabled: false,
      });
      await ticksUntil(app, () => !at(app.pool.rows(), 0).enabled);

      await writeCommand(pathsOf(app), {
        command: "scheduler",
        enabled: false,
      });
      await ticksUntil(app, () => !app.dispatcher.enabled);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a command left behind by a dead server is applied at startup",
    async () => {
      // Given a command written while no server was listening
      const fixture = await makeFixture();
      const first = await serverFor(fixture);
      await first.server.shutdown();
      await writeCommand(pathsOf(first), {
        command: "scheduler",
        enabled: true,
      });

      // When a new server starts against the same project
      const second = await serverFor(fixture);

      // Then it applies the waiting command and consumes it
      expect(second.dispatcher.enabled).toBe(true);
      expect(await fs.exists(pathsOf(second).consoleCommand)).toBe(false);

      await second.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a command naming no agent in the pool is logged, not thrown",
    async () => {
      // Given a running server watching for console commands
      const fixture = await makeFixture();
      const app = await serverFor(fixture);

      // When the console names an agent that is not in the pool
      await writeCommand(pathsOf(app), {
        command: "agent",
        agent: "pi-nobody-nothing",
        enabled: false,
      });

      // Then the refusal is logged and the server carries on running
      await ticksUntil(app, async () =>
        (await fs.readFile(pathsOf(app).serverLog, "utf-8")).includes(
          "refused",
        ),
      );
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "no agent named",
      );
      expect(at(app.pool.rows(), 0).enabled).toBe(true);

      await app.server.shutdown();
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
      const app = await serverFor(fixture);

      // Given a server with its scheduler enabled
      await app.dispatcher.setEnabled(true);

      // When the scheduler runs over the graph
      await settle(app);

      // Then nothing is dispatched, and the console says why
      expect(await stateOf(app, id)).toBe("WORK");
      expect(at(app.pool.rows(), 0).state).toBe("DISABLED");
      expect(at(app.pool.rows(), 0).enabled).toBe(false);

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      expect(app.pool.rows().every((row) => row.enabled)).toBe(true);

      // When one of them is disabled
      const rows = await app.pool.setAgentEnabled("pi-fake-fake", false);

      // Then every slot of that agent is disabled, and the other agent is not
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.state === "DISABLED")).toBe(true);

      const untouched = app.pool
        .rows()
        .filter((row) => row.agent === "pi-other-other");
      expect(untouched).toHaveLength(1);
      expect(at(untouched, 0).state).toBe("IDLE");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.pool.setAgentEnabled("pi-fake-fake", false);
      await app.dispatcher.setEnabled(true);
      await settle(app);
      expect(await stateOf(app, id)).toBe("WORK");

      // When the agent is enabled again
      await app.pool.setAgentEnabled("pi-fake-fake", true);

      // Then the task it could not take is dispatched and worked to the manager
      await reaches(app, id, "MANAGER_REVIEW");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await app.server.tick();
      expect(await stateOf(app, id)).toBe("WORK");

      // When its agent is disabled
      const disabled = await app.pool.setAgentEnabled("pi-fake-fake", false);

      // Then the slot keeps its task, showing as running under a disabled agent
      const row = at(disabled, 0);
      expect(row.enabled).toBe(false);
      expect(row.state).not.toBe("DISABLED");
      expect(row.task_id).toBe(id);

      // Then it finishes the work before the slot is taken out of the pool
      await app.server.drain();
      await settle(app);
      expect(at(app.pool.rows(), 0).state).toBe("DISABLED");
      expect(at(app.pool.rows(), 0).task_id).toBeUndefined();
      expect(await stateOf(app, id)).toBe("WORK_REVIEW");

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await app.server.tick();
      const row = at(app.pool.rows(), 0);
      expect(row.state).toBe("BUSY");
      expect(row.activity.kind).toBe("tool-call");

      // When the manager aborts that command
      await app.pool.abortSlot(row.name);

      // Then the command is killed and the agent finishes its turn from there
      await app.dispatcher.setEnabled(false);
      await app.server.drain();
      await until(app, async () => (await stateOf(app, id)) !== "WORK", 20);
      expect(await stateOf(app, id)).not.toBe("WORK");
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await app.dispatcher.setEnabled(true);
      await app.server.tick();
      expect(await stateOf(app, id)).toBe("WORK");

      // When the console writes an abort for that slot
      await writeCommand(pathsOf(app), {
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });

      // Then the command is killed, exactly as the manager's own abort would
      await ticksUntil(app, async () =>
        (await fs.readFile(pathsOf(app).serverLog, "utf-8")).includes(
          "aborted bash",
        ),
      );
      await app.dispatcher.setEnabled(false);
      await app.server.drain();
      await until(app, async () => (await stateOf(app, id)) !== "WORK", 20);
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "aborted bash: git status",
      );

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a written slot_abort naming an idle slot is logged and dropped",
    async () => {
      // Given a slot the scheduler has dispatched nothing to
      const fixture = await makeFixture();
      const app = await serverFor(fixture);

      // When the console writes an abort for that slot
      await writeCommand(pathsOf(app), {
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });

      // Then the refusal is logged and the server carries on running
      await ticksUntil(app, async () =>
        (await fs.readFile(pathsOf(app).serverLog, "utf-8")).includes(
          "refused",
        ),
      );
      expect(await fs.readFile(pathsOf(app).serverLog, "utf-8")).toContain(
        "not running",
      );

      await app.server.shutdown();
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
      const app = await serverFor(fixture);
      await writeCommand(pathsOf(app), {
        command: "scheduler",
        enabled: true,
      });
      await ticksUntil(app, () => app.dispatcher.enabled);
      expect(app.dispatcher.enabled).toBe(true);

      // When the manager detaches from it
      await app.server.detach();

      // Then a command written afterwards is neither consumed nor applied
      await writeCommand(pathsOf(app), {
        command: "scheduler",
        enabled: false,
      });
      await Bun.sleep(200);
      expect(await fs.exists(pathsOf(app).consoleCommand)).toBe(true);
      expect(app.dispatcher.enabled).toBe(true);

      // Then the views it published are left on disk for the next manager
      expect(await fs.exists(pathsOf(app).slotsView)).toBe(true);

      await app.server.shutdown();
    },
    30000,
  );

  testInTempDirs(
    "a slot still running for a previous manager is not offered as capacity",
    async () => {
      const fixture = await makeFixture();
      const id = await readyTask(fixture, "A task");

      const alive = Bun.spawn(["sleep", "30"]);
      await writeAtomic(
        fixture.runtime.slotsView,
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
      await second.dispatcher.setEnabled(true);

      // When a new server starts and ticks with the scheduler on
      await settle(second, 1);

      // Then the slot is reattached rather than dispatched to again
      const view = await readView(fixture.runtime);
      expect(at(view.slots, 0).state).toBe("BUSY");
      expect(at(view.slots, 0).pid).toBe(alive.pid);
      expect(await stateOf(second, id)).toBe("WORK");

      alive.kill();
      await second.server.shutdown();
    },
    30000,
  );
});
