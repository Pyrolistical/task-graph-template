import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { Cost } from "../../vocabulary/costs.ts";
import type {
  TransitionArgs,
  TransitionName,
  TransitionResult,
} from "../../vocabulary/state-machine.ts";
import type { TaskId, TaskMeta } from "../../vocabulary/task.ts";

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
  list(): Awaitable<{
    tasks: Map<TaskId, TaskMeta>;
    problems: Map<string, string>;
  }>;
  read(id: TaskId): Awaitable<TaskMeta | undefined>;
  body(id: TaskId): Awaitable<string>;
  create(title: string): Awaitable<CreatedTask>;
  writeBody(id: TaskId, body: string): Awaitable<string>;
  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): Awaitable<TransitionResult>;
  claim(id: TaskId, args: ClaimArgs): Awaitable<void>;
  releaseClaim(id: TaskId): Awaitable<void>;
  recordCost(id: TaskId, cost: Cost, resumed: boolean): Awaitable<void>;
  takeLock(): Awaitable<void>;
  clearLock(): Awaitable<void>;
}
