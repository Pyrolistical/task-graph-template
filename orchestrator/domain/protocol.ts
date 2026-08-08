import { z } from "zod";
import { type Activity, toolCall, toolTarget } from "./activity.ts";
import { type ResultCall, isResultTool } from "./results.ts";
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

export const SessionStats = z.looseObject({
  tokens: z.looseObject({ total: z.number().optional() }).optional(),
  contextUsage: z.looseObject({ percent: z.number().optional() }).optional(),
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
        if (isResultTool(toolName)) {
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
