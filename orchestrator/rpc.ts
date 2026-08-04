import fs from "node:fs";
import { z } from "zod";
import { type Activity, toolCall, toolTarget } from "./activity.ts";
import { RESULT_TOOLS, type ResultCall } from "./results.ts";
import type { Sample } from "./rates.ts";

export const STOP_REASONS = [
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

const Envelope = z.looseObject({ type: z.string() });

const Response = z.looseObject({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const ToolStart = z.looseObject({
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const Compaction = z.looseObject({ reason: z.string() });

const AutoRetry = z.looseObject({
  attempt: z.number(),
  maxAttempts: z.number(),
});

const MessageEnd = z.looseObject({
  message: z.looseObject({
    role: z.string(),
    stopReason: z.enum(STOP_REASONS).optional(),
    errorMessage: z.string().nullish(),
    usage: z.looseObject({ output: z.number().optional() }).optional(),
  }),
});

export type PiRecord = z.infer<typeof Envelope>;

export type PiResponse = z.infer<typeof Response>;

export class JsonlSplitter {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0);
  }

  get pending(): string {
    return this.buffer;
  }
}

export const LOOP_LIMIT = 10;

export interface StreamState {
  activity: Activity;
  stopReason: StopReason | null;
  errorMessage: string | null;
  settled: boolean;
  retrying: boolean;
  failure: string | null;
  looping: string | null;
}

function signature(record: PiRecord): string {
  const { toolName, args } = ToolStart.parse(record);
  return `${toolName} ${JSON.stringify(args ?? {})}`;
}

export type OnUsage = (sample: Sample) => void;

export type OnCompaction = () => void;

export type OnResult = (call: ResultCall) => void;

export class PiStream {
  private readonly splitter = new JsonlSplitter();
  private readonly waiting = new Map<
    string,
    { resolve: (value: PiResponse) => void; reject: (err: Error) => void }
  >();
  private settleWaiters: (() => void)[] = [];

  private repeated = { signature: "", count: 0 };

  readonly state: StreamState = {
    activity: { kind: "none" },
    stopReason: null,
    errorMessage: null,
    settled: false,
    retrying: false,
    failure: null,
    looping: null,
  };

  constructor(
    private readonly onUsage: OnUsage = () => {},
    private readonly onCompaction: OnCompaction = () => {},
    private readonly onResult: OnResult = () => {},
  ) {}

  feed(chunk: string): PiRecord[] {
    const records: PiRecord[] = [];

    for (const line of this.splitter.feed(chunk)) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const record = Envelope.parse(json);
      records.push(record);
      this.apply(record);
    }

    return records;
  }

  private apply(record: PiRecord): void {
    switch (record.type) {
      case "response": {
        const response = Response.parse(record);
        if (response.id !== undefined) {
          this.waiting.get(response.id)?.resolve(response);
          this.waiting.delete(response.id);
        }
        break;
      }
      case "agent_start": {
        this.starting();
        break;
      }
      case "tool_execution_start": {
        const { toolName, args } = ToolStart.parse(record);
        this.state.activity = toolCall(toolName, args ?? {});
        this.repeat(record);
        if ((RESULT_TOOLS as readonly string[]).includes(toolName)) {
          this.onResult({ tool: toolName, args: args ?? {} });
        }
        break;
      }
      case "tool_execution_end": {
        this.state.activity = { kind: "thinking", started_at: Date.now() };
        break;
      }
      case "compaction_start": {
        this.state.activity = {
          kind: "compacting",
          reason: Compaction.parse(record).reason,
          started_at: Date.now(),
        };
        this.onCompaction();
        break;
      }
      case "auto_retry_start": {
        const retry = AutoRetry.parse(record);
        this.state.retrying = true;
        this.state.activity = {
          kind: "tool-call",
          tool: "retry",
          target: `${retry.attempt}/${retry.maxAttempts}`,
          started_at: Date.now(),
        };
        break;
      }
      case "auto_retry_end": {
        this.state.retrying = false;
        break;
      }
      case "message_end": {
        const { message } = MessageEnd.parse(record);
        if (message.role !== "assistant") {
          break;
        }
        const output = message.usage?.output;
        if (typeof output === "number") {
          this.onUsage({ timestampMs: Date.now(), tokens: output });
        }
        if (message.stopReason !== undefined) {
          this.state.stopReason = message.stopReason;
        }
        this.state.errorMessage = message.errorMessage ?? null;
        break;
      }
      case "agent_settled": {
        this.state.settled = true;
        this.state.activity = { kind: "none" };
        for (const waiter of this.settleWaiters) {
          waiter();
        }
        this.settleWaiters = [];
        break;
      }
    }
  }

  private repeat(record: PiRecord): void {
    const current = signature(record);
    this.repeated =
      current === this.repeated.signature
        ? { signature: current, count: this.repeated.count + 1 }
        : { signature: current, count: 1 };

    if (this.repeated.count >= LOOP_LIMIT) {
      const { toolName, args } = ToolStart.parse(record);
      this.state.looping = toolTarget(toolName, args ?? {});
    }
  }

  starting(): void {
    this.state.settled = false;
    this.state.stopReason = null;
    this.state.errorMessage = null;
    this.state.activity = { kind: "thinking", started_at: Date.now() };
    this.state.looping = null;
    this.repeated = { signature: "", count: 0 };
  }

  expect(id: string): Promise<PiResponse> {
    if (this.state.failure !== null) {
      return Promise.reject(new Error(this.state.failure));
    }
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
    });
  }

  reject(id: string, err: Error): void {
    this.waiting.get(id)?.reject(err);
    this.waiting.delete(id);
  }

  settled(): Promise<void> {
    if (this.state.settled) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  fail(reason: string): void {
    this.state.failure = reason;
    for (const [, waiter] of this.waiting) {
      waiter.reject(new Error(reason));
    }
    this.waiting.clear();
    for (const waiter of this.settleWaiters) {
      waiter();
    }
    this.settleWaiters = [];
  }
}

export interface SpawnOptions {
  provider: string;
  model: string;
  sessionDir: string;
  name: string;
  cwd: string;
  extension: string;
  log: string;
}

export function spawnArgs(options: SpawnOptions): string[] {
  return [
    "--mode",
    "rpc",
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--session-dir",
    options.sessionDir,
    "--name",
    options.name,
    "--approve",
    "--extension",
    options.extension,
  ];
}

export class PiProcess {
  readonly stream: PiStream;
  readonly pid: number;

  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly log: number;
  private nextId = 0;
  private closed = false;
  private aborting = false;
  private stderr = "";

  constructor(
    options: SpawnOptions,
    command = "pi",
    launch: string[] = [],
    onUsage: OnUsage = () => {},
    onCompaction: OnCompaction = () => {},
    onResult: OnResult = () => {},
  ) {
    this.stream = new PiStream(onUsage, onCompaction, onResult);
    fs.mkdirSync(options.sessionDir, { recursive: true });
    this.log = fs.openSync(options.log, "a");

    this.proc = Bun.spawn([...launch, command, ...spawnArgs(options)], {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: { ...process.env },
    }) as Bun.Subprocess<"pipe", "pipe", "pipe">;

    this.pid = this.proc.pid;
    void this.pump();
    void this.pumpErrors();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      fs.writeSync(this.log, text);
      this.stream.feed(text);
      if (this.stream.state.looping !== null) {
        this.interrupt();
      }
    }
    this.stream.fail(
      `the pi process closed its stdout${this.stderr === "" ? "" : `: ${this.stderr.trim()}`}`,
    );
    fs.closeSync(this.log);
  }

  private async pumpErrors(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr += decoder.decode(chunk, { stream: true });
    }
  }

  get alive(): boolean {
    return (
      !this.closed &&
      this.proc.exitCode === null &&
      this.stream.state.failure === null
    );
  }

  send(command: Record<string, unknown>): Promise<PiResponse> {
    const id = String(++this.nextId);
    const expected = this.stream.expect(id);
    try {
      this.write({ id, ...command });
    } catch (err) {
      this.stream.reject(id, err as Error);
    }
    return expected;
  }

  private write(payload: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error("the pi process stdin is already closed");
    }
    if (!this.alive) {
      throw new Error(
        this.stream.state.failure ?? "the pi process has already exited",
      );
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    this.proc.stdin.flush();
  }

  async newSession(): Promise<string> {
    await this.send({ type: "new_session" });
    const state = await this.send({ type: "get_state" });
    const file = state.data?.sessionFile;
    if (typeof file !== "string") {
      throw new Error("pi started a session with no sessionFile");
    }
    return file;
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
  }

  async prompt(message: string): Promise<void> {
    this.aborting = false;
    this.stream.starting();
    await this.send({ type: "prompt", message });
  }

  abort(): void {
    this.aborting = true;
    this.write({ type: "abort" });
  }

  abortBash(): void {
    this.write({ type: "abort_bash" });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  private interrupt(): void {
    if (this.aborting || !this.alive) {
      return;
    }
    this.abort();
  }

  async stats(): Promise<{
    tokens: number | null;
    contextPercent: number | null;
  }> {
    const data = (await this.send({ type: "get_session_stats" })).data ?? {};
    const tokens = (data.tokens as { total?: number } | undefined)?.total;
    const percent = (data.contextUsage as { percent?: number } | undefined)
      ?.percent;
    return {
      tokens: typeof tokens === "number" ? tokens : null,
      contextPercent: typeof percent === "number" ? percent : null,
    };
  }

  async lastAssistantText(): Promise<string | null> {
    const response = await this.send({ type: "get_last_assistant_text" });
    const text = response.data?.text;
    return typeof text === "string" ? text : null;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.proc.stdin.end();
  }

  kill(): void {
    this.close();
    this.proc.kill();
  }
}
