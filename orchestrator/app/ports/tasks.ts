import type {
  TransitionArgs,
  TransitionName,
  TransitionResult,
} from "../../domain/state-machine.ts";
import type { TaskId, TaskMeta } from "../../domain/task.ts";

export interface ClaimArgs {
  slotName: string;
  pid: number;
  branch?: string;
  worktree?: string;
  session?: string;
}

export interface CreatedTask {
  id: TaskId;
  filePath: string;
}

export interface Tasks {
  list(): { tasks: Map<TaskId, TaskMeta>; problems: Map<string, string> };
  read(id: TaskId): TaskMeta | null;
  body(id: TaskId): string;
  create(title: string): CreatedTask;
  writeBody(id: TaskId, body: string): string;
  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): TransitionResult;
  claim(id: TaskId, args: ClaimArgs): void;
  releaseClaim(id: TaskId): void;
}
