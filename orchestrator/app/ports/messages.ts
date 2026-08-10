import type { Awaitable } from "../../domain/awaitable.ts";
import type { ClaimState } from "../../domain/state-machine.ts";
import type { TaskId } from "../../domain/task.ts";

export interface Messages {
  queue(taskId: TaskId, state: ClaimState, message: string): Awaitable<void>;
  drain(taskId: TaskId, state: ClaimState): Awaitable<string>;
  queued(taskId: TaskId, state: ClaimState): Awaitable<boolean>;
}
