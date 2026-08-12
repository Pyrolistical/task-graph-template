import type { Slot } from "../../domain/agents.ts";
import type { Awaitable } from "../../domain/awaitable.ts";
import type { StreamState } from "../../domain/protocol.ts";
import type { Sample } from "../../domain/rates.ts";
import type { ResultCall } from "../../domain/results.ts";
import type { ClaimState, Role } from "../../domain/state-machine.ts";
import type { TaskId } from "../../domain/task.ts";

export interface AgentSpec {
  taskId: TaskId;
  state: ClaimState;
  role: Role;
  slot: Slot;
  cwd: string;
}

export interface AgentProcess {
  readonly pid: number;
  readonly alive: boolean;
  readonly stream: { readonly state: StreamState; settled(): Awaitable<void> };
  newSession(): Awaitable<string>;
  switchSession(path: string): Awaitable<void>;
  prompt(message: string): Awaitable<void>;
  steer(message: string): Awaitable<void>;
  abort(): void;
  abortBash(): void;
  stats(): Awaitable<{
    tokens?: number;
    contextPercent?: number;
  }>;
  lastAssistantText(): Awaitable<string | undefined>;
  close(): void;
  kill(): void;
}

export interface Agents {
  slots(): Slot[];
  hasSession(path: string): Awaitable<boolean>;
  healthy(slot: Slot): Awaitable<boolean>;
  spawn(
    spec: AgentSpec,
    onUsage: (sample: Sample) => void,
    onCompaction: () => void,
    onResult: (call: ResultCall) => void,
  ): Awaitable<AgentProcess>;
}
