import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../../testing/temp-dirs.ts";
import { eventually } from "../../testing/wait.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { Sessions, SessionTail, frame, frameOrError, readView } from "./tui.ts";
import {
  type Command,
  takeCommand,
  watchCommands,
  writeCommand,
} from "../../runtime/adapters/command.ts";
import { writeAtomic } from "../../kernel/adapters/files.ts";
import { Runtime, viewJson } from "../../runtime/adapters/runtime.ts";
import { idleRow } from "../../agents/domain/slots.ts";
import { HIDE, SHOW } from "../policy/screen.ts";
import { Toggles } from "../policy/toggles.ts";
import {
  SLOTS,
  busyRow,
  candidateOf,
  layoutOf,
  taskRowOf,
} from "../../testing/console.ts";
import { at } from "../../testing/present.ts";

async function write(filePath: string, records: unknown[]): Promise<void> {
  await fs.appendFile(
    filePath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf-8",
  );
}

function assistant(text: string): unknown {
  return {
    type: "message",
    timestamp: 0,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 2, cacheRead: 3 },
    },
  };
}

describe("Feature: tailing the session an agent is writing", () => {
  testInTempDirs(
    "only what was appended since the last read is parsed",
    async () => {
      // Given a session file with one turn in it, already read once
      const file = path.join(await tempDir("console-"), "session.jsonl");
      await write(file, [assistant("first")]);
      const tail: SessionTail = new SessionTail(file);
      expect((await tail.read()).map((entry) => entry.text)).toEqual(["first"]);

      // Given another turn appended to the file
      await write(file, [assistant("second")]);

      // When the file is read again
      const entries = await tail.read();

      // Then the new turn joins the old ones rather than replacing them
      expect(entries.map((entry) => entry.text)).toEqual(["first", "second"]);

      // Then each turn leaves one usage sample behind for the rate meter
      expect(tail.samples).toEqual([
        { timestampMs: 0, tokens: 2 },
        { timestampMs: 0, tokens: 2 },
      ]);
    },
  );

  testInTempDirs("only the last ten usage samples are kept", async () => {
    // Given a session with twelve turns written to it
    const file = path.join(await tempDir("console-"), "session.jsonl");
    await write(
      file,
      Array.from({ length: 12 }, (_, index) => assistant(`m${index}`)),
    );

    // Given a tail over the session file
    const tail: SessionTail = new SessionTail(file);

    // When the whole session is read
    const entries = await tail.read();

    // Then every turn is in the transcript, but the rate is over the recent ones
    expect(entries).toHaveLength(12);
    expect(tail.samples).toHaveLength(10);
  });

  testInTempDirs(
    "a session rewritten from the start is read afresh",
    async () => {
      // Given a session that has been read, then truncated and written over
      const file = path.join(await tempDir("console-"), "session.jsonl");
      await write(file, [assistant("first"), assistant("second")]);
      const tail: SessionTail = new SessionTail(file);
      expect(await tail.read()).toHaveLength(2);
      await fs.writeFile(file, "", "utf-8");
      await write(file, [assistant("fresh")]);

      // When the file is read again
      const entries = await tail.read();

      // Then the old turns are dropped and only the new session is shown
      expect(entries.map((entry) => entry.text)).toEqual(["fresh"]);
      expect(tail.samples).toEqual([{ timestampMs: 0, tokens: 2 }]);
    },
  );

  testInTempDirs(
    "a half written line is held until its newline arrives",
    async () => {
      // Given a session file caught mid-write, with no newline yet
      const file = path.join(await tempDir("console-"), "session.jsonl");
      const record = JSON.stringify(assistant("split"));
      await fs.writeFile(file, record.slice(0, 12), "utf-8");
      const tail: SessionTail = new SessionTail(file);
      expect(await tail.read()).toEqual([]);

      // Given the rest of the line, and its newline, written
      await fs.appendFile(file, `${record.slice(12)}\n`, "utf-8");

      // When the file is read
      const entries = await tail.read();

      // Then the turn is parsed whole rather than half of it being dropped
      expect(entries.map((entry) => entry.text)).toEqual(["split"]);
    },
  );

  testInTempDirs(
    "a session file that is not there yet reads as empty",
    async () => {
      // Given a session path the agent has not written to yet
      const file = path.join(await tempDir("console-"), "nothing.jsonl");

      // When the file is read
      const tail: SessionTail = new SessionTail(file);

      // Then it reads as an empty transcript rather than failing the frame
      expect(await tail.read()).toEqual([]);
    },
  );

  testInTempDirs("two frames at once never read a turn twice", async () => {
    // Given a session file with two turns in it
    const file = path.join(await tempDir("console-"), "session.jsonl");
    await write(file, [assistant("first"), assistant("second")]);
    const tail: SessionTail = new SessionTail(file);

    // When the tail is read twice at once
    const [first, second] = await Promise.all([tail.read(), tail.read()]);

    // Then each reader sees each turn exactly once
    expect(first.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(second.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(tail.samples).toHaveLength(2);
  });
});

describe("Feature: the sessions the console is following", () => {
  testInTempDirs(
    "a session has no rate until its file has been read",
    async () => {
      // Given a session file the console has never read
      const file = path.join(await tempDir("console-"), "session.jsonl");
      await write(file, [assistant("hi")]);
      const sessions: Sessions = new Sessions();
      expect(sessions.rate(5000, file)).toBeUndefined();

      // When the console reads the session
      await sessions.entries(file);

      // Then the rate is measured from the samples that read left behind
      expect(sessions.rate(5000, file)).toBe(0.4);
    },
  );

  testInTempDirs("a slot with no session at all reads as empty", async () => {
    // Given an idle slot, which names no session
    const sessions: Sessions = new Sessions();

    // When the console asks for its transcript
    const entries = await sessions.entries(undefined);

    // Then it gets nothing, and no rate either
    expect(entries).toEqual([]);
    expect(sessions.rate(5000)).toBeUndefined();
  });

  testInTempDirs("a session no slot names any more is forgotten", async () => {
    // Given a session the console has read and measured
    const file = path.join(await tempDir("console-"), "session.jsonl");
    await write(file, [assistant("hi")]);
    const sessions: Sessions = new Sessions();
    await sessions.entries(file);

    // When the frame is drawn without that session in it
    await sessions.keep(new Set());

    // Then the console drops it, rather than tailing a file nothing shows
    expect(sessions.rate(5000, file)).toBeUndefined();
  });
});

describe("Feature: the command channel between console and server", () => {
  function runtimeIn(root: string): Promise<Runtime> {
    return Runtime.open(path.join(root, "repo"), root);
  }

  testInTempDirs(
    "a command the console wrote is taken exactly once",
    async () => {
      // Given a console that has written a command for the server
      const runtime = await runtimeIn(await tempDir("console-"));
      expect(
        await writeCommand(runtime, { command: "scheduler", enabled: true }),
      ).toBe(true);

      // When the server takes the command twice
      const taken = [await takeCommand(runtime), await takeCommand(runtime)];

      // Then it arrives once, and is gone the second time
      expect(taken).toEqual([
        { command: "scheduler", enabled: true },
        undefined,
      ]);
    },
  );

  testInTempDirs(
    "a command nobody has taken yet is not written over",
    async () => {
      // Given a command already waiting for the server to take it
      const runtime = await runtimeIn(await tempDir("console-"));
      await writeCommand(runtime, { command: "scheduler", enabled: true });

      // When the console tries to write a second command
      const written = await writeCommand(runtime, {
        command: "agent",
        agent: "pi-fake-fake",
        enabled: false,
      });

      // Then it is refused, and the waiting command survives
      expect(written).toBe(false);
      expect(await takeCommand(runtime)).toEqual({
        command: "scheduler",
        enabled: true,
      });
    },
  );

  testInTempDirs(
    "an abort command survives the round trip to the server",
    async () => {
      // Given a console that has clicked the abort button on a slot
      const runtime = await runtimeIn(await tempDir("console-"));
      await writeCommand(runtime, {
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });

      // When the server takes the command
      const taken = await takeCommand(runtime);

      // Then it names the slot the click landed on
      expect(taken).toEqual({
        command: "slot_abort",
        slot: "pi-fake-fake-1",
      });
    },
  );

  testInTempDirs("an abort command naming no slot is dropped", async () => {
    // Given a command file asking for an abort without saying of what
    const runtime = await runtimeIn(await tempDir("console-"));
    await fs.writeFile(runtime.consoleCommand, `{ "command": "slot_abort" }`);

    // When the server takes it
    const taken = await takeCommand(runtime);

    // Then nothing is applied, and the file is cleared rather than retried
    expect(taken).toBeUndefined();
    expect(await fs.exists(runtime.consoleCommand)).toBe(false);
  });

  testInTempDirs(
    "a watching server is handed the command as it is written",
    async () => {
      // Given a server watching its runtime directory for commands
      const runtime = await runtimeIn(await tempDir("console-"));
      const taken: Command[] = [];
      const failures: unknown[] = [];
      const watcher = watchCommands(
        runtime,
        (command) => {
          taken.push(command);
        },
        (err) => {
          failures.push(err);
        },
      );

      // When the console writes a command
      await writeCommand(runtime, { command: "scheduler", enabled: true });

      // Then the server is handed it without waiting for a tick, and consumes it
      await eventually(() => taken.length > 0, "handed the command over", 100);
      watcher.close();
      expect(failures).toEqual([]);
      expect(taken).toEqual([{ command: "scheduler", enabled: true }]);
      expect(await fs.exists(runtime.consoleCommand)).toBe(false);
    },
  );

  testInTempDirs(
    "commands are applied in order, each exactly once",
    async () => {
      // Given a server watching its runtime directory for commands
      const runtime = await runtimeIn(await tempDir("console-"));
      const taken: Command[] = [];
      const failures: unknown[] = [];
      const watcher = watchCommands(
        runtime,
        (command) => {
          taken.push(command);
        },
        (err) => {
          failures.push(err);
        },
      );
      const expected: Command[] = [
        { command: "scheduler", enabled: true },
        { command: "agent", agent: "pi-fake-fake", enabled: false },
        { command: "agent", agent: "pi-fake-fake", enabled: true },
        { command: "scheduler", enabled: false },
      ];

      // When the console writes one command after another
      for (const [i, command] of expected.entries()) {
        await writeCommand(runtime, command);
        await eventually(() => taken.length > i, `command ${i} arriving`, 100);
      }
      await Bun.sleep(100);
      watcher.close();

      // Then each arrives once, in the order written
      expect(failures).toEqual([]);
      expect(taken).toEqual(expected);
      expect(await fs.exists(runtime.consoleCommand)).toBe(false);
    },
  );
});

const AGENTS_FILE = "/tmp/tasks/agents.json";

describe("Feature: reading the views the server publishes", () => {
  async function seed(root: string): Promise<Runtime> {
    const runtime = await Runtime.open(path.join(root, "repo"), root);
    await writeAtomic(
      runtime.slotsView,
      viewJson(1, "slots", [busyRow()], { agents_file: AGENTS_FILE }),
    );
    await writeAtomic(runtime.tasksView, viewJson(1, "tasks", [taskRowOf()]));
    await writeAtomic(runtime.checksView, viewJson(1, "checks", []));
    await writeAtomic(
      runtime.queueView,
      viewJson(1, "queue", [candidateOf()], { scheduling: true }),
    );
    return runtime;
  }

  testInTempDirs(
    "the four views the console draws are read together",
    async () => {
      // Given a runtime directory the server has published its views into
      const runtime = await seed(await tempDir("console-"));

      // When the console reads them
      const view = await readView(runtime);

      // Then it has the agents, the tasks, the checks, the queue and the switch
      expect(at(view.slots, 0).name).toBe(SLOTS[0].name);
      expect(at(view.tasks, 0).id).toBe("000123");
      expect(view.checks).toEqual([]);
      expect(at(view.queue, 0).task_id).toBe("000123");
      expect(view.scheduling).toBe(true);
    },
  );

  testInTempDirs(
    "a console with no views to read draws the failure",
    async () => {
      // Given a runtime directory no server has ever written to
      const runtime: Runtime = new Runtime(
        path.join(await tempDir("console-"), "repo"),
        await tempDir("console-"),
      );

      // When a frame is drawn from it
      const { lines } = await frameOrError(
        runtime,
        new Sessions(),
        new Toggles(),
        layoutOf(),
      );

      // Then the screen says the console cannot draw, and why
      expect(lines.join("\n")).toContain("the console cannot draw");
      expect(lines.join("\n")).toContain("no server state");
    },
  );

  testInTempDirs(
    "a frame joins the views to the sessions they name",
    async () => {
      // Given published views naming a session file the agent has written to
      const root = await tempDir("console-");
      const runtime = await Runtime.open(path.join(root, "repo"), root);
      const session = path.join(root, "session.jsonl");
      await write(session, [assistant("hi")]);
      await writeAtomic(
        runtime.slotsView,
        viewJson(1, "slots", [busyRow({ session })], {
          agents_file: AGENTS_FILE,
        }),
      );
      await writeAtomic(runtime.tasksView, viewJson(1, "tasks", [taskRowOf()]));
      await writeAtomic(runtime.checksView, viewJson(1, "checks", []));
      await writeAtomic(
        runtime.queueView,
        viewJson(1, "queue", [candidateOf({ task_id: "000456" })], {
          scheduling: true,
        }),
      );

      // When a frame is drawn from them
      const { lines, hits } = await frame(
        runtime,
        new Sessions(),
        new Toggles(),
        layoutOf(),
      );

      // Then the pane carries the task, the queue line and the agent's transcript
      const text = lines.join("\n");
      expect(text).toContain("task 000123");
      expect(text).toContain("hi");
      expect(lines[0]).toContain("000456");

      // Then every control the frame drew is a target the console can click
      expect(hits.map((hit) => hit.command.command)).toEqual([
        "scheduler",
        "agent",
        "slots",
        "slots",
        "slot_abort",
      ]);
    },
  );

  testInTempDirs(
    "a pool of nothing but disabled agents is never hidden",
    async () => {
      // Given views where every agent in the pool has been turned off
      const runtime = await seed(await tempDir("console-"));
      await writeAtomic(
        runtime.slotsView,
        viewJson(
          1,
          "slots",
          SLOTS.map((slot) => idleRow(slot, SLOTS.length, false)),
          { agents_file: AGENTS_FILE },
        ),
      );

      // When a frame is drawn with the disabled agents collapsed away
      const { lines, hits } = await frame(
        runtime,
        new Sessions(),
        new Toggles(),
        layoutOf(),
        true,
      );

      // Then every pane is drawn, since collapsing them would leave nothing to see
      expect(
        hits.filter((hit) => hit.command.command === "agent"),
      ).toHaveLength(SLOTS.length);
      expect(lines.join("\n")).not.toContain(SHOW[0]);
      expect(lines.join("\n")).not.toContain(HIDE.trim());
    },
  );

  testInTempDirs(
    "collapsing the frame does not forget the hidden panes' sessions",
    async () => {
      // Given published views with a disabled slot still holding a session
      const root = await tempDir("console-");
      const runtime = await Runtime.open(path.join(root, "repo"), root);
      const session = path.join(root, "session.jsonl");
      await write(session, [assistant("hi")]);
      await writeAtomic(
        runtime.slotsView,
        viewJson(
          1,
          "slots",
          [
            busyRow({ session, enabled: false }),
            busyRow({ name: "pi-fake-fake-2", session: "/tmp/other.jsonl" }),
          ],
          { agents_file: AGENTS_FILE },
        ),
      );
      await writeAtomic(runtime.tasksView, viewJson(1, "tasks", [taskRowOf()]));
      await writeAtomic(runtime.checksView, viewJson(1, "checks", []));
      await writeAtomic(
        runtime.queueView,
        viewJson(1, "queue", [], { scheduling: true }),
      );

      // Given the console has read the hidden slot's session
      const sessions = new Sessions();
      await sessions.entries(session);

      // When a frame is drawn with that slot collapsed away
      await frame(
        runtime,
        sessions,
        new Toggles(),
        layoutOf({ nowMs: 5000 }),
        true,
      );

      // Then the session is kept, so un-collapsing does not start from scratch
      expect(sessions.rate(5000, session)).toBe(0.4);
    },
  );
});
