import fs from "node:fs/promises";
import path from "node:path";
import type { ClaimArgs, CreatedTask, Tasks } from "../app/ports/tasks.ts";
import { type Cost, recorded } from "../domain/costs.ts";
import { hasCode, messageOf } from "../domain/errors.ts";
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
  UNBLOCK_TARGETS,
  decide,
  isBlocked,
  isClaimState,
  isHeld,
  isValidState,
  requireText,
} from "../domain/state-machine.ts";
import { exists } from "./files.ts";
import { isProcessAlive } from "./processes.ts";
import {
  activeTaskPath,
  closeTaskFile,
  createTask,
  findTaskFile,
  graphLock,
  readTaskFile,
  writeTaskBody,
  writeTaskFile,
} from "./task-store.ts";

export interface Scan {
  tasks: Map<TaskId, TaskMeta>;
  problems: Map<string, string>;
}

export async function readActiveTasks(tasksDir: string): Promise<Scan> {
  const tasks = new Map<TaskId, TaskMeta>();
  const problems = new Map<string, string>();

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{6}\.md$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(tasksDir, entry.name);
    try {
      const { raw } = parseDocument(await fs.readFile(filePath, "utf-8"));
      const meta = parseTaskMeta(raw, filePath);
      tasks.set(meta.id, meta);
    } catch (err) {
      problems.set(filePath, messageOf(err));
    }
  }

  return { tasks, problems };
}

export async function readTaskBody(
  tasksDir: string,
  id: TaskId,
): Promise<string> {
  const filePath = activeTaskPath(tasksDir, id);
  return splitDocument(await fs.readFile(filePath, "utf-8")).body.trim();
}

async function activeTaskIds(tasksDir: string): Promise<TaskId[]> {
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /^\d{6}\.md$/.test(e.name))
    .map((e) => path.basename(e.name, ".md"));
}

async function propagateClose(
  tasksDir: string,
  closedId: TaskId,
  now: string,
): Promise<{ unblocked: TaskId[]; dependentsUpdated: TaskId[] }> {
  const unblocked: TaskId[] = [];
  const dependentsUpdated: TaskId[] = [];

  for (const id of await activeTaskIds(tasksDir)) {
    const filePath = activeTaskPath(tasksDir, id);
    if (!(await exists(filePath))) continue;

    const { meta, body } = await readTaskFile(filePath);
    if (!meta.depends_on.includes(closedId)) continue;

    meta.depends_on = meta.depends_on.filter((d) => d !== closedId);
    dependentsUpdated.push(meta.id);

    if (isBlocked(meta.state) && meta.depends_on.length === 0) {
      meta.state = UNBLOCK_TARGETS[meta.state];
      unblocked.push(meta.id);
    }
    meta.state_entered = now;

    await writeTaskFile(filePath, meta, body);
  }

  return { unblocked, dependentsUpdated };
}

async function settleTransition(
  tasksDir: string,
  taskId: TaskId,
  name: TransitionName,
  args: TransitionArgs,
  now: string,
): Promise<TransitionResult> {
  const filePath = await findTaskFile(taskId, tasksDir);
  if (!filePath) {
    throw new Error(`Task "${taskId}" not found`);
  }

  const { meta, body } = await readTaskFile(filePath);

  if (meta.id !== taskId) {
    throw new Error(`Task file ${filePath} declares id "${meta.id}"`);
  }

  if (!isValidState(meta.state)) {
    throw new Error(
      `Task "${meta.id}" is ${meta.state} and has no further transitions`,
    );
  }

  const from = meta.state;
  const decided = decide(meta, body, name, args);

  meta.state_entered = now;
  meta.claimed_by = undefined;
  meta.claimed_pid = undefined;

  if (decided.kind === "stay") {
    await writeTaskFile(filePath, meta, body);
    return {
      taskId,
      from,
      to: undefined,
      unblocked: [],
      dependentsUpdated: [],
    };
  }

  const nextBody = decided.body ?? body;
  meta.state = decided.to;
  if (!isHeld(decided.to)) {
    meta.held_reason = undefined;
  }

  if (decided.to === "CLOSED") {
    meta.workspace = undefined;
    const closedPath = await closeTaskFile(filePath, tasksDir, meta, nextBody);
    return {
      taskId,
      from,
      to: "CLOSED",
      closedPath,
      unblocked: [],
      dependentsUpdated: [],
    };
  }

  await writeTaskFile(filePath, meta, nextBody);
  return {
    taskId,
    from,
    to: decided.to,
    unblocked: [],
    dependentsUpdated: [],
  };
}

export async function applyTransition(
  tasksDir: string,
  taskId: TaskId,
  name: TransitionName,
  args: TransitionArgs,
): Promise<TransitionResult> {
  const now = new Date().toISOString();
  const settled = await settleTransition(tasksDir, taskId, name, args, now);

  if (settled.to !== "CLOSED") {
    return settled;
  }
  return { ...settled, ...(await propagateClose(tasksDir, taskId, now)) };
}

function requirePid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `"pid" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function workSession(meta: TaskMeta, session?: string): string | undefined {
  if (meta.state !== "WORK") {
    return meta.workspace?.session;
  }
  return session;
}

export async function takeClaim(
  tasksDir: string,
  taskId: TaskId,
  args: ClaimArgs,
): Promise<void> {
  const filePath = await findTaskFile(taskId, tasksDir);
  if (!filePath) {
    throw new Error(`Task "${taskId}" not found`);
  }

  const { meta, body } = await readTaskFile(filePath);

  if (!isClaimState(meta.state)) {
    throw new Error(
      `Task "${taskId}" is in ${meta.state}, which no agent runs. Claimable states: ${CLAIM_STATES.join(", ")}`,
    );
  }
  if (meta.claimed_by) {
    throw new Error(
      `Task "${taskId}" is already claimed by "${meta.claimed_by}" (PID ${meta.claimed_pid})`,
    );
  }

  meta.claimed_by = requireText(args.slotName, "slotName");
  meta.claimed_pid = requirePid(args.pid);

  if (args.branch || args.worktree) {
    const session = workSession(meta, args.session);
    meta.workspace = {
      branch: requireText(args.branch, "branch"),
      worktree: requireText(args.worktree, "worktree"),
      slot: meta.claimed_by,
      session,
    };
  }

  await writeTaskFile(filePath, meta, body);
}

export async function clearClaim(
  tasksDir: string,
  taskId: TaskId,
): Promise<void> {
  const filePath = await findTaskFile(taskId, tasksDir);
  if (!filePath) {
    throw new Error(`Task "${taskId}" not found`);
  }

  const { meta, body } = await readTaskFile(filePath);

  if (!meta.claimed_pid) {
    throw new Error(
      `Task "${taskId}" is in ${meta.state} with no claim to clear`,
    );
  }
  if (await isProcessAlive(meta.claimed_pid)) {
    throw new Error(
      `Task "${taskId}" is still claimed by a live process (PID ${meta.claimed_pid}); a claim is only cleared once its process is gone`,
    );
  }

  meta.claimed_by = undefined;
  meta.claimed_pid = undefined;

  await writeTaskFile(filePath, meta, body);
}

export async function addCost(
  tasksDir: string,
  taskId: TaskId,
  cost: Cost,
  resumed: boolean,
): Promise<void> {
  const filePath = await findTaskFile(taskId, tasksDir);
  if (!filePath) {
    throw new Error(`Task "${taskId}" not found`);
  }

  const { meta, body } = await readTaskFile(filePath);

  meta.costs = recorded(meta.costs, cost, resumed);

  await writeTaskFile(filePath, meta, body);
}

export class TaskDocuments implements Tasks {
  constructor(
    private readonly tasksDir: string,
    private readonly orchestratorDir: string,
  ) {}

  list(): Promise<Scan> {
    return readActiveTasks(this.tasksDir);
  }

  async read(id: TaskId): Promise<TaskMeta | undefined> {
    const filePath = await findTaskFile(id, this.tasksDir);
    if (!filePath) {
      return undefined;
    }
    const found = await readTaskFile(filePath).catch((err: unknown) => {
      if (hasCode(err, "ENOENT")) {
        return undefined;
      }
      throw err;
    });
    return found?.meta;
  }

  body(id: TaskId): Promise<string> {
    return readTaskBody(this.tasksDir, id);
  }

  create(title: string): Promise<CreatedTask> {
    return createTask(this.tasksDir, this.orchestratorDir, title);
  }

  writeBody(id: TaskId, body: string): Promise<string> {
    return writeTaskBody(this.tasksDir, id, body);
  }

  apply(
    id: TaskId,
    name: TransitionName,
    args: TransitionArgs,
  ): Promise<TransitionResult> {
    return applyTransition(this.tasksDir, id, name, args);
  }

  async claim(id: TaskId, args: ClaimArgs): Promise<void> {
    await takeClaim(this.tasksDir, id, args);
  }

  async releaseClaim(id: TaskId): Promise<void> {
    await clearClaim(this.tasksDir, id);
  }

  async recordCost(id: TaskId, cost: Cost, resumed: boolean): Promise<void> {
    await addCost(this.tasksDir, id, cost, resumed);
  }

  takeLock(): Promise<void> {
    return graphLock(this.tasksDir).take();
  }

  clearLock(): Promise<void> {
    return graphLock(this.tasksDir).clear();
  }
}
