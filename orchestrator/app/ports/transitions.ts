import type { TaskState } from "../../domain/state-machine.ts";
import type { TaskId } from "../../domain/task.ts";

export interface TransitionEntry {
  seq: number;
  at: string;
  task_id: TaskId;
  transition: string;
  from: TaskState;
  to: TaskState;
  by: string;
}

export interface Transitions {
  readonly cursor: number;
  read(): TransitionEntry[];
  append(entry: Omit<TransitionEntry, "seq" | "at">): void;
}
