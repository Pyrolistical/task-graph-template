import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse } from "./schema.ts";
import { ALL_STATES } from "./states.ts";

export type TaskId = string;

export function formatId(n: number): string {
  return String(n).padStart(6, "0");
}

export function isValidId(id: unknown): id is TaskId {
  return typeof id === "string" && /^\d{6}$/.test(id);
}

const nonEmpty = z.string().min(1);

const taskId = z.custom<TaskId>(isValidId, {
  error: (issue) =>
    `must be a quoted six-digit string, got ${JSON.stringify(issue.input)}`,
});

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    error: "must be a timestamp",
  });

const Workspace = z.strictObject({
  branch: nonEmpty,
  worktree: nonEmpty,
  agent: nonEmpty,
  session: nonEmpty.nullable(),
});

export type Workspace = z.infer<typeof Workspace>;

export const WORKSPACE_FIELDS = Object.keys(
  Workspace.shape,
) as (keyof Workspace)[];

const TaskFields = z.strictObject({
  id: taskId,
  title: nonEmpty,
  state: z.enum(ALL_STATES, {
    error: (issue) =>
      `must be one of ${ALL_STATES.join(", ")}, got ${JSON.stringify(issue.input)}`,
  }),
  state_entered: timestamp.nullable(),
  depends_on: z.array(taskId),
  claimed_by: nonEmpty.nullable(),
  claimed_pid: z.int().nullable(),
  held_reason: nonEmpty.nullable(),
  workspace: Workspace.nullable(),
  checks: z.array(nonEmpty),
});

const Meta = TaskFields.refine(
  (meta) => (meta.claimed_by === null) === (meta.claimed_pid === null),
  { error: `"claimed_by" and "claimed_pid" must both be set or both be null` },
);

export type TaskMeta = z.infer<typeof Meta>;

export const FIELD_ORDER = Object.keys(TaskFields.shape) as (keyof TaskMeta)[];

const ID_FIELDS = new Set(["id"]);

const QUOTED_TEXT_FIELDS = new Set([
  "title",
  "held_reason",
  "branch",
  "worktree",
  "agent",
  "session",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseTaskMeta(
  raw: Record<string, unknown>,
  source = "document",
): TaskMeta {
  return parse(Meta, raw, "task frontmatter", source);
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

export function serializeMeta(meta: TaskMeta): string {
  const lines: string[] = [];

  for (const key of FIELD_ORDER) {
    const value = meta[key];

    if (key === "depends_on" || key === "checks") {
      const items = value as string[];
      if (items.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of items) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
      continue;
    }

    if (key === "workspace") {
      const workspace = value as Workspace | null;
      if (workspace === null) {
        lines.push(`${key}: null`);
        continue;
      }
      lines.push(`${key}:`);
      for (const field of WORKSPACE_FIELDS) {
        lines.push(`  ${field}: ${scalar(field, workspace[field])}`);
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

export function normalizeBody(body: string): string {
  return `\n\n${body.replace(/^\s+/, "").replace(/\s+$/, "")}\n`;
}

export function writeTaskBody(
  tasksDir: string,
  id: TaskId,
  body: string,
): string {
  if (body.trim().length === 0) {
    throw new Error("A task body is required");
  }

  return withLock(tasksDir, () => {
    const filePath = findTaskFile(id, tasksDir);
    if (filePath === null) {
      throw new Error(`Task "${id}" not found`);
    }
    const { meta } = readTaskFile(filePath);
    writeTaskFile(filePath, meta, normalizeBody(body));
    return filePath;
  });
}

export interface CreatedTask {
  id: TaskId;
  filePath: string;
}

export function templatePath(
  tasksDir: string,
  orchestratorDir: string,
): string {
  const override = path.join(tasksDir, "template.md");
  return fs.existsSync(override)
    ? override
    : path.join(orchestratorDir, "template.md");
}

export function createTask(
  tasksDir: string,
  orchestratorDir: string,
  title: string,
): CreatedTask {
  if (title.trim().length === 0) {
    throw new Error("A task title is required");
  }

  return withLock(tasksDir, () => {
    const nextTaskIdPath = path.join(tasksDir, "next-task-id");
    const rawNext = fs.readFileSync(nextTaskIdPath, "utf-8").trim();
    const nextId = Number.parseInt(rawNext, 10);

    if (!Number.isInteger(nextId) || nextId < 1) {
      throw new Error(`Invalid value in next-task-id: "${rawNext}"`);
    }

    const id = formatId(nextId);
    const template = templatePath(tasksDir, orchestratorDir);
    const { raw, body } = parseDocument(fs.readFileSync(template, "utf-8"));

    raw.id = id;
    raw.title = title.trim();
    raw.state_entered = new Date().toISOString();

    const meta = parseTaskMeta(raw, template);
    const filePath = path.join(tasksDir, `${id}.md`);

    fs.writeFileSync(filePath, rebuildDocument(meta, body), {
      encoding: "utf-8",
      flag: "wx",
    });
    fs.writeFileSync(nextTaskIdPath, `${nextId + 1}\n`, "utf-8");

    return { id, filePath };
  });
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

export function withLock<T>(tasksDir: string, fn: () => T): T {
  const lock = lockPath(tasksDir);
  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      Bun.sleepSync(LOCK_RETRY_MS);
    }
  }

  if (fd === null) {
    throw new Error(
      `Could not acquire ${lock} after ${(LOCK_RETRIES * LOCK_RETRY_MS) / 1000}s; remove it if stale`,
    );
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
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

function isZombie(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return false;
  }
  return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}
