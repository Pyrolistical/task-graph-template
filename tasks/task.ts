#!/usr/bin/env bun
/**
 * task.ts - Shared types and utilities for task document parsing and writing.
 *
 * Re-exported by new-task.ts, transition.js, and task-state.ts.
 */

import fs from "node:fs";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export type TaskId = string;

export interface TaskMeta {
  id: TaskId;
  title: string;
  state: string;
  depends_on: TaskId[];
  claimed_by: string | null;
  claimed_pid: number | null;
  state_entered: string | null;
}

// ── Constants ───────────────────────────────────────────────────────────

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

export const STUCK_THRESHOLDS_HOURS: Record<string, number> = {
  WORKING: 12,
  CHECKING: 1,
  REVIEWING: 12,
  TASK_GRAPH_UPDATING: 1,
};

// ── ID helpers ──────────────────────────────────────────────────────────

/** Format a number as a zero-padded six-digit task ID. */
export function formatId(n: number): string {
  return String(n).padStart(6, "0");
}

/** Check whether a string is a valid six-digit task ID. */
export function isValidId(id: string): boolean {
  return /^\d{6}$/.test(id);
}

// ── Frontmatter parser ─────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a Markdown document.
 *
 * Handles:
 *   - Simple key: value pairs
 *   - Multi-line lists (indented "- item")
 *   - Empty values → []
 *   - "null" / "~" → null
 *   - Numeric values (except zero-padded strings like task IDs)
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const [, frontmatter, body] = match;
  const meta: Record<string, unknown> = {};

  const lines = frontmatter.split("\n");
  let currentKey: string | null = null;
  const listItems: string[] = [];

  function flushList() {
    if (currentKey !== null && listItems.length > 0) {
      meta[currentKey] = listItems.map((item) => item.trim());
    }
  }

  for (const line of lines) {
    // List item
    if (line.match(/^\s*-\s+/)) {
      listItems.push(line.replace(/^\s*-\s+/, ""));
      continue;
    }

    flushList();
    currentKey = null;
    listItems.length = 0;

    // Key: value
    const kvMatch = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      const trimmed = value.trim();

      if (trimmed === "" || trimmed === "[]") {
        meta[key] = [];
      } else if (trimmed === "null" || trimmed === "~") {
        meta[key] = null;
      } else if (!isNaN(Number(trimmed)) && !/^0+\d/.test(trimmed)) {
        // Keep zero-padded strings as-is (e.g. task IDs like "000042")
        meta[key] = Number(trimmed);
      } else {
        meta[key] = trimmed;
      }
      currentKey = key;
    }
  }

  flushList();
  return { meta, body };
}

// ── Frontmatter serializer ─────────────────────────────────────────────

/**
 * Serialize a metadata object back to YAML frontmatter text.
 *
 * Handles:
 *   - Arrays → block list (or [] if empty)
 *   - null / undefined → empty value
 *   - Scalars → "key: value"
 */
export function serializeMeta(meta: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * Rebuild a full Markdown document from parsed frontmatter and body.
 */
export function rebuildDocument(
  meta: Record<string, unknown>,
  body: string,
): string {
  return `---\n${serializeMeta(meta)}\n---\n${body}`;
}

// ── File I/O ────────────────────────────────────────────────────────────

/**
 * Find the file path for a task by ID. Checks active dir first, then closed/.
 */
export function findTaskFile(id: string, tasksDir: string): string | null {
  const activePath = path.join(tasksDir, `${id}.md`);
  if (fs.existsSync(activePath)) return activePath;

  const closedPath = path.join(tasksDir, "closed", `${id}.md`);
  if (fs.existsSync(closedPath)) return closedPath;

  return null;
}

/** Read a task file and return parsed frontmatter + body. */
export function readTaskFile(filePath: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseFrontmatter(content);
}

/** Write a task file from metadata and body. */
export function writeTaskFile(
  filePath: string,
  meta: Record<string, unknown>,
  body: string,
): void {
  const content = rebuildDocument(meta, body);
  fs.writeFileSync(filePath, content, "utf-8");
}

/** Move a task file to the closed directory. */
export function closeTaskFile(
  activePath: string,
  tasksDir: string,
  meta: Record<string, unknown>,
  body: string,
): string {
  const closedDir = path.join(tasksDir, "closed");
  if (!fs.existsSync(closedDir)) {
    fs.mkdirSync(closedDir, { recursive: true });
  }

  const closedPath = path.join(closedDir, path.basename(activePath));
  writeTaskFile(closedPath, meta, body);
  fs.unlinkSync(activePath);
  return closedPath;
}

// ── Cycle detection ─────────────────────────────────────────────────────

/**
 * Detect circular dependencies among tasks using DFS.
 * Returns an array of task IDs that participate in cycles.
 */
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

// ── Process helpers ─────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
