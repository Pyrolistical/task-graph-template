import type { Slot } from "../../domain/agents.ts";
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
  readonly stream: { readonly state: StreamState; settled(): Promise<void> };
  newSession(): Promise<string>;
  switchSession(path: string): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): void;
  abortBash(): void;
  stats(): Promise<{ tokens: number | null; contextPercent: number | null }>;
  lastAssistantText(): Promise<string | null>;
  close(): void;
  kill(): void;
}

export interface Agents {
  slots(): Slot[];
  hasSession(path: string): boolean;
  spawn(
    spec: AgentSpec,
    onUsage: (sample: Sample) => void,
    onCompaction: () => void,
    onResult: (call: ResultCall) => void,
  ): AgentProcess;
}
