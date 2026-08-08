import fs from "node:fs";
import path from "node:path";
import type { ClaimArgs, CreatedTask, Tasks } from "../app/ports/tasks.ts";
import { messageOf } from "../domain/errors.ts";
import {
  type TaskId,
  type TaskMeta,
  parseDocument,
  parseTaskMeta,
  splitDocument,
} from "../domain/task.ts";
import {
  type TransitionArgs,
  type TransitionName,
  type TransitionResult,
  CLAIM_STATES,
  ENTRY_STATE,
  decide,
  isClaimState,
  isHeld,
  isValidState,
  requireText,
} from "../domain/state-machine.ts";
import {
  activeTaskPath,
  closeTaskFile,
  createTask,
  findTaskFile,
  isProcessAlive,
  readTaskFile,
  withLock,
  writeTaskBody,
  writeTaskFile,
} from "./task-store.ts";

export interface Scan {
  tasks: Map<TaskId, TaskMeta>;
  problems: Map<string, string>;
}

export function readActiveTasks(tasksDir: string): Scan {
  const tasks = new Map<TaskId, TaskMeta>();
  const problems = new Map<string, string>();

  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{6}\.md$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(tasksDir, entry.name);
    try {
      const { raw } = parseDocument(fs.readFileSync(filePath, "utf-8"));
      const meta = parseTaskMeta(raw, filePath);
      tasks.set(meta.id, meta);
    } catch (err) {
      problems.set(filePath, messageOf(err));
    }
  }

  return { tasks, problems };
}

export function readTaskBody(tasksDir: string, id: TaskId): string {
  const filePath = activeTaskPath(tasksDir, id);
  return splitDocument(fs.readFileSync(filePath, "utf-8")).body.trim();
}

function activeTaskFiles(tasksDir: string): string[] {
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d{6}\.md$/.test(e.name))
    .map((e) => path.join(tasksDir, e.name));
}

function propagateClose(
  tasksDir: string,
  closedId: TaskId,
  now: string,
): { unblocked: TaskId[]; dependentsUpdated: TaskId[] } {
  const unblocked: TaskId[] = [];
  const dependentsUpdated: TaskId[] = [];

  for (const filePath of activeTaskFiles(tasksDir)) {
    const { meta, body } = readTaskFile(filePath);
    if (!meta.depends_on.includes(closedId)) continue;

    meta.depends_on = meta.depends_on.filter((d) => d !== closedId);
    dependentsUpdated.push(meta.id);

    if (meta.state === "BLOCKED" && meta.depends_on.length === 0) {
      meta.state = ENTRY_STATE;
      unblocked.push(meta.id);
    }
    meta.state_entered = now;

    writeTaskFile(filePath, meta, body);
  }

  return { unblocked, dependentsUpdated };
}

export function applyTransition(
  tasksDir: string,
  taskId: TaskId,
  name: TransitionName,
  args: TransitionArgs,
): TransitionResult {
  return withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (meta.id !== taskId) {
      throw new Error(`Task file ${filePath} declares id "${meta.id}"`);
    }

    if (!isValidState(meta.state)) {
      throw new Error(
        `Task "${meta.id}" is ${meta.state} and has no further transitions`,
      );
    }

    const from = meta.state;
    const now = new Date().toISOString();
    const decided = decide(meta, body, name, args);

    meta.state_entered = now;
    meta.claimed_by = null;
    meta.claimed_pid = null;

    if (decided.kind === "stay") {
      writeTaskFile(filePath, meta, body);
      return { taskId, from, to: null, unblocked: [], dependentsUpdated: [] };
    }

    const nextBody = decided.body ?? body;
    meta.state = decided.to;
    if (!isHeld(decided.to)) {
      meta.held_reason = null;
    }

    if (decided.to === "CLOSED") {
      meta.workspace = null;
      const closedPath = closeTaskFile(filePath, tasksDir, meta, nextBody);
      const { unblocked, dependentsUpdated } = propagateClose(
        tasksDir,
        taskId,
        now,
      );
      return {
        taskId,
        from,
        to: "CLOSED",
        closedPath,
        unblocked,
        dependentsUpdated,
      };
    }

    writeTaskFile(filePath, meta, nextBody);
    return {
      taskId,
      from,
      to: decided.to,
      unblocked: [],
      dependentsUpdated: [],
    };
  });
}

function requirePid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `"pid" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function workSession(
  meta: TaskMeta,
  session: string | undefined,
): string | null {
  if (meta.state !== "WORK") {
    return meta.workspace?.session ?? null;
  }
  return session === undefined ? null : session;
}

export function takeClaim(
  tasksDir: string,
  taskId: TaskId,
  args: ClaimArgs,
): void {
  withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (!isClaimState(meta.state)) {
      throw new Error(
        `Task "${taskId}" is in ${meta.state}, which no agent runs. Claimable states: ${CLAIM_STATES.join(", ")}`,
      );
    }
    if (meta.claimed_by !== null) {
      throw new Error(
        `Task "${taskId}" is already claimed by "${meta.claimed_by}" (PID ${meta.claimed_pid})`,
      );
    }

    meta.claimed_by = requireText(args.slotName, "slotName");
    meta.claimed_pid = requirePid(args.pid);

    if (args.branch !== undefined || args.worktree !== undefined) {
      const session = workSession(meta, args.session);
      meta.workspace = {
        branch: requireText(args.branch, "branch"),
        worktree: requireText(args.worktree, "worktree"),
        slot: meta.claimed_by,
        session,
      };
    }

    writeTaskFile(filePath, meta, body);
  });
}

export function clearClaim(tasksDir: string, taskId: TaskId): void {
  withLock(tasksDir, () => {
    const filePath = findTaskFile(taskId, tasksDir);
    if (!filePath) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const { meta, body } = readTaskFile(filePath);

    if (meta.claimed_pid === null) {
      throw new Error(
        `Task "${taskId}" is in ${meta.state} with no claim to clear`,
      );
    }
    if (isProcessAlive(meta.claimed_pid)) {
      throw new Error(
        `Task "${taskId}" is still claimed by a live process (PID ${meta.claimed_pid}); a claim is only cleared once its process is gone`,
      );
    }

    meta.claimed_by = null;
    meta.claimed_pid = null;

    writeTaskFile(filePath, meta, body);
  });
}

export class TaskDocuments implements Tasks {
  constructor(
    private readonly tasksDir: string,
    private readonly orchestratorDir: string,
  ) {}

  list(): Scan {
    return readActiveTasks(this.tasksDir);
  }

  read(id: TaskId): TaskMeta | null {
    const filePath = findTaskFile(id, this.tasksDir);
    return filePath === null ? null : readTaskFile(filePath).meta;
  }

  body(id: TaskId): string {
    return readTaskBody(this.tasksDir, id);
  }

  create(title: string): CreatedTask {
    return createTask(this.tasksDir, this.orchestratorDir, title);
  }

  writeBody(id: TaskId, body: string): string {
    return writeTaskBody(this.tasksDir, id, body);
  }

  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): TransitionResult {
    return applyTransition(this.tasksDir, id, name, args);
  }

  claim(id: TaskId, args: ClaimArgs): void {
    takeClaim(this.tasksDir, id, args);
  }

  releaseClaim(id: TaskId): void {
    clearClaim(this.tasksDir, id);
  }
}
