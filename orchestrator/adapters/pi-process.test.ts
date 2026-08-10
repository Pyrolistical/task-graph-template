import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import { tempDir, testInTempDirs } from "../testing/temp-dirs.ts";
import { present } from "../testing/present.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { type Activity, describeActivity } from "../domain/activity.ts";
import {
  JsonlSplitter,
  LOOP_LIMIT,
  PiStream,
  spawnArgs,
} from "../domain/protocol.ts";
import { PiProcess } from "./pi-process.ts";
import type { Sample } from "../domain/rates.ts";
import { ORCHESTRATOR_DIR } from "../testing/graph-jig.ts";
import { shippedFile } from "../testing/orchestrator-jig.ts";
import { PromptFiles } from "./prompt-files.ts";
beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});
afterAll(() => {
  setSystemTime();
});
function record(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
function bashCall(command: string): string {
  return record({
    type: "tool_execution_start",
    toolName: "bash",
    args: { command },
  });
}
async function settleTo(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch {
    return "rejected";
  }
}
async function hungAfter(ms: number): Promise<string> {
  await Bun.sleep(ms);
  return "hung";
}
async function settleWait(
  stream: PiStream,
  settledRecord: string,
): Promise<[boolean, boolean]> {
  stream.starting();
  let settled = false;
  const settle = stream.settled();
  await Bun.sleep(5);
  const before = settled;
  stream.feed(settledRecord);
  await settle;
  settled = true;
  return [before, settled];
}
function spreadAcrossTurns(stream: PiStream, command: string, turns = 3): void {
  for (let turn = 0; turn < turns; turn++) {
    stream.starting();
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(command);
    }
  }
}
async function deadProcess(): Promise<PiProcess> {
  const dir = await tempDir("orchestrator-");
  const command = path.join(dir, "exits.ts");
  await fs.writeFile(command, "process.exit(0);\n");
  return PiProcess.open(
    {
      provider: "fake",
      model: "fake",
      sessionDir: path.join(dir, "session"),
      name: "000001 work",
      cwd: dir,
      extension: path.join(dir, "result-tools-worker.ts"),
    },
    command,
    ["bun"],
  );
}
describe("Feature: splitting the rpc stream into records", () => {
  testInTempDirs("records are split on newlines and nothing else", () => {
    // Given a record whose text carries a separator of its own
    const splitter = new JsonlSplitter();
    const line = JSON.stringify({ type: "prompt", message: "a b" });
    // When it is fed to the splitter
    const records = splitter.feed(`${line}\n`);
    // Then it comes back whole, because only a newline ends a record
    expect(records).toEqual([line]);
  });
  testInTempDirs(
    "a record split across reads is held until it is whole",
    () => {
      // Given the first half of a record, with no newline in it yet
      const splitter = new JsonlSplitter();
      expect(splitter.feed('{"type":"agent_')).toEqual([]);
      expect(splitter.pending).toBe('{"type":"agent_');
      // When the rest of it arrives
      const records = splitter.feed('settled"}\n');
      // Then the whole record comes back and nothing is left pending
      expect(records).toEqual(['{"type":"agent_settled"}']);
      expect(splitter.pending).toBe("");
    },
  );
  testInTempDirs("a carriage return before the newline is dropped", () => {
    // Given a record written with a carriage return before its newline
    const splitter = new JsonlSplitter();
    // When it is fed to the splitter
    const records = splitter.feed('{"a":1}\r\n');
    // Then the record is clean enough to parse
    expect(records).toEqual(['{"a":1}']);
  });
  testInTempDirs("a line that is not a record is skipped", () => {
    // Given a stream carrying a garbled line before a real record
    const stream = new PiStream();
    // When it is fed to the stream
    const records = stream.feed(
      `not json\n${record({ type: "agent_settled" })}`,
    );
    // Then the garbage is dropped and the record after it still lands
    expect(records).toHaveLength(1);
    expect(stream.state.settled).toBe(true);
  });
});
describe("Feature: knowing when an agent's turn is over", () => {
  testInTempDirs("the end of a message is not the end of a turn", () => {
    // Given a turn that has ended a message and will retry
    const stream = new PiStream();
    stream.feed(record({ type: "agent_start" }));
    // When the agent ends that message
    stream.feed(record({ type: "agent_end", willRetry: true }));
    // Then the turn is not settled, because pi may still retry inside it
    expect(stream.state.settled).toBe(false);
  });
  testInTempDirs("the turn is over when pi says it has settled", () => {
    // Given a turn that has started and ended a message
    const stream = new PiStream();
    stream.feed(record({ type: "agent_start" }));
    stream.feed(record({ type: "agent_end", willRetry: true }));
    // When pi says the turn has settled
    stream.feed(record({ type: "agent_settled" }));
    // Then the server may act on what the turn produced
    expect(stream.state.settled).toBe(true);
  });
  testInTempDirs(
    "the settle of one turn does not satisfy the next",
    async () => {
      // Given a turn that has already started and settled
      const stream = new PiStream();
      stream.feed(
        record({ type: "agent_start" }) + record({ type: "agent_settled" }),
      );
      await stream.settled();
      // When a new turn is started and waited on
      const [before, settled] = await settleWait(
        stream,
        record({ type: "agent_settled" }),
      );
      // Then only the new turn's own settle satisfies the wait
      expect([before, settled]).toEqual([false, true]);
    },
  );
  testInTempDirs("the outcome of a turn is its last assistant message", () => {
    // Given an assistant message that ended in a provider error
    const stream = new PiStream();
    // When it is fed to the stream
    stream.feed(
      record({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Connection error.",
          usage: { cost: { total: 0.12 } },
        },
      }),
    );
    // Then the reason and its message are what the server will act on
    expect(stream.state.stopReason).toBe("error");
    expect(stream.state.errorMessage).toBe("Connection error.");
    // Then the cost is not tracked, because it says nothing about progress
    expect(stream.state).not.toHaveProperty("cost");
  });
  testInTempDirs("a tool result is never mistaken for the outcome", () => {
    // Given a tool result that failed
    const stream = new PiStream();
    // When it is fed to the stream
    stream.feed(
      record({
        type: "message_end",
        message: { role: "toolResult", isError: true },
      }),
    );
    // Then the turn has no outcome yet, because only the agent ends a turn
    expect(stream.state.stopReason).toBeNull();
  });
  testInTempDirs(
    "only an assistant message that spent tokens is measured",
    () => {
      // Given a turn with a measured message, an unmeasured one and a tool result
      const samples: Sample[] = [];
      const stream = new PiStream((sample) => samples.push(sample));
      const message = (role: string, usage: unknown) =>
        record({ type: "message_end", message: { role, usage } });
      // When all three are fed to the stream
      stream.feed(
        message("assistant", { input: 900, output: 40, cost: { total: 0.1 } }) +
          message("assistant", { cost: { total: 0.1 } }) +
          message("toolResult", { output: 999 }),
      );
      // Then only the measured assistant message becomes a sample of the rate
      expect(samples).toEqual([{ timestampMs: Date.now(), tokens: 40 }]);
    },
  );
});
describe("Feature: matching a reply to what was asked", () => {
  testInTempDirs(
    "a reply is matched to the request that carried its id",
    async () => {
      // Given a request waiting on a reply, with another reply arriving first
      const stream = new PiStream();
      const expected = stream.expect("2");
      // When both of the replies arrive
      stream.feed(
        record({
          type: "response",
          id: "1",
          command: "prompt",
          success: true,
        }) +
          record({
            type: "response",
            id: "2",
            command: "get_state",
            success: true,
            data: { sessionFile: "/tmp/s.jsonl" },
          }),
      );
      // Then the waiting request is answered by its own reply
      expect(
        present((await expected).data, "the reply payload").sessionFile,
      ).toBe("/tmp/s.jsonl");
    },
  );
  testInTempDirs("a dead process rejects what is already waiting", () => {
    // Given a request waiting on a reply
    const stream = new PiStream();
    const expected = stream.expect("1");
    // When the pi process dies under it
    stream.fail("the pi process closed its stdout");
    // Then the wait is rejected rather than left hanging
    expect(expected).rejects.toThrow(/closed its stdout/);
  });
  testInTempDirs(
    "a dead process rejects what is asked of it afterwards",
    () => {
      // Given a process that has already died
      const stream = new PiStream();
      stream.fail("the pi process closed its stdout");
      // When something else is asked of it
      const expected = stream.expect("1");
      // Then it is rejected at once, naming what went wrong
      expect(expected).rejects.toThrow(/closed its stdout/);
    },
  );
  testInTempDirs(
    "a request made after the child died settles instead of hanging",
    async () => {
      // Given a pi process whose command exits immediately
      const process = await deadProcess();
      await process.stream.settled();
      // When something is asked of it
      const outcome = await Promise.race([
        settleTo(process.lastAssistantText()),
        hungAfter(2000),
      ]);
      // Then it is rejected quickly, so a tick is never blocked on a dead agent
      expect(outcome).toBe("rejected");
    },
    10000,
  );
  testInTempDirs(
    "a process whose stdout closed is not alive, exit code or not",
    async () => {
      // Given a pi process whose command exits immediately
      const process = await deadProcess();
      // When its stream settles for the last time
      await process.stream.settled();
      // Then the server reads it as gone, and will not prompt it again
      expect(process.alive).toBe(false);
    },
    10000,
  );
  testInTempDirs(
    "an abort is recorded before the write that may fail",
    async () => {
      // Given a pi process whose command has already exited
      const dir = await tempDir("orchestrator-");
      const script = path.join(dir, "exits.ts");
      await fs.writeFile(script, "process.exit(0);\n");
      const proc = await PiProcess.open(
        {
          provider: "fake",
          model: "fake",
          sessionDir: path.join(dir, "session"),
          name: "test",
          cwd: dir,
          extension: path.join(dir, "result-tools-worker.ts"),
        },
        script,
        ["bun"],
      );
      expect(proc.aborting).toBe(false);
      // When it is aborted, and the write to the dead process fails
      try {
        proc.abort();
      } catch {
        // the write may fail because the process is already dead
      }
      // Then the abort is still recorded, so the settle is read as an abort
      expect(proc.aborting).toBe(true);
      proc.kill();
    },
  );
});
describe("Feature: what an agent is doing right now", () => {
  testInTempDirs("a running tool call is the activity, first line only", () => {
    // Given an agent that has started a command spanning several lines
    const stream = new PiStream();
    // When the tool call starts
    stream.feed(bashCall("bun test\nsecond line"));
    // Then the activity names the tool and the first line of what it runs
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "bash",
      target: "bun test",
      started_at: Date.now(),
    });
  });
  testInTempDirs("a compaction is the activity while it runs", () => {
    // Given an agent inside a tool call
    const stream = new PiStream();
    stream.feed(bashCall("bun test"));
    // When it starts compacting instead
    stream.feed(record({ type: "compaction_start", reason: "overflow" }));
    // Then the console shows the compaction and why it happened
    expect(stream.state.activity).toEqual({
      kind: "compacting",
      reason: "overflow",
      started_at: Date.now(),
    });
  });
  testInTempDirs(
    "every compaction is reported to the server, not just the first",
    () => {
      // Given a stream watched for compactions
      let calls = 0;
      const stream = new PiStream(
        () => {},
        () => {
          calls++;
        },
      );
      const compaction = record({
        type: "compaction_start",
        reason: "overflow",
      });
      // When two compactions happen in one turn
      for (let i = 0; i < 2; i++) stream.feed(compaction);
      // Then the server hears about both, so it can steer the agent each time
      expect(calls).toBe(2);
    },
  );
  testInTempDirs("an agent between tool calls reads as thinking", () => {
    // Given an agent inside a tool call
    const stream = new PiStream();
    stream.feed(bashCall("bun test"));
    // When the tool call ends
    stream.feed(record({ type: "tool_execution_end", toolCallId: "c1" }));
    // Then it reads as thinking, because the turn is not over
    expect(stream.state.activity).toEqual({
      kind: "thinking",
      started_at: Date.now(),
    });
  });
  testInTempDirs("an agent that has settled is doing nothing", () => {
    // Given an agent inside a tool call
    const stream = new PiStream();
    stream.feed(bashCall("bun test"));
    // When the agent's turn settles
    stream.feed(record({ type: "agent_settled" }));
    // Then the pane shows nothing, because the agent is waiting on the server
    expect(stream.state.activity).toEqual({ kind: "none" });
  });
  testInTempDirs(
    "an agent that has just been prompted reads as thinking",
    () => {
      // Given a stream about to carry a new turn
      const stream = new PiStream();
      // When the turn is started
      stream.starting();
      // Then the pane shows it thinking before its first tool call arrives
      expect(stream.state.activity).toEqual({
        kind: "thinking",
        started_at: Date.now(),
      });
    },
  );
  testInTempDirs(
    "a tool call on a file is shown by the file it touches",
    () => {
      // Given an agent reading a file
      const stream = new PiStream();
      // When the tool call starts
      stream.feed(
        record({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: "/tmp/file.ts" },
        }),
      );
      // Then the path is what the console shows
      expect(stream.state.activity).toEqual({
        kind: "tool-call",
        tool: "read",
        target: "/tmp/file.ts",
        started_at: Date.now(),
      });
    },
  );
  testInTempDirs(
    "a tool call with nothing to name falls back to its own name",
    () => {
      // Given an agent calling a tool that takes no arguments worth showing
      const stream = new PiStream();
      // When the tool call starts
      stream.feed(
        record({ type: "tool_execution_start", toolName: "think", args: {} }),
      );
      // Then the tool's own name is what the console shows
      expect(stream.state.activity).toEqual({
        kind: "tool-call",
        tool: "think",
        target: "think",
        started_at: Date.now(),
      });
    },
  );
  testInTempDirs("a tool call with a target names both for the console", () => {
    // Given an agent inside a bash call on a test run
    const activity: Activity = {
      kind: "tool-call",
      tool: "bash",
      target: "bun test",
      started_at: Date.now(),
    };
    // When the activity is written for the console
    const written = describeActivity(activity);
    // Then the tool and its target are both named
    expect(written).toBe("tool: bash — bun test (0s)");
  });
  testInTempDirs("a tool call with no target names only the tool", () => {
    // Given an agent inside a bash call with nothing to point at
    const activity: Activity = {
      kind: "tool-call",
      tool: "bash",
      target: "bash",
      started_at: Date.now(),
    };
    // When the activity is written for the console
    const written = describeActivity(activity);
    // Then the tool alone is named, since the target was nothing
    expect(written).toBe("tool: bash (0s)");
  });
  testInTempDirs("an agent that is thinking is shown thinking", () => {
    // Given an agent thinking through its next step
    const activity: Activity = {
      kind: "thinking",
      started_at: Date.now(),
    };
    // When the activity is written for the console
    const written = describeActivity(activity);
    // Then the console reads that it is thinking
    expect(written).toBe("thinking (0s)");
  });
  testInTempDirs("an agent that is compacting is shown doing so", () => {
    // Given an agent compacting a context that overflowed
    const activity: Activity = {
      kind: "compacting",
      reason: "overflow",
      started_at: Date.now(),
    };
    // When the activity is written for the console
    const written = describeActivity(activity);
    // Then the console reads that it is compacting, and why
    expect(written).toBe("compacting (overflow) (0s)");
  });
  testInTempDirs("an idle agent shows no activity at all", () => {
    // Given an agent with nothing going on
    const activity: Activity = { kind: "none" };
    // When the activity is written for the console
    const written = describeActivity(activity);
    // Then the line is empty, so the pane draws nothing for it
    expect(written).toBe("");
  });
});
describe("Feature: noticing an agent that has stopped making progress", () => {
  testInTempDirs("one command repeated to the limit is a loop", () => {
    // Given a turn that has repeated one command one short of the limit
    const stream = new PiStream();
    const build = bashCall("zig build --verbose 2>&1 | head -80");
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(build);
    }
    expect(stream.state.looping).toBeNull();
    // When it runs the same command once more
    stream.feed(build);
    // Then the server is told which command the agent is stuck on
    expect(stream.state.looping).toBe("zig build --verbose 2>&1 | head -80");
  });
  testInTempDirs("a command that differs at all breaks the run", () => {
    // Given a turn repeating one command, broken once by a different one
    const stream = new PiStream();
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(bashCall("zig build"));
    }
    stream.feed(bashCall("zig build -Doptimize=Debug"));
    // When the original command is repeated again, up to one short of the limit
    for (let i = 0; i < LOOP_LIMIT - 1; i++) stream.feed(bashCall("zig build"));
    // Then it is not a loop, because the count starts over at any difference
    expect(stream.state.looping).toBeNull();
  });
  testInTempDirs("the same command spread across turns is not a loop", () => {
    // Given three turns, each repeating one command below the limit
    const stream = new PiStream();
    const build = bashCall("zig build");
    // When all three turns run
    spreadAcrossTurns(stream, build);
    // Then nothing is a loop, because a loop is repetition within one turn
    expect(stream.state.looping).toBeNull();
  });
  testInTempDirs("a fresh prompt gives the agent a clean turn", () => {
    // Given a turn the agent has looped in
    const stream = new PiStream();
    for (let i = 0; i < LOOP_LIMIT; i++) {
      stream.feed(bashCall("zig build"));
    }
    expect(stream.state.looping).not.toBeNull();
    // When the agent is prompted again
    stream.starting();
    // Then the loop is forgotten, so the nudge is judged on its own turn
    expect(stream.state.looping).toBeNull();
  });
});
describe("Feature: how an agent is spawned", () => {
  testInTempDirs(
    "the spawn line puts pi in rpc mode with its extension",
    () => {
      // Given the process a task is about to be dispatched to
      const spec = {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        sessionDir: "/tmp/s",
        name: "000042 worker",
        cwd: "/tmp/wt",
        extension: "/repo/orchestrator/result-tools-worker.ts",
      };
      // When the command line is built
      const args = spawnArgs(spec);
      // Then pi is put in rpc mode, approving tools, with the state's extension
      expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
      expect(args).toContain("--approve");
      expect(args).toContain("--extension");
      expect(args).toContain("/repo/orchestrator/result-tools-worker.ts");
      // Then nothing is said in flags that the prompts say instead
      expect(args).not.toContain("--append-system-prompt");
      expect(args).not.toContain("--system-prompt");
      expect(args).not.toContain("-p");
      expect(args).not.toContain("--thinking");
      expect(args).not.toContain("--tools");
    },
  );
  testInTempDirs("a designer is prompted with words of its own", async () => {
    // Given the DESIGN state an agent is dispatched into
    const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
    // When the fragment it is prompted with is read
    const text = prompts.fragment("DESIGN");
    // Then it is the shipped design prompt, and it says something
    expect(text).toBe(await shippedFile("prompts/DESIGN.md"));
    expect(text.trim()).not.toBe("");
  });
  testInTempDirs(
    "a design reviewer is prompted with words of its own",
    async () => {
      // Given the DESIGN_REVIEW state an agent is dispatched into
      const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
      // When the fragment it is prompted with is read
      const text = prompts.fragment("DESIGN_REVIEW");
      // Then it is the shipped review prompt, and it says something
      expect(text).toBe(await shippedFile("prompts/DESIGN_REVIEW.md"));
      expect(text.trim()).not.toBe("");
    },
  );
  testInTempDirs("a planner is prompted with words of its own", async () => {
    // Given the PLAN state an agent is dispatched into
    const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
    // When the fragment it is prompted with is read
    const text = prompts.fragment("PLAN");
    // Then it is the shipped plan prompt, and it says something
    expect(text).toBe(await shippedFile("prompts/PLAN.md"));
    expect(text.trim()).not.toBe("");
  });
  testInTempDirs(
    "a plan reviewer is prompted with words of its own",
    async () => {
      // Given the PLAN_REVIEW state an agent is dispatched into
      const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
      // When the fragment it is prompted with is read
      const text = prompts.fragment("PLAN_REVIEW");
      // Then it is the shipped review prompt, and it says something
      expect(text).toBe(await shippedFile("prompts/PLAN_REVIEW.md"));
      expect(text.trim()).not.toBe("");
    },
  );
  testInTempDirs("a worker is prompted with words of its own", async () => {
    // Given the WORK state an agent is dispatched into
    const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
    // When the fragment it is prompted with is read
    const text = prompts.fragment("WORK");
    // Then it is the shipped work prompt, and it says something
    expect(text).toBe(await shippedFile("prompts/WORK.md"));
    expect(text.trim()).not.toBe("");
  });
  testInTempDirs(
    "a work reviewer is prompted with words of its own",
    async () => {
      // Given the WORK_REVIEW state an agent is dispatched into
      const prompts = await PromptFiles.open(ORCHESTRATOR_DIR);
      // When the fragment it is prompted with is read
      const text = prompts.fragment("WORK_REVIEW");
      // Then it is the shipped review prompt, and it says something
      expect(text).toBe(await shippedFile("prompts/WORK_REVIEW.md"));
      expect(text.trim()).not.toBe("");
    },
  );
});
