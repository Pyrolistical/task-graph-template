import fs from "node:fs";
import path from "node:path";

export type TaskId = string;

export const VALID_STATES = [
  "NEW",
  "BLOCKED",
  "READY_WORK",
  "WORKING",
  "READY_CHECK",
  "CHECKING",
  "READY_REVIEW",
  "REVIEWING",
  "READY_TASK_GRAPH_UPDATE",
  "TASK_GRAPH_UPDATING",
] as const;

export type ValidState = (typeof VALID_STATES)[number];

export const CLOSED_STATE = "CLOSED";

export const ALL_STATES = [...VALID_STATES, CLOSED_STATE] as const;

export type TaskState = (typeof ALL_STATES)[number];

export const CLAIMED_STATES = [
  "WORKING",
  "CHECKING",
  "REVIEWING",
  "TASK_GRAPH_UPDATING",
] as const satisfies readonly ValidState[];

export const UPDATE_OPS = ["add", "update", "delete"] as const;

export type UpdateOp = (typeof UPDATE_OPS)[number];

export const STUCK_THRESHOLDS_HOURS: Partial<Record<ValidState, number>> = {
  WORKING: 12,
  CHECKING: 1,
  REVIEWING: 12,
  TASK_GRAPH_UPDATING: 1,
};

export interface Todo {
  at: string;
  message: string;
  done: boolean;
}

export interface Check {
  command: string;
  done: boolean;
}

export type TaskGraphUpdate =
  | { op: "add"; message: string; done: boolean }
  | { op: "update"; task_id: TaskId; message: string; done: boolean }
  | { op: "delete"; task_id: TaskId; message: string; done: boolean };

export interface TaskMeta {
  id: TaskId;
  title: string;
  state: TaskState;
  state_entered: string | null;
  depends_on: TaskId[];
  claimed_by: string | null;
  claimed_pid: number | null;
  todos: Todo[];
  checks: Check[];
  task_graph_updates: TaskGraphUpdate[];
}

export const TASK_SCHEMA = {
  id: "id",
  title: "string",
  state: "state",
  state_entered: "timestamp-or-null",
  depends_on: "id-list",
  claimed_by: "string-or-null",
  claimed_pid: "int-or-null",
  todos: "todo-list",
  checks: "check-list",
  task_graph_updates: "update-list",
} as const;

export const FIELD_ORDER = Object.keys(TASK_SCHEMA) as (keyof TaskMeta)[];

const ID_FIELDS = new Set(["id", "task_id"]);

const QUOTED_TEXT_FIELDS = new Set(["title", "message", "command"]);

export class TaskSchemaError extends Error {
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    super(
      `Invalid task frontmatter in ${source}:\n  - ${issues.join("\n  - ")}`,
    );
    this.name = "TaskSchemaError";
    this.issues = issues;
  }
}

export function formatId(n: number): string {
  return String(n).padStart(6, "0");
}

export function isValidId(id: unknown): id is TaskId {
  return typeof id === "string" && /^\d{6}$/.test(id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/;

export function splitDocument(content: string): {
  frontmatter: string;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error("Document has no YAML frontmatter block");
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

export function parseDocument(content: string): {
  raw: Record<string, unknown>;
  body: string;
} {
  const { frontmatter, body } = splitDocument(content);
  const parsed: unknown = Bun.YAML.parse(frontmatter);
  if (parsed === null) {
    return { raw: {}, body };
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  return { raw: parsed, body };
}

function validateTodos(value: unknown, issues: string[]): Todo[] {
  if (!Array.isArray(value)) {
    issues.push(`"todos" must be a list`);
    return [];
  }
  const todos: Todo[] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      issues.push(`todos[${i}] must be a mapping`);
      return;
    }
    const extra = Object.keys(item).filter(
      (k) => !["at", "message", "done"].includes(k),
    );
    if (extra.length > 0) {
      issues.push(`todos[${i}] has unknown keys: ${extra.join(", ")}`);
    }
    if (!isTimestamp(item.at)) {
      issues.push(`todos[${i}].at must be a timestamp`);
    }
    if (typeof item.message !== "string" || item.message.length === 0) {
      issues.push(`todos[${i}].message must be a non-empty string`);
    }
    if (typeof item.done !== "boolean") {
      issues.push(`todos[${i}].done must be a boolean`);
    }
    todos.push(item as unknown as Todo);
  });
  return todos;
}

function validateChecks(value: unknown, issues: string[]): Check[] {
  if (!Array.isArray(value)) {
    issues.push(`"checks" must be a list`);
    return [];
  }
  const checks: Check[] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      issues.push(`checks[${i}] must be a mapping`);
      return;
    }
    const extra = Object.keys(item).filter(
      (k) => !["command", "done"].includes(k),
    );
    if (extra.length > 0) {
      issues.push(`checks[${i}] has unknown keys: ${extra.join(", ")}`);
    }
    if (typeof item.command !== "string" || item.command.length === 0) {
      issues.push(`checks[${i}].command must be a non-empty string`);
    }
    if (typeof item.done !== "boolean") {
      issues.push(`checks[${i}].done must be a boolean`);
    }
    checks.push(item as unknown as Check);
  });
  return checks;
}

function validateUpdates(value: unknown, issues: string[]): TaskGraphUpdate[] {
  if (!Array.isArray(value)) {
    issues.push(`"task_graph_updates" must be a list`);
    return [];
  }
  const updates: TaskGraphUpdate[] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      issues.push(`task_graph_updates[${i}] must be a mapping`);
      return;
    }
    const op = item.op;
    if (!UPDATE_OPS.includes(op as UpdateOp)) {
      issues.push(
        `task_graph_updates[${i}].op must be one of ${UPDATE_OPS.join(", ")}`,
      );
      return;
    }
    const allowed =
      op === "add"
        ? ["op", "message", "done"]
        : ["op", "task_id", "message", "done"];
    const extra = Object.keys(item).filter((k) => !allowed.includes(k));
    if (extra.length > 0) {
      issues.push(
        `task_graph_updates[${i}] (op: ${op}) has unknown keys: ${extra.join(", ")}`,
      );
    }
    if (op === "add" && "task_id" in item) {
      issues.push(
        `task_graph_updates[${i}] with op "add" must not have a task_id`,
      );
    }
    if (op !== "add" && !isValidId(item.task_id)) {
      issues.push(
        `task_graph_updates[${i}] with op "${op}" requires a six-digit task_id`,
      );
    }
    if (typeof item.message !== "string" || item.message.length === 0) {
      issues.push(
        `task_graph_updates[${i}].message must be a non-empty string`,
      );
    }
    if (typeof item.done !== "boolean") {
      issues.push(`task_graph_updates[${i}].done must be a boolean`);
    }
    updates.push(item as unknown as TaskGraphUpdate);
  });
  return updates;
}

export function parseTaskMeta(
  raw: Record<string, unknown>,
  source = "document",
): TaskMeta {
  const issues: string[] = [];

  const known = new Set(Object.keys(TASK_SCHEMA));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      issues.push(`unknown field "${key}"`);
    }
  }
  for (const key of known) {
    if (!(key in raw)) {
      issues.push(`missing field "${key}"`);
    }
  }

  if (!isValidId(raw.id)) {
    issues.push(
      `"id" must be a quoted six-digit string, got ${JSON.stringify(raw.id)}`,
    );
  }
  if (typeof raw.title !== "string" || raw.title.length === 0) {
    issues.push(`"title" must be a non-empty string`);
  }
  if (!ALL_STATES.includes(raw.state as TaskState)) {
    issues.push(
      `"state" must be one of ${ALL_STATES.join(", ")}, got ${JSON.stringify(raw.state)}`,
    );
  }
  if (raw.state_entered !== null && !isTimestamp(raw.state_entered)) {
    issues.push(`"state_entered" must be a timestamp or null`);
  }

  let depends_on: TaskId[] = [];
  if (!Array.isArray(raw.depends_on)) {
    issues.push(`"depends_on" must be a list`);
  } else {
    const invalid = raw.depends_on.filter((d) => !isValidId(d));
    if (invalid.length > 0) {
      issues.push(
        `"depends_on" contains invalid IDs: ${invalid.map((d) => JSON.stringify(d)).join(", ")}`,
      );
    }
    depends_on = raw.depends_on as TaskId[];
  }

  if (raw.claimed_by !== null && typeof raw.claimed_by !== "string") {
    issues.push(`"claimed_by" must be a string or null`);
  }
  if (raw.claimed_pid !== null && !Number.isInteger(raw.claimed_pid)) {
    issues.push(`"claimed_pid" must be an integer or null`);
  }
  if ((raw.claimed_by === null) !== (raw.claimed_pid === null)) {
    issues.push(
      `"claimed_by" and "claimed_pid" must both be set or both be null`,
    );
  }

  const todos = validateTodos(raw.todos, issues);
  const checks = validateChecks(raw.checks, issues);
  const task_graph_updates = validateUpdates(raw.task_graph_updates, issues);

  if (issues.length > 0) {
    throw new TaskSchemaError(source, issues);
  }

  return {
    id: raw.id as TaskId,
    title: raw.title as string,
    state: raw.state as TaskState,
    state_entered: raw.state_entered as string | null,
    depends_on,
    claimed_by: raw.claimed_by as string | null,
    claimed_pid: raw.claimed_pid as number | null,
    todos,
    checks,
    task_graph_updates,
  };
}

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value !== value.trim()) return true;
  if (/^(null|~|true|false|yes|no|on|off)$/i.test(value)) return true;
  if (!Number.isNaN(Number(value))) return true;
  return /[:#\-?,[\]{}&*!|>'"%@`\n]/.test(value) || /^\s/.test(value);
}

function scalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  const text = String(value);
  if (ID_FIELDS.has(key) || QUOTED_TEXT_FIELDS.has(key))
    return JSON.stringify(text);
  return needsQuoting(text) ? JSON.stringify(text) : text;
}

function serializeMapItem(
  item: Record<string, unknown>,
  keys: string[],
): string[] {
  const lines: string[] = [];
  keys.forEach((key, i) => {
    if (!(key in item)) return;
    const prefix = i === 0 ? "  - " : "    ";
    lines.push(`${prefix}${key}: ${scalar(key, item[key])}`);
  });
  return lines;
}

export function serializeMeta(meta: TaskMeta): string {
  const lines: string[] = [];

  for (const key of FIELD_ORDER) {
    const value = meta[key];

    if (key === "depends_on") {
      const ids = value as TaskId[];
      if (ids.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const id of ids) {
          lines.push(`  - ${JSON.stringify(id)}`);
        }
      }
      continue;
    }

    if (key === "todos" || key === "checks" || key === "task_graph_updates") {
      const items = value as Record<string, unknown>[];
      if (items.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      const order =
        key === "todos"
          ? ["at", "message", "done"]
          : key === "checks"
            ? ["command", "done"]
            : ["op", "task_id", "message", "done"];
      for (const item of items) {
        lines.push(...serializeMapItem(item, order));
      }
      continue;
    }

    lines.push(`${key}: ${scalar(key, value)}`);
  }

  return lines.join("\n");
}

export function rebuildDocument(meta: TaskMeta, body: string): string {
  return `---\n${serializeMeta(meta)}\n---${body}`;
}

export function findTaskFile(id: string, tasksDir: string): string | null {
  const activePath = path.join(tasksDir, `${id}.md`);
  if (fs.existsSync(activePath)) return activePath;

  const closedPath = path.join(tasksDir, "closed", `${id}.md`);
  if (fs.existsSync(closedPath)) return closedPath;

  return null;
}

export function readTaskFile(filePath: string): {
  meta: TaskMeta;
  body: string;
} {
  const content = fs.readFileSync(filePath, "utf-8");
  const { raw, body } = parseDocument(content);
  return { meta: parseTaskMeta(raw, filePath), body };
}

export function writeTaskFile(
  filePath: string,
  meta: TaskMeta,
  body: string,
): void {
  fs.writeFileSync(filePath, rebuildDocument(meta, body), "utf-8");
}

export function closeTaskFile(
  activePath: string,
  tasksDir: string,
  meta: TaskMeta,
  body: string,
): string {
  const closedDir = path.join(tasksDir, "closed");
  fs.mkdirSync(closedDir, { recursive: true });

  const closedPath = path.join(closedDir, path.basename(activePath));
  writeTaskFile(closedPath, meta, body);
  fs.unlinkSync(activePath);
  return closedPath;
}

const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 10;

export const LOCK_FILENAME = ".tasks.lock";

export function lockPath(tasksDir: string): string {
  return path.join(tasksDir, LOCK_FILENAME);
}

export function readLockPid(tasksDir: string): number | null {
  const pid = Number.parseInt(
    fs.readFileSync(lockPath(tasksDir), "utf-8").trim(),
    10,
  );
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function withLock<T>(tasksDir: string, fn: () => T): T {
  const lockPath = path.join(tasksDir, LOCK_FILENAME);
  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }

  if (fd === null) {
    throw new Error(
      `Could not acquire ${lockPath} after ${(LOCK_RETRIES * LOCK_RETRY_MS) / 1000}s; remove it if stale`,
    );
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

export function detectCycles(tasks: Map<TaskId, TaskMeta>): TaskId[] {
  const visited = new Set<TaskId>();
  const inStack = new Set<TaskId>();
  const cycleNodes = new Set<TaskId>();

  function dfs(id: TaskId): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const task = tasks.get(id);
    let hasCycle = false;
    if (task) {
      for (const dep of task.depends_on) {
        if (tasks.has(dep) && dfs(dep)) {
          cycleNodes.add(id);
          hasCycle = true;
        }
      }
    }

    inStack.delete(id);
    return hasCycle;
  }

  for (const [id] of tasks) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return Array.from(cycleNodes);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
