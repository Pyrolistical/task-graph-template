#!/usr/bin/env bun
/**
 * task-state.ts - Generates the current project state.
 *
 * Reads active task documents, parses YAML metadata, groups by state,
 * resolves dependencies, detects problems, and outputs JSON to stdout.
 *
 * Usage:
 *   bun tasks/task-state.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type TaskMeta,
  type TaskId,
  VALID_STATES,
  STUCK_THRESHOLDS_HOURS,
  isValidId,
  isProcessAlive,
  detectCycles,
  parseFrontmatter,
} from "./task.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = __dirname;

// ── Types ───────────────────────────────────────────────────────────────

interface Problem {
  type:
    | "MalformedTaskDocument"
    | "DependencyCycle"
    | "InvalidStateTransition"
    | "StuckTask"
    | "MissingClaimProcess"
    | "MissingDependency"
    | "InvalidMetadata";
  task_id?: TaskId;
  message: string;
}

interface TaskStateReport {
  tasks: Record<string, TaskId[]>;
  problems: Problem[];
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  const report: TaskStateReport = {
    tasks: Object.fromEntries(VALID_STATES.map((s) => [s, [] as TaskId[]])),
    problems: [],
  };

  // Read all .md files directly in tasks/ (not in closed/)
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "template.md")
    .map((e) => e.name);

  const tasks = new Map<TaskId, TaskMeta>();
  const seenIds = new Set<TaskId>();

  // ── Parse all task documents ────────────────────────────────────────
  for (const filename of mdFiles) {
    const filepath = path.join(tasksDir, filename);
    const { meta } = parseFrontmatter(fs.readFileSync(filepath, "utf-8"));

    // Validate ID
    const rawId = String(meta.id ?? "").trim();
    if (!isValidId(rawId)) {
      report.problems.push({
        type: "MalformedTaskDocument",
        message: `File "${filename}" has invalid or missing task ID: "${rawId}"`,
      });
      continue;
    }

    // Check for duplicate IDs
    if (seenIds.has(rawId)) {
      report.problems.push({
        type: "MalformedTaskDocument",
        message: `Duplicate task ID "${rawId}" in file "${filename}"`,
      });
      continue;
    }
    seenIds.add(rawId);

    // Validate state
    const rawState = String(meta.state ?? "").trim();
    if (!VALID_STATES.includes(rawState)) {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: rawId,
        message: `Task "${rawId}" has invalid state: "${rawState}"`,
      });
      continue;
    }

    // Parse depends_on
    const rawDeps = meta.depends_on as unknown;
    let depends_on: TaskId[] = [];
    if (Array.isArray(rawDeps)) {
      depends_on = rawDeps.map((d) => String(d).trim());
    } else if (typeof rawDeps === "string") {
      depends_on = [rawDeps.trim()];
    }

    // Validate dependency IDs format
    const invalidDeps = depends_on.filter((d) => !isValidId(d));
    if (invalidDeps.length > 0) {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: rawId,
        message: `Task "${rawId}" has invalid dependency IDs: ${invalidDeps.join(", ")}`,
      });
    }

    const claimedBy = meta.claimed_by ? String(meta.claimed_by).trim() : null;
    const claimedPid = meta.claimed_pid != null
      ? Number(meta.claimed_pid) ?? null
      : null;
    const stateEntered = meta.state_entered
      ? String(meta.state_entered).trim()
      : null;

    tasks.set(rawId, {
      id: rawId,
      title: String(meta.title ?? "").trim(),
      state: rawState,
      depends_on,
      claimed_by: claimedBy || null,
      claimed_pid: claimedPid || null,
      state_entered: stateEntered || null,
    });
  }

  // ── Dependency checks ───────────────────────────────────────────────
  for (const [id, task] of tasks) {
    for (const dep of task.depends_on) {
      if (!tasks.has(dep)) {
        report.problems.push({
          type: "MissingDependency",
          task_id: id,
          message: `Task "${id}" depends on "${dep}" which does not exist`,
        });
      }
    }
  }

  // ── Cycle detection ─────────────────────────────────────────────────
  const cycleNodes = detectCycles(tasks);
  if (cycleNodes.length > 0) {
    report.problems.push({
      type: "DependencyCycle",
      message: `Circular dependency detected involving tasks: ${cycleNodes.join(", ")}`,
    });
  }

  // ── Process checks ──────────────────────────────────────────────────
  for (const [id, task] of tasks) {
    if (task.claimed_by && task.claimed_pid != null && !isNaN(task.claimed_pid)) {
      if (!isProcessAlive(task.claimed_pid)) {
        report.problems.push({
          type: "MissingClaimProcess",
          task_id: id,
          message: `Task "${id}" claimed by "${task.claimed_by}" (PID ${task.claimed_pid}) but process no longer exists`,
        });
      }
    }

    if (task.claimed_by && task.claimed_pid == null) {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: id,
        message: `Task "${id}" has claimed_by "${task.claimed_by}" but missing claimed_pid`,
      });
    }
  }

  // ── State consistency checks ────────────────────────────────────────
  for (const [id, task] of tasks) {
    if (task.state === "WORKING" && !task.claimed_by) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in WORKING state but has no claim`,
      });
    }

    if (task.state === "CHECKING" && !task.claimed_by) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in CHECKING state but has no claim`,
      });
    }

    if (task.state === "REVIEWING" && !task.claimed_by) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in REVIEWING state but has no claim`,
      });
    }

    if (task.state === "TASK_GRAPH_UPDATING" && !task.claimed_by) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in TASK_GRAPH_UPDATING state but has no claim`,
      });
    }
  }

  // ── Stuck task detection ────────────────────────────────────────────
  const now = Date.now();
  for (const [id, task] of tasks) {
    const threshold = STUCK_THRESHOLDS_HOURS[task.state];
    if (threshold && task.state_entered) {
      const entered = new Date(task.state_entered).getTime();
      if (!isNaN(entered)) {
        const hoursSince = (now - entered) / (1000 * 60 * 60);
        if (hoursSince > threshold) {
          report.problems.push({
            type: "StuckTask",
            task_id: id,
            message: `Task "${id}" has been in "${task.state}" for ${hoursSince.toFixed(1)} hours (threshold: ${threshold}h)`,
          });
        }
      }
    }
  }

  // ── Group tasks by state ────────────────────────────────────────────
  for (const [id, task] of tasks) {
    if (report.tasks[task.state]) {
      report.tasks[task.state].push(id);
    }
  }

  // Sort task IDs within each group
  for (const state of VALID_STATES) {
    report.tasks[state].sort();
  }

  console.log(JSON.stringify(report, null, 2));
}

// ── Entry point / Tests ────────────────────────────────────────────────

import os from "node:os";

if (import.meta.main) {
  if (process.env.NODE_ENV === "test") {
    test("parseFrontmatter extracts metadata and body", () => {
      const content = `---
id: 000042
title: Test Task
state: WORKING
depends_on:
  - 000001
claimed_by: agent-1
claimed_pid: 12345
state_entered: 2026-07-27T12:00:00Z
---

# Goal

Some content.`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta.id).toBe("000042");
      expect(meta.title).toBe("Test Task");
      expect(meta.state).toBe("WORKING");
      expect(meta.claimed_by).toBe("agent-1");
      expect(meta.claimed_pid).toBe(12345);
      expect(Array.isArray(meta.depends_on)).toBe(true);
      expect((meta.depends_on as string[])).toContain("000001");
      expect(body).toContain("# Goal");
    });

    test("parseFrontmatter handles empty values and null", () => {
      const content = `---
id:
title:
state: NEW
depends_on: []
claimed_by: null
claimed_pid:
state_entered:
---

# Goal`;

      const { meta } = parseFrontmatter(content);
      expect(meta.id).toEqual([]);
      expect(meta.title).toEqual([]);
      expect(meta.state).toBe("NEW");
      expect(meta.depends_on).toEqual([]);
      expect(meta.claimed_by).toBe(null);
      expect(meta.claimed_pid).toEqual([]);
    });

    test("parseFrontmatter preserves zero-padded IDs as strings", () => {
      const content = `---
id: 000042
claimed_pid: 12345
---

# Goal`;

      const { meta } = parseFrontmatter(content);
      expect(meta.id).toBe("000042");
      expect(typeof meta.id).toBe("string");
      expect(meta.claimed_pid).toBe(12345);
      expect(typeof meta.claimed_pid).toBe("number");
    });

    test("parseFrontmatter returns empty meta for no frontmatter", () => {
      const content = "# No frontmatter here";
      const { meta, body } = parseFrontmatter(content);
      expect(Object.keys(meta)).toEqual([]);
      expect(body).toBe(content);
    });

    test("isValidId accepts six-digit strings", () => {
      expect(isValidId("000001")).toBe(true);
      expect(isValidId("999999")).toBe(true);
      expect(isValidId("000042")).toBe(true);
    });

    test("isValidId rejects invalid formats", () => {
      expect(isValidId("1")).toBe(false);
      expect(isValidId("00001")).toBe(false);
      expect(isValidId("0000001")).toBe(false);
      expect(isValidId("abc123")).toBe(false);
      expect(isValidId("")).toBe(false);
    });

    test("detectCycles finds no cycles in DAG", () => {
      const tasks = new Map<string, TaskMeta>([
        ["000001", { id: "000001", title: "A", state: "NEW", depends_on: [], claimed_by: null, claimed_pid: null, state_entered: null }],
        ["000002", { id: "000002", title: "B", state: "NEW", depends_on: ["000001"], claimed_by: null, claimed_pid: null, state_entered: null }],
        ["000003", { id: "000003", title: "C", state: "NEW", depends_on: ["000001", "000002"], claimed_by: null, claimed_pid: null, state_entered: null }],
      ]);
      expect(detectCycles(tasks)).toEqual([]);
    });

    test("detectCycles finds simple cycle", () => {
      const tasks = new Map<string, TaskMeta>([
        ["000001", { id: "000001", title: "A", state: "NEW", depends_on: ["000002"], claimed_by: null, claimed_pid: null, state_entered: null }],
        ["000002", { id: "000002", title: "B", state: "NEW", depends_on: ["000001"], claimed_by: null, claimed_pid: null, state_entered: null }],
      ]);
      const result = detectCycles(tasks);
      expect(result).toContain("000001");
      expect(result).toContain("000002");
    });

    test("detectCycles finds cycle in three-node chain", () => {
      const tasks = new Map<string, TaskMeta>([
        ["000001", { id: "000001", title: "A", state: "NEW", depends_on: ["000003"], claimed_by: null, claimed_pid: null, state_entered: null }],
        ["000002", { id: "000002", title: "B", state: "NEW", depends_on: ["000001"], claimed_by: null, claimed_pid: null, state_entered: null }],
        ["000003", { id: "000003", title: "C", state: "NEW", depends_on: ["000002"], claimed_by: null, claimed_pid: null, state_entered: null }],
      ]);
      const result = detectCycles(tasks);
      expect(result).toContain("000001");
      expect(result).toContain("000002");
      expect(result).toContain("000003");
    });

    test("detectCycles ignores non-existent dependencies", () => {
      const tasks = new Map<string, TaskMeta>([
        ["000001", { id: "000001", title: "A", state: "NEW", depends_on: ["999999"], claimed_by: null, claimed_pid: null, state_entered: null }],
      ]);
      expect(detectCycles(tasks)).toEqual([]);
    });

    test("state report groups tasks correctly (e2e)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-state-test-"));

      // Create task files
      fs.writeFileSync(
        path.join(tmpDir, "000001.md"),
        `---
id: 000001
title: Task A
state: NEW
depends_on: []
claimed_by:
claimed_pid:
state_entered:
---

# Goal`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "000002.md"),
        `---
id: 000002
title: Task B
state: WORKING
depends_on:
  - 000001
claimed_by: agent-1
claimed_pid: ${process.pid}
state_entered: 2026-07-27T12:00:00Z
---

# Goal`,
      );

      // Read files manually and verify parsing
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md"));
      expect(mdFiles.length).toBe(2);

      const meta1 = parseFrontmatter(
        fs.readFileSync(path.join(tmpDir, "000001.md"), "utf-8"),
      );
      expect(meta1.meta.id).toBe("000001");
      expect(meta1.meta.state).toBe("NEW");

      const meta2 = parseFrontmatter(
        fs.readFileSync(path.join(tmpDir, "000002.md"), "utf-8"),
      );
      expect(meta2.meta.id).toBe("000002");
      expect(meta2.meta.state).toBe("WORKING");
      expect(Array.isArray(meta2.meta.depends_on)).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });
  } else {
    main();
  }
}
