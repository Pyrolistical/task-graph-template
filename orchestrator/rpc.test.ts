import { afterAll, beforeAll, describe, expect, setSystemTime } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { describeActivity, toolCall } from "./activity.ts";
import {
  JsonlSplitter,
  LOOP_LIMIT,
  PiProcess,
  PiStream,
  spawnArgs,
} from "./rpc.ts";
import type { Sample } from "./rates.ts";
import { ORCHESTRATOR_DIR } from "./orchestrator-jig.ts";
import { Prompts } from "./prompts.ts";
import { AGENT_STATES } from "./states.ts";

beforeAll(() => {
  setSystemTime(new Date("2026-01-01").getTime());
});

afterAll(() => {
  setSystemTime();
});

describe("the rpc stream", () => {
  test("records are split on newlines only, not on U+2028", () => {
    const splitter = new JsonlSplitter();
    const line = JSON.stringify({ type: "prompt", message: "a b" });

    expect(splitter.feed(`${line}\n`)).toEqual([line]);
    expect(JSON.parse(splitter.feed(`${line}\n`)[0]!).message).toBe("a b");
  });

  test("a record split across chunks is buffered until it is whole", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.feed('{"type":"agent_')).toEqual([]);
    expect(splitter.pending).toBe('{"type":"agent_');
    expect(splitter.feed('settled"}\n')).toEqual(['{"type":"agent_settled"}']);
    expect(splitter.pending).toBe("");
  });

  test("a trailing carriage return is stripped", () => {
    expect(new JsonlSplitter().feed('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  test("agent_end is not settlement; agent_settled is", () => {
    const stream = new PiStream();
    stream.feed(`${JSON.stringify({ type: "agent_start" })}\n`);
    stream.feed(`${JSON.stringify({ type: "agent_end", willRetry: true })}\n`);
    expect(stream.state.settled).toBe(false);

    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    expect(stream.state.settled).toBe(true);
  });

  test("the outcome comes from the last assistant message", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Connection error.",
          usage: { cost: { total: 0.12 } },
        },
      })}\n`,
    );

    expect(stream.state.stopReason).toBe("error");
    expect(stream.state.errorMessage).toBe("Connection error.");
    expect(stream.state).not.toHaveProperty("cost");
  });

  test("every assistant message reports the output tokens it cost", () => {
    const samples: Sample[] = [];
    const stream = new PiStream((sample) => samples.push(sample));
    const message = (role: string, usage: unknown) =>
      stream.feed(
        `${JSON.stringify({ type: "message_end", message: { role, usage } })}\n`,
      );

    message("assistant", { input: 900, output: 40, cost: { total: 0.1 } });
    message("assistant", { cost: { total: 0.1 } });
    message("toolResult", { output: 999 });

    expect(samples).toEqual([{ timestampMs: Date.now(), tokens: 40 }]);
  });

  test("a tool result message does not become the outcome", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "message_end",
        message: { role: "toolResult", isError: true },
      })}\n`,
    );
    expect(stream.state.stopReason).toBeNull();
  });

  test("a response is matched to the command that carried its id", async () => {
    const stream = new PiStream();
    const expected = stream.expect("2");

    stream.feed(
      `${JSON.stringify({ type: "response", id: "1", command: "prompt", success: true })}\n`,
    );
    stream.feed(
      `${JSON.stringify({
        type: "response",
        id: "2",
        command: "get_state",
        success: true,
        data: { sessionFile: "/tmp/s.jsonl" },
      })}\n`,
    );

    expect((await expected).data!.sessionFile).toBe("/tmp/s.jsonl");
  });

  test("a dead process rejects everything still waiting", async () => {
    const stream = new PiStream();
    const expected = stream.expect("1");
    stream.fail("the pi process closed its stdout");
    expect(expected).rejects.toThrow(/closed its stdout/);
  });

  test("a dead process rejects what is asked of it afterwards", async () => {
    const stream = new PiStream();
    stream.fail("the pi process closed its stdout");
    expect(stream.expect("1")).rejects.toThrow(/closed its stdout/);
  });

  function deadProcess(): PiProcess {
    const dir = tempDir("orchestrator-");
    const command = path.join(dir, "exits.ts");
    fs.writeFileSync(command, "process.exit(0);\n");

    return new PiProcess(
      {
        provider: "fake",
        model: "fake",
        sessionDir: path.join(dir, "session"),
        name: "000001 work",
        cwd: dir,
        extension: path.join(dir, "result-tools-worker.ts"),
        log: path.join(dir, "rpc.jsonl"),
      },
      command,
      ["bun"],
    );
  }

  test("a request made after the child died settles instead of hanging", async () => {
    const process = deadProcess();
    await process.stream.settled();

    const outcome = await Promise.race([
      process.lastAssistantText().then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(2000).then(() => "hung"),
    ]);

    expect(outcome).toBe("rejected");
  }, 10000);

  test("a process whose stdout closed is not alive, exit code or not", async () => {
    const process = deadProcess();
    await process.stream.settled();

    expect(process.alive).toBe(false);
  }, 10000);

  test("activity tracks the running tool", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "bun test\nsecond line" },
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "bash",
      target: "bun test",
      started_at: Date.now(),
    });

    stream.feed(
      `${JSON.stringify({ type: "compaction_start", reason: "overflow" })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "compacting",
      reason: "overflow",
      started_at: Date.now(),
    });
  });

  test("compaction_start calls the compaction hook once per record", () => {
    let calls = 0;
    const stream = new PiStream(
      () => {},
      () => {
        calls++;
      },
    );

    const compaction = `${JSON.stringify({ type: "compaction_start", reason: "overflow" })}\n`;
    stream.feed(compaction);
    expect(calls).toBe(1);

    stream.feed(compaction);
    expect(calls).toBe(2);
  });

  test("tool_execution_end sets activity to thinking", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} })}\n`,
    );
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "c1" })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "thinking",
      started_at: Date.now(),
    });
  });

  test("agent_settled sets activity to none", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: {} })}\n`,
    );
    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    expect(stream.state.activity).toEqual({ kind: "none" });
  });

  test("starting sets activity to thinking", () => {
    const stream = new PiStream();
    stream.starting();
    expect(stream.state.activity).toEqual({
      kind: "thinking",
      started_at: Date.now(),
    });
  });

  test("a tool call with args.path but no command targets the path", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "read",
        args: { path: "/tmp/file.ts" },
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "read",
      target: "/tmp/file.ts",
      started_at: Date.now(),
    });
  });

  test("a tool call with neither command nor path falls back to the tool name", () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolName: "think",
        args: {},
      })}\n`,
    );
    expect(stream.state.activity).toEqual({
      kind: "tool-call",
      tool: "think",
      target: "think",
      started_at: Date.now(),
    });
  });

  test("after abort, the aborting flag is set before the write", () => {
    const dir = tempDir("orchestrator-");
    const script = path.join(dir, "exits.ts");
    fs.writeFileSync(script, "process.exit(0);\n");

    const proc = new PiProcess(
      {
        provider: "fake",
        model: "fake",
        sessionDir: path.join(dir, "session"),
        name: "test",
        cwd: dir,
        extension: path.join(dir, "result-tools-worker.ts"),
        log: path.join(dir, "rpc.jsonl"),
      },
      script,
      ["bun"],
    );

    const aborting = () => (proc as unknown as { aborting: boolean }).aborting;

    expect(aborting()).toBe(false);
    try {
      proc.abort();
    } catch {
      // write may fail because the process is already dead
    }
    expect(aborting()).toBe(true);
    proc.kill();
  }, 10000);

  test("describeActivity formats all four kinds", () => {
    expect(
      describeActivity({
        kind: "tool-call",
        tool: "bash",
        target: "bun test",
        started_at: Date.now(),
      }),
    ).toBe("tool: bash — bun test (0s)");
    expect(
      describeActivity({
        kind: "tool-call",
        tool: "bash",
        target: "bash",
        started_at: Date.now(),
      }),
    ).toBe("tool: bash (0s)");
    expect(describeActivity({ kind: "thinking", started_at: Date.now() })).toBe(
      "thinking (0s)",
    );
    expect(
      describeActivity({
        kind: "compacting",
        reason: "overflow",
        started_at: Date.now(),
      }),
    ).toBe("compacting (overflow) (0s)");
    expect(describeActivity({ kind: "none" })).toBe("");
  });

  test("the settle of the turn just handled does not satisfy the next prompt", async () => {
    const stream = new PiStream();
    stream.feed(
      `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    await stream.settled();

    stream.starting();
    let settled = false;
    void stream.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);

    stream.feed(`${JSON.stringify({ type: "agent_settled" })}\n`);
    await Bun.sleep(5);
    expect(settled).toBe(true);
  });

  function toolCall(command: string): string {
    return `${JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command },
    })}\n`;
  }

  test("the same command over and over is a loop; nine of them is not", () => {
    const stream = new PiStream();
    const build = toolCall("zig build --verbose 2>&1 | head -80");

    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(build);
    }
    expect(stream.state.looping).toBeNull();

    stream.feed(build);
    expect(stream.state.looping).toBe("zig build --verbose 2>&1 | head -80");
  });

  test("a command that differs at all breaks the run, arguments included", () => {
    const stream = new PiStream();

    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(toolCall("zig build"));
    }
    stream.feed(toolCall("zig build -Doptimize=Debug"));
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      stream.feed(toolCall("zig build"));
    }

    expect(stream.state.looping).toBeNull();
  });

  test("the same command spread across turns is not a loop", () => {
    const stream = new PiStream();
    const build = toolCall("zig build");

    for (let turn = 0; turn < 3; turn++) {
      stream.starting();
      for (let i = 0; i < LOOP_LIMIT - 1; i++) {
        stream.feed(build);
      }
    }

    expect(stream.state.looping).toBeNull();
  });

  test("a fresh prompt clears the loop, so the agent gets a clean turn", () => {
    const stream = new PiStream();
    for (let i = 0; i < LOOP_LIMIT; i++) {
      stream.feed(toolCall("zig build"));
    }
    expect(stream.state.looping).not.toBeNull();

    stream.starting();
    expect(stream.state.looping).toBeNull();
  });

  test("a garbled line is skipped rather than killing the stream", () => {
    const stream = new PiStream();
    const records = stream.feed(
      `not json\n${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    expect(records).toHaveLength(1);
    expect(stream.state.settled).toBe(true);
  });

  test("the spawn line is rpc mode with no positional message", () => {
    const args = spawnArgs({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionDir: "/tmp/s",
      name: "000042 worker",
      cwd: "/tmp/wt",
      extension: "/repo/orchestrator/result-tools-worker.ts",
      log: "/tmp/rpc.jsonl",
    });

    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(args).toContain("--approve");
    expect(args).toContain("--extension");
    expect(args).toContain("/repo/orchestrator/result-tools-worker.ts");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--thinking");
    expect(args).not.toContain("--tools");
  });

  test("each state has its own dispatch prompt and none is empty", () => {
    const prompts = new Prompts(ORCHESTRATOR_DIR);
    const texts = AGENT_STATES.map((state) => prompts.fragment(state));

    expect(new Set(texts).size).toBe(AGENT_STATES.length);
    for (const text of texts) {
      expect(text.trim()).not.toBe("");
    }
  });
});
