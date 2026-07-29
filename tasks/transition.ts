#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type TaskGraphUpdate,
  type TaskId,
  type TaskMeta,
  type TaskState,
  type ValidState,
  UPDATE_OPS,
  type UpdateOp,
  closeTaskFile,
  findTaskFile,
  isProcessAlive,
  isValidId,
  readTaskFile,
  withLock,
  writeTaskFile,
} from "./task.ts";

export const TRANSITION_NAMES = [
  "addDependencies",
  "removeDependencies",
  "noDependencies",
  "claim",
  "release",
  "submit",
  "pass",
  "addTodo",
  "doneTodo",
  "addCheck",
  "doneCheck",
  "addTaskGraph",
  "doneTaskGraph",
] as const;

export type TransitionName = (typeof TRANSITION_NAMES)[number];

export const ALLOWED_TRANSITIONS: Record<ValidState, TransitionName[]> = {
  NEW: ["addDependencies", "noDependencies", "addTodo", "addCheck"],
  BLOCKED: ["addDependencies", "removeDependencies"],
  READY_WORK: ["addDependencies", "addTodo", "addCheck", "claim"],
  WORKING: ["addTodo", "doneTodo", "addCheck", "submit", "release"],
  READY_CHECK: ["claim"],
  CHECKING: ["addCheck", "doneCheck", "addTodo", "pass", "release"],
  READY_REVIEW: ["claim"],
  REVIEWING: ["addTodo", "addTaskGraph", "pass", "release"],
  READY_TASK_GRAPH_UPDATE: ["addTaskGraph", "claim"],
  TASK_GRAPH_UPDATING: ["addTaskGraph", "doneTaskGraph", "release"],
};

const CLAIM_TARGETS: Partial<Record<ValidState, ValidState>> = {
  READY_WORK: "WORKING",
  READY_CHECK: "CHECKING",
  READY_REVIEW: "REVIEWING",
  READY_TASK_GRAPH_UPDATE: "TASK_GRAPH_UPDATING",
};

const RELEASE_TARGETS: Partial<Record<ValidState, ValidState>> = {
  WORKING: "READY_WORK",
  CHECKING: "READY_CHECK",
  REVIEWING: "READY_REVIEW",
  TASK_GRAPH_UPDATING: "READY_TASK_GRAPH_UPDATE",
};

const UNCLAIMED_STATES: TaskState[] = [
  "NEW",
  "BLOCKED",
  "READY_WORK",
  "READY_CHECK",
  "READY_REVIEW",
  "READY_TASK_GRAPH_UPDATE",
  "CLOSED",
];

export interface TransitionArgs {
  taskIds?: TaskId[];
  agentName?: string;
  pid?: number;
  message?: string;
  command?: string;
  index?: number;
  op?: UpdateOp;
  taskId?: TaskId;
}

export interface TransitionResult {
  taskId: TaskId;
  from: ValidState;
  to: TaskState | null;
  closedPath?: string;
  unblocked: TaskId[];
  dependentsUpdated: TaskId[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `"${label}" must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requirePid(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `"pid" must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

function requireOp(value: unknown): UpdateOp {
  if (!UPDATE_OPS.includes(value as UpdateOp)) {
    throw new Error(
      `"op" must be one of ${UPDATE_OPS.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as UpdateOp;
}

function requireIdList(value: unknown, label: string): TaskId[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"${label}" must be a non-empty list of task IDs`);
  }
  for (const id of value) {
    if (!isValidId(id)) {
      throw new Error(
        `"${label}" contains ${JSON.stringify(id)}, which is not a six-digit task ID`,
      );
    }
  }
  return value as TaskId[];
}

function requireOpenTask(
  tasksDir: string,
  value: unknown,
  label: string,
): TaskId {
  if (!isValidId(value)) {
    throw new Error(
      `"${label}" must be a six-digit task ID, got ${JSON.stringify(value)}`,
    );
  }
  if (fs.existsSync(path.join(tasksDir, `${value}.md`))) {
    return value;
  }
  if (findTaskFile(value, tasksDir) !== null) {
    throw new Error(`Task "${value}" is CLOSED and cannot be used as ${label}`);
  }
  throw new Error(
    `Task "${value}" does not exist and cannot be used as ${label}`,
  );
}

function requireIndex(
  list: { done: boolean }[],
  index: unknown,
  label: string,
): number {
  if (!Number.isInteger(index) || (index as number) < 0) {
    throw new Error(
      `"index" must be a non-negative integer, got ${JSON.stringify(index)}`,
    );
  }
  if (list.length === 0) {
    throw new Error(`there are no ${label} entries to mark done`);
  }
  if ((index as number) >= list.length) {
    throw new Error(
      `${label} index ${index} is out of range (0..${list.length - 1})`,
    );
  }
  if (list[index as number]!.done) {
    throw new Error(`${label} index ${index} is already done`);
  }
  return index as number;
}

function openCount(list: { done: boolean }[]): number {
  return list.filter((item) => !item.done).length;
}

function mutate(
  tasksDir: string,
  meta: TaskMeta,
  state: ValidState,
  name: TransitionName,
  args: TransitionArgs,
  now: string,
): TaskState | null {
  switch (name) {
    case "addDependencies": {
      for (const dep of requireIdList(args.taskIds, "taskIds")) {
        if (dep === meta.id) {
          throw new Error(`Task "${meta.id}" cannot depend on itself`);
        }
        requireOpenTask(tasksDir, dep, "a dependency");
        if (!meta.depends_on.includes(dep)) {
          meta.depends_on.push(dep);
        }
      }
      return state === "BLOCKED" ? null : "BLOCKED";
    }

    case "removeDependencies": {
      const ids = requireIdList(args.taskIds, "taskIds");
      meta.depends_on = meta.depends_on.filter((d) => !ids.includes(d));
      return meta.depends_on.length === 0 ? "READY_WORK" : null;
    }

    case "noDependencies": {
      if (meta.depends_on.length > 0) {
        throw new Error(
          `Task "${meta.id}" still depends on ${meta.depends_on.join(", ")}`,
        );
      }
      return "READY_WORK";
    }

    case "claim": {
      if (meta.claimed_by !== null) {
        throw new Error(
          `Task "${meta.id}" is already claimed by "${meta.claimed_by}" (PID ${meta.claimed_pid})`,
        );
      }
      meta.claimed_by = requireText(args.agentName, "agentName");
      meta.claimed_pid = requirePid(args.pid);
      return CLAIM_TARGETS[state]!;
    }

    case "release": {
      if (meta.claimed_pid === null) {
        throw new Error(
          `Task "${meta.id}" is in ${state} with no claim to release`,
        );
      }
      if (isProcessAlive(meta.claimed_pid)) {
        throw new Error(
          `Task "${meta.id}" is still claimed by a live process (PID ${meta.claimed_pid}); release is only for dead claims`,
        );
      }
      return RELEASE_TARGETS[state]!;
    }

    case "submit": {
      const open = openCount(meta.todos);
      if (open > 0) {
        throw new Error(
          `Task "${meta.id}" has ${open} open todo(s); resolve them first`,
        );
      }
      return "READY_CHECK";
    }

    case "pass": {
      if (state === "CHECKING") {
        const open = openCount(meta.checks);
        if (open > 0) {
          throw new Error(`Task "${meta.id}" has ${open} check(s) not yet run`);
        }
        return "READY_REVIEW";
      }
      const open = openCount(meta.todos);
      if (open > 0) {
        throw new Error(
          `Task "${meta.id}" has ${open} open todo(s); cannot close`,
        );
      }
      return "CLOSED";
    }

    case "addTodo": {
      meta.todos.push({
        at: now,
        message: requireText(args.message, "message"),
        done: false,
      });
      return state === "CHECKING" || state === "REVIEWING"
        ? "READY_WORK"
        : null;
    }

    case "doneTodo": {
      const index = requireIndex(meta.todos, args.index, "todo");
      meta.todos[index]!.done = true;
      return null;
    }

    case "addCheck": {
      const command = requireText(args.command, "command");
      if (meta.checks.some((c) => c.command === command)) {
        throw new Error(`Task "${meta.id}" already has check "${command}"`);
      }
      meta.checks.push({ command, done: false });
      return null;
    }

    case "doneCheck": {
      const index = requireIndex(meta.checks, args.index, "check");
      meta.checks[index]!.done = true;
      return null;
    }

    case "addTaskGraph": {
      const op = requireOp(args.op);
      const message = requireText(args.message, "message");
      const update = (
        op === "add"
          ? { op, message, done: false }
          : {
              op,
              task_id: requireOpenTask(
                tasksDir,
                args.taskId,
                `an ${op} target`,
              ),
              message,
              done: false,
            }
      ) as TaskGraphUpdate;
      meta.task_graph_updates.push(update);
      return state === "REVIEWING" ? "READY_TASK_GRAPH_UPDATE" : null;
    }

    case "doneTaskGraph": {
      const index = requireIndex(
        meta.task_graph_updates,
        args.index,
        "task graph update",
      );
      meta.task_graph_updates[index]!.done = true;
      return openCount(meta.task_graph_updates) === 0 ? "CLOSED" : null;
    }
  }
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
      meta.state = "READY_WORK";
      for (const check of meta.checks) {
        check.done = false;
      }
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
    if (meta.state === "CLOSED") {
      throw new Error(
        `Task "${taskId}" is CLOSED and has no further transitions`,
      );
    }

    const from = meta.state as ValidState;
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(name)) {
      throw new Error(
        `Transition "${name}" is not valid from state "${from}". Valid transitions: ${allowed.join(", ")}`,
      );
    }

    const now = new Date().toISOString();
    const target = mutate(tasksDir, meta, from, name, args, now);

    if (target !== null) {
      meta.state = target;
    }
    meta.state_entered = now;

    if (target !== null && UNCLAIMED_STATES.includes(target)) {
      meta.claimed_by = null;
      meta.claimed_pid = null;
    }

    if (target === "READY_WORK") {
      for (const check of meta.checks) {
        check.done = false;
      }
    }

    if (target === "CLOSED") {
      const closedPath = closeTaskFile(filePath, tasksDir, meta, body);
      const { unblocked, dependentsUpdated } = propagateClose(
        tasksDir,
        taskId,
        now,
      );
      return {
        taskId,
        from,
        to: target,
        closedPath,
        unblocked,
        dependentsUpdated,
      };
    }

    writeTaskFile(filePath, meta, body);
    return { taskId, from, to: target, unblocked: [], dependentsUpdated: [] };
  });
}

const USAGE = `Usage: bun tasks/transition.ts <task-id> <transition> [args...]

Transitions:
  addDependencies     <taskId1> [taskId2 ...]
  removeDependencies  <taskId1> [taskId2 ...]
  noDependencies
  claim               <agentName> <pid>
  release
  submit
  pass
  addTodo             <message>
  doneTodo            <index>
  addCheck            <command>
  doneCheck           <index>
  addTaskGraph        add <message>
  addTaskGraph        update|delete <taskId> <message>
  doneTaskGraph       <index>`;

export function parseArgs(
  name: TransitionName,
  extra: string[],
): TransitionArgs {
  switch (name) {
    case "addDependencies":
    case "removeDependencies": {
      if (extra.length < 1) {
        throw new Error(`"${name}" requires at least one task ID`);
      }
      for (const id of extra) {
        if (!isValidId(id)) {
          throw new Error(
            `Invalid dependency ID "${id}". Must be a six-digit number.`,
          );
        }
      }
      return { taskIds: extra };
    }

    case "noDependencies":
    case "release":
    case "submit":
    case "pass": {
      return {};
    }

    case "claim": {
      if (extra.length < 2) {
        throw new Error('"claim" requires <agentName> <pid>');
      }
      const pid = Number(extra[1]);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Invalid PID "${extra[1]}"`);
      }
      return { agentName: extra[0], pid };
    }

    case "addTodo": {
      const message = extra.join(" ").trim();
      if (message.length === 0) {
        throw new Error('"addTodo" requires a <message>');
      }
      return { message };
    }

    case "addCheck": {
      const command = extra.join(" ").trim();
      if (command.length === 0) {
        throw new Error('"addCheck" requires a <command>');
      }
      return { command };
    }

    case "doneTodo":
    case "doneCheck":
    case "doneTaskGraph": {
      const index = Number(extra[0]);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`"${name}" requires a non-negative integer index`);
      }
      return { index };
    }

    case "addTaskGraph": {
      const op = extra[0] as UpdateOp;
      if (!UPDATE_OPS.includes(op)) {
        throw new Error(
          `"addTaskGraph" requires an op of ${UPDATE_OPS.join(", ")}`,
        );
      }
      if (op === "add") {
        const message = extra.slice(1).join(" ").trim();
        if (message.length === 0) {
          throw new Error('"addTaskGraph add" requires a <message>');
        }
        return { op, message };
      }
      const taskId = extra[1];
      if (!isValidId(taskId)) {
        throw new Error(`"addTaskGraph ${op}" requires a six-digit <taskId>`);
      }
      const message = extra.slice(2).join(" ").trim();
      if (message.length === 0) {
        throw new Error(`"addTaskGraph ${op}" requires a <message>`);
      }
      return { op, taskId, message };
    }
  }
}

function describe(result: TransitionResult, name: TransitionName): string {
  const lines: string[] = [];

  if (result.to === "CLOSED") {
    lines.push(
      `Task "${result.taskId}" transitioned to CLOSED → ${result.closedPath}`,
    );
  } else if (result.to === null) {
    lines.push(
      `Task "${result.taskId}" stayed in ${result.from} (${name} applied)`,
    );
  } else {
    lines.push(`Task "${result.taskId}" ${result.from} → ${result.to}`);
  }

  for (const id of result.dependentsUpdated) {
    const note = result.unblocked.includes(id) ? " → READY_WORK" : "";
    lines.push(`  dependency removed from "${id}"${note}`);
  }

  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.length < 2) {
    console.error(USAGE);
    process.exit(1);
  }

  const taskId = argv[0]!;
  const name = argv[1] as TransitionName;
  const tasksDir = path.dirname(fileURLToPath(import.meta.url));

  try {
    if (!isValidId(taskId)) {
      throw new Error(
        `Invalid task ID "${taskId}". Must be a six-digit number.`,
      );
    }
    if (!TRANSITION_NAMES.includes(name)) {
      throw new Error(`Unknown transition "${name}"`);
    }
    const args = parseArgs(name, argv.slice(2));
    console.log(describe(applyTransition(tasksDir, taskId, name, args), name));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
