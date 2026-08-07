import { describe, expect } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import { eventually } from "../testing/wait.ts";
import fs from "node:fs";
import path from "node:path";
import { Sessions, SessionTail, frame, readView } from "./tui.ts";
import {
  type Command,
  takeCommand,
  watchCommands,
  writeCommand,
} from "./command.ts";
import { Runtime, snapshot, writeAtomic } from "./runtime.ts";
import {
  SLOTS,
  busyRow,
  candidateOf,
  layoutOf,
  taskRowOf,
} from "../testing/console.ts";

function write(filePath: string, records: unknown[]): void {
  fs.appendFileSync(
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
  testInTempDirs("only what was appended since the last read is parsed", () => {
    // Given a session file with one turn in it, already read once
    const file = path.join(tempDir("console-"), "session.jsonl");
    write(file, [assistant("first")]);
    const tail: SessionTail = new SessionTail(file);
    expect(tail.read().map((entry) => entry.text)).toEqual(["first"]);

    // When another turn is appended and the file is read again
    write(file, [assistant("second")]);
    const entries = tail.read();

    // Then the new turn joins the old ones rather than replacing them
    expect(entries.map((entry) => entry.text)).toEqual(["first", "second"]);

    // Then each turn leaves one usage sample behind for the rate meter
    expect(tail.samples).toEqual([
      { timestampMs: 0, tokens: 2 },
      { timestampMs: 0, tokens: 2 },
    ]);
  });

  testInTempDirs("only the last ten usage samples are kept", () => {
    // Given a session with twelve turns written to it
    const file = path.join(tempDir("console-"), "session.jsonl");
    write(
      file,
      Array.from({ length: 12 }, (_, index) => assistant(`m${index}`)),
    );

    // When the whole session is read
    const tail: SessionTail = new SessionTail(file);
    const entries = tail.read();

    // Then every turn is in the transcript, but the rate is over the recent ones
    expect(entries).toHaveLength(12);
    expect(tail.samples).toHaveLength(10);
  });

  testInTempDirs("a session rewritten from the start is read afresh", () => {
    // Given a session that has been read, then truncated and written over
    const file = path.join(tempDir("console-"), "session.jsonl");
    write(file, [assistant("first"), assistant("second")]);
    const tail: SessionTail = new SessionTail(file);
    expect(tail.read()).toHaveLength(2);
    fs.writeFileSync(file, "", "utf-8");
    write(file, [assistant("fresh")]);

    // When the file is read again
    const entries = tail.read();

    // Then the old turns are dropped and only the new session is shown
    expect(entries.map((entry) => entry.text)).toEqual(["fresh"]);
    expect(tail.samples).toEqual([{ timestampMs: 0, tokens: 2 }]);
  });

  testInTempDirs(
    "a half written line is held until its newline arrives",
    () => {
      // Given a session file caught mid-write, with no newline yet
      const file = path.join(tempDir("console-"), "session.jsonl");
      const record = JSON.stringify(assistant("split"));
      fs.writeFileSync(file, record.slice(0, 12), "utf-8");
      const tail: SessionTail = new SessionTail(file);
      expect(tail.read()).toEqual([]);

      // When the rest of the line, and its newline, are written
      fs.appendFileSync(file, `${record.slice(12)}\n`, "utf-8");
      const entries = tail.read();

      // Then the turn is parsed whole rather than half of it being dropped
      expect(entries.map((entry) => entry.text)).toEqual(["split"]);
    },
  );

  testInTempDirs("a session file that is not there yet reads as empty", () => {
    // Given a session path the agent has not written to yet
    const file = path.join(tempDir("console-"), "nothing.jsonl");

    // When the file is read
    const tail: SessionTail = new SessionTail(file);

    // Then it reads as an empty transcript rather than failing the frame
    expect(tail.read()).toEqual([]);
  });
});

describe("Feature: the sessions the console is following", () => {
  testInTempDirs("a session has no rate until its file has been read", () => {
    // Given a session file the console has never read
    const file = path.join(tempDir("console-"), "session.jsonl");
    write(file, [assistant("hi")]);
    const sessions: Sessions = new Sessions();
    expect(sessions.rate(file, 5000)).toBeNull();

    // When the console reads the session
    sessions.entries(file);

    // Then the rate is measured from the samples that read left behind
    expect(sessions.rate(file, 5000)).toBe(0.4);
  });

  testInTempDirs("a slot with no session at all reads as empty", () => {
    // Given an idle slot, which names no session
    const sessions: Sessions = new Sessions();

    // When the console asks for its transcript
    const entries = sessions.entries(null);

    // Then it gets nothing, and no rate either
    expect(entries).toEqual([]);
    expect(sessions.rate(null, 5000)).toBeNull();
  });

  testInTempDirs("a session no slot names any more is forgotten", () => {
    // Given a session the console has read and measured
    const file = path.join(tempDir("console-"), "session.jsonl");
    write(file, [assistant("hi")]);
    const sessions: Sessions = new Sessions();
    sessions.entries(file);

    // When the frame is drawn without that session in it
    sessions.keep(new Set());

    // Then the console drops it, rather than tailing a file nothing shows
    expect(sessions.rate(file, 5000)).toBeNull();
  });
});

describe("Feature: the command channel between console and server", () => {
  function runtimeIn(root: string): Runtime {
    return new Runtime(path.join(root, "repo"), root);
  }

  testInTempDirs("a command the console wrote is taken exactly once", () => {
    // Given a console that has written a command for the server
    const runtime = runtimeIn(tempDir("console-"));
    expect(writeCommand(runtime, { command: "scheduler", enabled: true })).toBe(
      true,
    );

    // When the server takes the command twice
    const taken = [takeCommand(runtime), takeCommand(runtime)];

    // Then it arrives once, and is gone the second time
    expect(taken).toEqual([{ command: "scheduler", enabled: true }, null]);
  });

  testInTempDirs("a command nobody has taken yet is not written over", () => {
    // Given a command already waiting for the server to take it
    const runtime = runtimeIn(tempDir("console-"));
    writeCommand(runtime, { command: "scheduler", enabled: true });

    // When the console tries to write a second command
    const written = writeCommand(runtime, {
      command: "agent",
      agent: "pi-fake-fake",
      enabled: false,
    });

    // Then it is refused, and the waiting command survives
    expect(written).toBe(false);
    expect(takeCommand(runtime)).toEqual({
      command: "scheduler",
      enabled: true,
    });
  });

  testInTempDirs(
    "a command that is not one the server knows is dropped",
    () => {
      // Given a command file naming something the server cannot do
      const runtime = runtimeIn(tempDir("console-"));
      fs.writeFileSync(runtime.consoleCommand, `{ "command": "explode" }`);

      // When the server takes it
      const taken = takeCommand(runtime);

      // Then nothing is applied, and the file is cleared rather than retried
      expect(taken).toBeNull();
      expect(fs.existsSync(runtime.consoleCommand)).toBe(false);
    },
  );

  testInTempDirs(
    "an abort command survives the round trip to the server",
    () => {
      // Given a console that has clicked the abort button on a slot
      const runtime = runtimeIn(tempDir("console-"));
      writeCommand(runtime, {
        command: "agent_abort",
        "agent-name-slot": "pi-fake-fake-1",
      });

      // When the server takes the command
      const taken = takeCommand(runtime);

      // Then it names the slot the click landed on
      expect(taken).toEqual({
        command: "agent_abort",
        "agent-name-slot": "pi-fake-fake-1",
      });
    },
  );

  testInTempDirs("an abort command naming no slot is dropped", () => {
    // Given a command file asking for an abort without saying of what
    const runtime = runtimeIn(tempDir("console-"));
    fs.writeFileSync(runtime.consoleCommand, `{ "command": "agent_abort" }`);

    // When the server takes it
    const taken = takeCommand(runtime);

    // Then nothing is applied, and the file is cleared rather than retried
    expect(taken).toBeNull();
    expect(fs.existsSync(runtime.consoleCommand)).toBe(false);
  });

  testInTempDirs(
    "a watching server is handed the command as it is written",
    async () => {
      // Given a server watching its runtime directory for commands
      const runtime = runtimeIn(tempDir("console-"));
      const taken: Command[] = [];
      const watcher = watchCommands(runtime, (command) => {
        taken.push(command);
      });

      // When the console writes a command
      writeCommand(runtime, { command: "scheduler", enabled: true });
      await eventually(() => taken.length > 0, "handed the command over", 100);
      watcher.close();

      // Then the server is handed it without waiting for a tick, and consumes it
      expect(taken).toEqual([{ command: "scheduler", enabled: true }]);
      expect(fs.existsSync(runtime.consoleCommand)).toBe(false);
    },
  );
});

describe("Feature: reading the views the server publishes", () => {
  function seed(root: string): Runtime {
    const runtime: Runtime = new Runtime(path.join(root, "repo"), root);
    writeAtomic(runtime.agentsView, snapshot(1, "agents", [busyRow()]));
    writeAtomic(runtime.tasksView, snapshot(1, "tasks", [taskRowOf()]));
    writeAtomic(runtime.checksView, snapshot(1, "checks", []));
    writeAtomic(
      runtime.queueView,
      snapshot(1, "queue", [candidateOf()], { scheduling: true }),
    );
    return runtime;
  }

  testInTempDirs("the four views the console draws are read together", () => {
    // Given a runtime directory the server has published its views into
    const runtime = seed(tempDir("console-"));

    // When the console reads them
    const view = readView(runtime);

    // Then it has the agents, the tasks, the checks, the queue and the switch
    expect(view.agents[0]!.name).toBe(SLOTS[0]!.name);
    expect(view.tasks[0]!.id).toBe("000123");
    expect(view.checks).toEqual([]);
    expect(view.queue[0]!.task_id).toBe("000123");
    expect(view.scheduling).toBe(true);
  });

  testInTempDirs("a queue view without the scheduler flag is refused", () => {
    // Given a queue view written without the flag the switch is drawn from
    const runtime = seed(tempDir("console-"));
    writeAtomic(runtime.queueView, snapshot(1, "queue", []));

    // When the console reads the views
    const attempt = () => readView(runtime);

    // Then it says what is missing rather than drawing a switch it cannot trust
    expect(attempt).toThrow(/has no "scheduling" flag/);
  });

  testInTempDirs("a runtime directory with no views at all is refused", () => {
    // Given a runtime directory no server has ever written to
    const runtime: Runtime = new Runtime(
      path.join(tempDir("console-"), "repo"),
      tempDir("console-"),
    );

    // When the console reads the views
    const attempt = () => readView(runtime);

    // Then it says there is no server here, rather than drawing an empty screen
    expect(attempt).toThrow(/no server state/);
  });

  testInTempDirs("a view written without its rows is refused", () => {
    // Given a tasks view whose rows are missing
    const runtime = seed(tempDir("console-"));
    writeAtomic(runtime.tasksView, `${JSON.stringify({ at: "now" })}\n`);

    // When the console reads the views
    const attempt = () => readView(runtime);

    // Then it names the view and the array it expected to find in it
    expect(attempt).toThrow(/has no "tasks" array/);
  });

  testInTempDirs("a frame joins the views to the sessions they name", () => {
    // Given published views naming a session file the agent has written to
    const root = tempDir("console-");
    const runtime: Runtime = new Runtime(path.join(root, "repo"), root);
    const session = path.join(root, "session.jsonl");
    write(session, [assistant("hi")]);
    writeAtomic(
      runtime.agentsView,
      snapshot(1, "agents", [busyRow({ session })]),
    );
    writeAtomic(runtime.tasksView, snapshot(1, "tasks", [taskRowOf()]));
    writeAtomic(runtime.checksView, snapshot(1, "checks", []));
    writeAtomic(
      runtime.queueView,
      snapshot(1, "queue", [candidateOf({ task_id: "000456" })], {
        scheduling: true,
      }),
    );

    // When a frame is drawn from them
    const { lines, hits } = frame(runtime, new Sessions(), layoutOf());

    // Then the pane carries the task, the queue line and the agent's transcript
    const text = lines.join("\n");
    expect(text).toContain("task 000123");
    expect(text).toContain("hi");
    expect(lines[0]).toContain("000456");

    // Then every control the frame drew is a target the console can click
    expect(hits.map((hit) => hit.command.command)).toEqual([
      "scheduler",
      "agent",
      "agent_abort",
    ]);
  });
});
