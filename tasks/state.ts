#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type TaskId,
  type TaskMeta,
  type ValidState,
  CLAIMED_STATES,
  LOCK_FILENAME,
  STUCK_THRESHOLDS_HOURS,
  TaskSchemaError,
  VALID_STATES,
  detectCycles,
  isProcessAlive,
  lockPath,
  parseDocument,
  parseTaskMeta,
  readLockPid,
} from "./task.ts";

export type ProblemType =
  | "MalformedTaskDocument"
  | "DependencyCycle"
  | "InvalidStateTransition"
  | "StuckTask"
  | "MissingClaimProcess"
  | "MissingDependency"
  | "InvalidMetadata"
  | "ToolingBlocked";

const STALE_LOCK_SECONDS = 60;

const TODOS_MUST_BE_CLOSED_IN: ValidState[] = [
  "READY_CHECK",
  "CHECKING",
  "READY_REVIEW",
  "REVIEWING",
];

const CHECKS_MUST_BE_DONE_IN: ValidState[] = ["READY_REVIEW", "REVIEWING"];

const GRAPH_UPDATE_STATES: ValidState[] = [
  "READY_TASK_GRAPH_UPDATE",
  "TASK_GRAPH_UPDATING",
];

export interface Problem {
  type: ProblemType;
  task_id?: TaskId;
  message: string;
}

export interface TaskSummary {
  open_todos: number;
  open_checks: number;
  open_task_graph_updates: number;
}

export interface TaskStateReport {
  tasks: Record<ValidState, TaskId[]>;
  open: Record<TaskId, TaskSummary>;
  problems: Problem[];
}

function emptyGroups(): Record<ValidState, TaskId[]> {
  const groups = {} as Record<ValidState, TaskId[]>;
  for (const state of VALID_STATES) {
    groups[state] = [];
  }
  return groups;
}

function openCount(list: { done: boolean }[]): number {
  return list.filter((item) => !item.done).length;
}

function checkLock(tasksDir: string, problems: Problem[]): void {
  const lock = lockPath(tasksDir);
  let stat: fs.Stats;

  try {
    stat = fs.statSync(lock);
  } catch {
    return;
  }

  const pid = readLockPid(tasksDir);

  if (pid !== null && !isProcessAlive(pid)) {
    problems.push({
      type: "ToolingBlocked",
      message: `${LOCK_FILENAME} is held by PID ${pid}, which no longer exists; every transition and create will fail until it is removed`,
    });
    return;
  }

  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  if (pid === null && ageSeconds > STALE_LOCK_SECONDS) {
    problems.push({
      type: "ToolingBlocked",
      message: `${LOCK_FILENAME} has been held for ${ageSeconds.toFixed(0)}s with no owning PID recorded; every transition and create will fail until it is removed`,
    });
  }
}

function checkNextTaskId(
  tasksDir: string,
  ids: TaskId[],
  problems: Problem[],
): void {
  const idPath = path.join(tasksDir, "next-task-id");
  let contents: string;

  try {
    contents = fs.readFileSync(idPath, "utf-8").trim();
  } catch {
    problems.push({
      type: "ToolingBlocked",
      message: `next-task-id is missing; no new task can be created`,
    });
    return;
  }

  const next = Number.parseInt(contents, 10);
  if (!Number.isInteger(next) || next < 1) {
    problems.push({
      type: "ToolingBlocked",
      message: `next-task-id contains "${contents}", which is not a positive integer; no new task can be created`,
    });
    return;
  }

  const highest = ids.reduce(
    (max, id) => Math.max(max, Number.parseInt(id, 10)),
    0,
  );
  if (next <= highest) {
    problems.push({
      type: "ToolingBlocked",
      message: `next-task-id is ${next} but task ${String(highest).padStart(6, "0")} already exists; every create will fail until it is raised above ${highest}`,
    });
  }
}

function checkQueues(
  task: TaskMeta,
  state: ValidState,
  problems: Problem[],
): void {
  const id = task.id;
  const openTodos = openCount(task.todos);
  const openChecks = openCount(task.checks);
  const openUpdates = openCount(task.task_graph_updates);

  if (TODOS_MUST_BE_CLOSED_IN.includes(state) && openTodos > 0) {
    problems.push({
      type: "InvalidMetadata",
      task_id: id,
      message: `Task "${id}" is in ${state} with ${openTodos} open todo(s); submit should have blocked this`,
    });
  }

  if (CHECKS_MUST_BE_DONE_IN.includes(state) && openChecks > 0) {
    problems.push({
      type: "InvalidMetadata",
      task_id: id,
      message: `Task "${id}" is in ${state} with ${openChecks} check(s) not yet run; pass should have blocked this`,
    });
  }

  if (!GRAPH_UPDATE_STATES.includes(state) && openUpdates > 0) {
    problems.push({
      type: "InvalidMetadata",
      task_id: id,
      message: `Task "${id}" is in ${state} with ${openUpdates} open task graph update(s), which only the task graph update states can resolve`,
    });
  }

  if (
    GRAPH_UPDATE_STATES.includes(state) &&
    task.task_graph_updates.length === 0
  ) {
    problems.push({
      type: "InvalidMetadata",
      task_id: id,
      message: `Task "${id}" is in ${state} with no task graph updates queued`,
    });
  }
}

function checkStateEntered(
  task: TaskMeta,
  state: ValidState,
  problems: Problem[],
): void {
  if (task.state_entered === null) {
    if (STUCK_THRESHOLDS_HOURS[state] !== undefined) {
      problems.push({
        type: "InvalidMetadata",
        task_id: task.id,
        message: `Task "${task.id}" is in ${state} with no state_entered, so it can never be reported as stuck`,
      });
    }
    return;
  }

  if (Date.parse(task.state_entered) > Date.now()) {
    problems.push({
      type: "InvalidMetadata",
      task_id: task.id,
      message: `Task "${task.id}" has state_entered in the future (${task.state_entered}), which disables stuck detection`,
    });
  }
}

export function buildReport(tasksDir: string): TaskStateReport {
  const report: TaskStateReport = {
    tasks: emptyGroups(),
    open: {},
    problems: [],
  };

  const filenames = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && e.name.endsWith(".md") && e.name !== "template.md",
    )
    .map((e) => e.name)
    .sort();

  const tasks = new Map<TaskId, TaskMeta>();

  for (const filename of filenames) {
    const filePath = path.join(tasksDir, filename);
    let meta: TaskMeta;

    try {
      const { raw } = parseDocument(fs.readFileSync(filePath, "utf-8"));
      meta = parseTaskMeta(raw, filename);
    } catch (err) {
      report.problems.push({
        type:
          err instanceof TaskSchemaError
            ? "InvalidMetadata"
            : "MalformedTaskDocument",
        message: `File "${filename}": ${(err as Error).message}`,
      });
      continue;
    }

    if (`${meta.id}.md` !== filename) {
      report.problems.push({
        type: "MalformedTaskDocument",
        task_id: meta.id,
        message: `File "${filename}" declares task ID "${meta.id}"`,
      });
      continue;
    }

    if (tasks.has(meta.id)) {
      report.problems.push({
        type: "MalformedTaskDocument",
        task_id: meta.id,
        message: `Duplicate task ID "${meta.id}" in file "${filename}"`,
      });
      continue;
    }

    if (meta.state === "CLOSED") {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: meta.id,
        message: `Task "${meta.id}" is CLOSED but still in the active directory`,
      });
      continue;
    }

    tasks.set(meta.id, meta);
  }

  for (const [id, task] of tasks) {
    const state = task.state as ValidState;

    for (const dep of task.depends_on) {
      if (!tasks.has(dep)) {
        report.problems.push({
          type: "MissingDependency",
          task_id: id,
          message: `Task "${id}" depends on "${dep}" which does not exist`,
        });
      }
    }

    if (state === "BLOCKED" && task.depends_on.length === 0) {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: id,
        message: `Task "${id}" is BLOCKED but has no dependencies`,
      });
    }

    if (state !== "BLOCKED" && state !== "NEW" && task.depends_on.length > 0) {
      report.problems.push({
        type: "InvalidMetadata",
        task_id: id,
        message: `Task "${id}" is in ${state} but still depends on ${task.depends_on.join(", ")}`,
      });
    }

    const isClaimedState = (CLAIMED_STATES as readonly ValidState[]).includes(
      state,
    );

    if (isClaimedState && task.claimed_by === null) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in ${state} state but has no claim`,
      });
    }

    if (!isClaimedState && task.claimed_by !== null) {
      report.problems.push({
        type: "InvalidStateTransition",
        task_id: id,
        message: `Task "${id}" is in ${state} state but is claimed by "${task.claimed_by}"`,
      });
    }

    if (task.claimed_pid !== null && !isProcessAlive(task.claimed_pid)) {
      report.problems.push({
        type: "MissingClaimProcess",
        task_id: id,
        message: `Task "${id}" claimed by "${task.claimed_by}" (PID ${task.claimed_pid}) but process no longer exists; use "release"`,
      });
    }

    const threshold = STUCK_THRESHOLDS_HOURS[state];
    if (threshold !== undefined && task.state_entered !== null) {
      const entered = Date.parse(task.state_entered);
      const hours = (Date.now() - entered) / (1000 * 60 * 60);
      if (hours > threshold) {
        report.problems.push({
          type: "StuckTask",
          task_id: id,
          message: `Task "${id}" has been in "${state}" for ${hours.toFixed(1)} hours (threshold: ${threshold}h)`,
        });
      }
    }

    checkQueues(task, state, report.problems);
    checkStateEntered(task, state, report.problems);

    report.tasks[state].push(id);
    report.open[id] = {
      open_todos: openCount(task.todos),
      open_checks: openCount(task.checks),
      open_task_graph_updates: openCount(task.task_graph_updates),
    };
  }

  checkLock(tasksDir, report.problems);
  checkNextTaskId(tasksDir, [...tasks.keys()], report.problems);

  const cycleNodes = detectCycles(tasks);
  if (cycleNodes.length > 0) {
    report.problems.push({
      type: "DependencyCycle",
      message: `Circular dependency detected involving tasks: ${cycleNodes.sort().join(", ")}`,
    });
  }

  for (const state of VALID_STATES) {
    report.tasks[state].sort();
  }

  return report;
}

function main(): void {
  const tasksDir = path.dirname(fileURLToPath(import.meta.url));
  console.log(JSON.stringify(buildReport(tasksDir), null, 2));
}

if (import.meta.main) {
  main();
}
