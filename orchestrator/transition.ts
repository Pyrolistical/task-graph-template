import fs from "node:fs";
import path from "node:path";
import {
  type Failure,
  FAILURE_TYPES,
  type FailureType,
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
  openCount,
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
  "fail",
  "hold",
  "resume",
  "addTodo",
  "doneTodo",
  "addCheck",
  "addTaskGraph",
  "doneTaskGraph",
  "merged",
  "abort",
] as const;

export type TransitionName = (typeof TRANSITION_NAMES)[number];

export const ALLOWED_TRANSITIONS: Record<ValidState, TransitionName[]> = {
  NEW: ["addDependencies", "noDependencies", "addTodo", "addCheck"],
  BLOCKED: ["addDependencies", "removeDependencies"],
  HELD: ["resume", "addTodo", "addCheck", "addDependencies", "addTaskGraph"],
  READY_WORK: [
    "addDependencies",
    "addTodo",
    "addCheck",
    "addTaskGraph",
    "abort",
    "claim",
  ],
  WORKING: ["addTodo", "doneTodo", "addCheck", "submit", "hold", "release"],
  READY_CHECK: ["claim"],
  CHECKING: ["addCheck", "pass", "fail", "release"],
  READY_AGENT_REVIEW: ["claim"],
  AGENT_REVIEWING: ["addTodo", "submit", "hold", "release"],
  READY_MANAGER_REVIEW: ["claim"],
  MANAGER_REVIEWING: [
    "addTodo",
    "addCheck",
    "addTaskGraph",
    "merged",
    "abort",
    "release",
  ],
  READY_TASK_GRAPH_UPDATE: ["addTaskGraph", "claim"],
  TASK_GRAPH_UPDATING: ["addTaskGraph", "doneTaskGraph", "release"],
};

const CLAIM_TARGETS: Partial<Record<ValidState, ValidState>> = {
  READY_WORK: "WORKING",
  READY_CHECK: "CHECKING",
  READY_AGENT_REVIEW: "AGENT_REVIEWING",
  READY_MANAGER_REVIEW: "MANAGER_REVIEWING",
  READY_TASK_GRAPH_UPDATE: "TASK_GRAPH_UPDATING",
};

const RELEASE_TARGETS: Partial<Record<ValidState, ValidState>> = {
  WORKING: "READY_WORK",
  CHECKING: "READY_CHECK",
  AGENT_REVIEWING: "READY_AGENT_REVIEW",
  MANAGER_REVIEWING: "READY_MANAGER_REVIEW",
  TASK_GRAPH_UPDATING: "READY_TASK_GRAPH_UPDATE",
};

const SUBMIT_TARGETS: Partial<Record<ValidState, ValidState>> = {
  WORKING: "READY_CHECK",
  AGENT_REVIEWING: "READY_MANAGER_REVIEW",
};

const PASS_TARGETS: Partial<Record<ValidState, TaskState>> = {
  CHECKING: "READY_AGENT_REVIEW",
};

const FAIL_TARGETS: Partial<Record<ValidState, ValidState>> = {
  CHECKING: "READY_WORK",
};

const TODO_SENDS_BACK_FROM: ValidState[] = [
  "AGENT_REVIEWING",
  "MANAGER_REVIEWING",
  "HELD",
];

const UNCLAIMED_STATES: TaskState[] = [
  "NEW",
  "BLOCKED",
  "HELD",
  "READY_WORK",
  "READY_CHECK",
  "READY_AGENT_REVIEW",
  "READY_MANAGER_REVIEW",
  "READY_TASK_GRAPH_UPDATE",
  "CLOSED",
];

export interface TransitionArgs {
  taskIds?: TaskId[];
  agentName?: string;
  pid?: number;
  branch?: string;
  worktree?: string;
  session?: string;
  reason?: string;
  message?: string;
  command?: string;
  index?: number;
  op?: UpdateOp;
  taskId?: TaskId;
  failures?: Failure[];
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

function requireFailures(value: unknown): Failure[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"failures" must be a non-empty list`);
  }
  for (const failure of value as Record<string, unknown>[]) {
    if (!FAILURE_TYPES.includes(failure.type as FailureType)) {
      throw new Error(
        `"failures" entries must have a type of ${FAILURE_TYPES.join(", ")}`,
      );
    }
    if (failure.type === "check") {
      requireText(failure.command, "command");
      if (!Number.isInteger(failure.exit_code)) {
        throw new Error(`"exit_code" must be an integer`);
      }
      if (typeof failure.output !== "string") {
        throw new Error(`"output" must be a string`);
      }
    } else {
      requireText(failure.message, "message");
    }
  }
  return value as Failure[];
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
      if (args.branch !== undefined || args.worktree !== undefined) {
        meta.workspace = {
          branch: requireText(args.branch, "branch"),
          worktree: requireText(args.worktree, "worktree"),
          agent: meta.claimed_by,
          session: args.session === undefined ? null : args.session,
        };
      }
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
      meta.failures = [];
      return SUBMIT_TARGETS[state]!;
    }

    case "pass": {
      const open = openCount(meta.todos);
      if (open > 0) {
        throw new Error(
          `Task "${meta.id}" has ${open} open todo(s); cannot pass`,
        );
      }
      return PASS_TARGETS[state]!;
    }

    case "fail": {
      meta.failures = requireFailures(args.failures);
      return FAIL_TARGETS[state]!;
    }

    case "hold": {
      meta.held_reason = requireText(args.reason, "reason");
      meta.failures = [];
      return "HELD";
    }

    case "resume": {
      return "READY_WORK";
    }

    case "addTodo": {
      meta.todos.push({
        at: now,
        message: requireText(args.message, "message"),
        done: false,
      });
      return TODO_SENDS_BACK_FROM.includes(state) ? "READY_WORK" : null;
    }

    case "doneTodo": {
      const index = requireIndex(meta.todos, args.index, "todo");
      meta.todos[index]!.done = true;
      return null;
    }

    case "addCheck": {
      const command = requireText(args.command, "command");
      if (meta.checks.includes(command)) {
        throw new Error(`Task "${meta.id}" already has check "${command}"`);
      }
      meta.checks.push(command);
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
      return state === "HELD" ? "READY_TASK_GRAPH_UPDATE" : null;
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

    case "merged": {
      const open = openCount(meta.todos);
      if (open > 0) {
        throw new Error(
          `Task "${meta.id}" has ${open} open todo(s); cannot be merged`,
        );
      }
      return meta.task_graph_updates.length === 0
        ? "CLOSED"
        : "READY_TASK_GRAPH_UPDATE";
    }

    case "abort": {
      if (meta.task_graph_updates.length === 0) {
        throw new Error(
          `Task "${meta.id}" has no task graph updates; an abort must say what the graph should become`,
        );
      }
      return "READY_TASK_GRAPH_UPDATE";
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

    if (target !== null && target !== "HELD") {
      meta.held_reason = null;
    }

    if (target === "CLOSED") {
      meta.workspace = null;
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
