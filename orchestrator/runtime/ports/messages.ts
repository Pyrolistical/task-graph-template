import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { ClaimState } from "../../vocabulary/state-machine.ts";
import type { TaskId } from "../../vocabulary/task.ts";

export interface Messages {
  queue(taskId: TaskId, state: ClaimState, message: string): Awaitable<void>;
  drain(taskId: TaskId, state: ClaimState): Awaitable<string>;
  queued(taskId: TaskId, state: ClaimState): Awaitable<boolean>;
}
