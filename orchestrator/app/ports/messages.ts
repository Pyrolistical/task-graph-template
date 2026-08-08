import type { ClaimState } from "../../domain/state-machine.ts";
import type { TaskId } from "../../domain/task.ts";

export interface Messages {
  queue(taskId: TaskId, state: ClaimState, message: string): void;
  drain(taskId: TaskId, state: ClaimState): string;
  queued(taskId: TaskId, state: ClaimState): boolean;
}
