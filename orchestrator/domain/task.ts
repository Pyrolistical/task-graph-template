import { z } from "zod";
import { Cost } from "./costs.ts";
import { keysOf } from "./lookup.ts";
import { maybe, parse } from "./schema.ts";
import { ALL_STATES } from "./state-machine.ts";

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
  slot: nonEmpty,
  session: maybe(nonEmpty),
});

export type Workspace = z.infer<typeof Workspace>;

export const WORKSPACE_FIELDS = keysOf(Workspace.shape);

const TaskFields = z.strictObject({
  id: taskId,
  title: nonEmpty,
  state: z.enum(ALL_STATES, {
    error: (issue) =>
      `must be one of ${ALL_STATES.join(", ")}, got ${JSON.stringify(issue.input)}`,
  }),
  state_entered: maybe(timestamp),
  depends_on: z.array(taskId),
  claimed_by: maybe(nonEmpty),
  claimed_pid: maybe(z.int()),
  held_reason: maybe(nonEmpty),
  workspace: maybe(Workspace),
  checks: z.array(nonEmpty),
  costs: z.array(Cost).default(() => []),
});

const Meta = TaskFields.refine(
  (meta) => !meta.claimed_by === !meta.claimed_pid,
  { error: `"claimed_by" and "claimed_pid" must both be set or both be null` },
);

export type TaskMeta = z.infer<typeof Meta>;

export const FIELD_ORDER = keysOf(TaskFields.shape);

export function requireWorkspace(task: TaskMeta): Workspace {
  if (!task.workspace) {
    throw new Error(`task "${task.id}" has no workspace`);
  }
  return task.workspace;
}

export function requireSession(task: TaskMeta, workspace: Workspace): string {
  if (!workspace.session) {
    throw new Error(`task "${task.id}" has no session to resume`);
  }
  return workspace.session;
}

const ID_FIELDS = new Set(["id"]);

const QUOTED_TEXT_FIELDS = new Set([
  "title",
  "held_reason",
  "branch",
  "worktree",
  "slot",
  "session",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  if (!parsed) {
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
  if (!value) return `null`;
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
      const items = meta[key];
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

    if (key === "costs") {
      const costs = meta[key];
      if (costs.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const entry of costs) {
        lines.push(`  - state: ${entry.state}`);
        lines.push(`    slot: ${scalar("slot", entry.slot)}`);
        lines.push(`    seconds: ${entry.seconds}`);
        lines.push(`    cost: ${entry.cost}`);
      }
      continue;
    }

    if (key === "workspace") {
      const workspace = meta[key];
      if (!workspace) {
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

export function normalizeBody(body: string): string {
  return `\n\n${body.replace(/^\s+/, "").replace(/\s+$/, "")}\n`;
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
