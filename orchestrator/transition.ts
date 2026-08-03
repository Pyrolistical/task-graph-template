import fs from "node:fs";
import path from "node:path";
import {
  type TaskId,
  type TaskMeta,
  type TaskState,
  type ValidState,
  closeTaskFile,
  findTaskFile,
  isProcessAlive,
  openCount,
  readTaskFile,
  withLock,
  writeTaskFile,
} from "./task.ts";

export const TRANSITION_NAMES = [
  "claim",
  "release",
  "submit",
  "pass",
  "fail",
  "hold",
  "resume",
  "addFeedback",
  "abort",
] as const;

export type TransitionName = (typeof TRANSITION_NAMES)[number];

export const ALLOWED_TRANSITIONS: Record<ValidState, TransitionName[]> = {
  NEW: ["submit"],
  BLOCKED: ["submit"],
  HELD_PLAN: ["resume", "abort"],
  HELD_WORK: ["resume", "abort"],
  READY_PLAN: ["hold", "claim"],
  PLANNING: ["submit", "hold", "release"],
  READY_PLAN_REVIEW: ["claim", "hold"],
  PLAN_REVIEWING: ["submit", "addFeedback", "hold", "release"],
  READY_WORK: ["hold", "claim"],
  WORKING: ["submit", "hold", "release"],
  READY_CHECK: ["claim", "hold"],
  CHECKING: ["pass", "fail", "hold", "release"],
  READY_WORK_REVIEW: ["claim", "hold"],
  WORK_REVIEWING: ["addFeedback", "submit", "hold", "release"],
  READY_MANAGER_REVIEW: ["claim"],
  MANAGER_REVIEWING: ["addFeedback", "submit", "abort", "release"],
  READY_TASK_GRAPH_UPDATE: ["claim"],
  TASK_GRAPH_UPDATING: ["submit", "release"],
};

export const CLAIM_TARGETS: Partial<Record<ValidState, ValidState>> = {
  READY_PLAN: "PLANNING",
  READY_PLAN_REVIEW: "PLAN_REVIEWING",
  READY_WORK: "WORKING",
  READY_CHECK: "CHECKING",
  READY_WORK_REVIEW: "WORK_REVIEWING",
  READY_MANAGER_REVIEW: "MANAGER_REVIEWING",
  READY_TASK_GRAPH_UPDATE: "TASK_GRAPH_UPDATING",
};

const RELEASE_TARGETS: Partial<Record<ValidState, ValidState>> = {
  PLANNING: "READY_PLAN",
  PLAN_REVIEWING: "READY_PLAN_REVIEW",
  WORKING: "READY_WORK",
  CHECKING: "READY_CHECK",
  WORK_REVIEWING: "READY_WORK_REVIEW",
  MANAGER_REVIEWING: "READY_MANAGER_REVIEW",
  TASK_GRAPH_UPDATING: "READY_TASK_GRAPH_UPDATE",
};

const SUBMIT_TARGETS: Partial<Record<ValidState, ValidState>> = {
  PLANNING: "READY_PLAN_REVIEW",
  PLAN_REVIEWING: "READY_WORK",
  WORKING: "READY_CHECK",
  WORK_REVIEWING: "READY_MANAGER_REVIEW",
};

const PASS_TARGETS: Partial<Record<ValidState, TaskState>> = {
  CHECKING: "READY_WORK_REVIEW",
};

const FAIL_TARGETS: Partial<Record<ValidState, ValidState>> = {
  CHECKING: "READY_WORK",
};

const UNCLAIMED_STATES: TaskState[] = [
  "NEW",
  "BLOCKED",
  "HELD_PLAN",
  "HELD_WORK",
  "READY_PLAN",
  "READY_PLAN_REVIEW",
  "READY_WORK",
  "READY_CHECK",
  "READY_WORK_REVIEW",
  "READY_MANAGER_REVIEW",
  "READY_TASK_GRAPH_UPDATE",
  "CLOSED",
];

export interface TransitionArgs {
  agentName?: string;
  pid?: number;
  branch?: string;
  worktree?: string;
  session?: string;
  reason?: string;
  body?: string;
  findings?: string[];
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

function requireFindings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"findings" must be a non-empty list`);
  }
  for (const finding of value as unknown[]) {
    requireText(finding, "a finding");
  }
  return value as string[];
}

function mutate(
  meta: TaskMeta,
  state: ValidState,
  name: TransitionName,
  args: TransitionArgs,
  body: string,
): { target: TaskState | null; body?: string } {
  switch (name) {
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
      return { target: CLAIM_TARGETS[state]! };
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
      return { target: RELEASE_TARGETS[state]! };
    }

    case "submit": {
      if (state === "NEW") {
        return {
          target: meta.depends_on.length > 0 ? "BLOCKED" : "READY_PLAN",
        };
      }
      if (state === "BLOCKED") {
        return {
          target: meta.depends_on.length > 0 ? null : "READY_PLAN",
        };
      }
      if (state === "MANAGER_REVIEWING") {
        return {
          target:
            meta.task_graph_updates.length === 0
              ? "CLOSED"
              : "READY_TASK_GRAPH_UPDATE",
        };
      }
      if (state === "TASK_GRAPH_UPDATING") {
        const remaining = openCount(meta.task_graph_updates);
        if (remaining > 0) {
          throw new Error(
            `Task "${meta.id}" still has ${remaining} open task graph update${remaining === 1 ? "" : "s"}`,
          );
        }
        return { target: "CLOSED" };
      }
      const body =
        state === "PLAN_REVIEWING" || state === "WORKING"
          ? requireText(args.body, "body")
          : undefined;
      return { target: SUBMIT_TARGETS[state]!, body };
    }

    case "pass": {
      return { target: PASS_TARGETS[state]! };
    }

    case "fail": {
      return { target: FAIL_TARGETS[state]! };
    }

    case "hold": {
      meta.held_reason = requireText(args.reason, "reason");
      return {
        target:
          state === "PLANNING" ||
          state === "PLAN_REVIEWING" ||
          state === "READY_PLAN" ||
          state === "READY_PLAN_REVIEW"
            ? "HELD_PLAN"
            : "HELD_WORK",
      };
    }

    case "resume": {
      if (meta.depends_on.length > 0) {
        return { target: "BLOCKED" };
      }
      return {
        target: state === "HELD_PLAN" ? "READY_PLAN" : "READY_WORK",
      };
    }

    case "addFeedback": {
      const findings = requireFindings(args.findings);
      if (state === "PLAN_REVIEWING") {
        return { target: "READY_PLAN" };
      }
      const findingsSection = `\n\n# Review findings\n\n${findings
        .map((finding) => `- ${finding}`)
        .join("\n")}\n\n## Implementation Notes\n\n`;
      return { target: "READY_WORK", body: body + findingsSection };
    }

    case "abort": {
      return {
        target:
          meta.task_graph_updates.length > 0
            ? "READY_TASK_GRAPH_UPDATE"
            : "CLOSED",
      };
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
      meta.state = "READY_PLAN";
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
    const { target, body: newBody } = mutate(meta, from, name, args, body);
    const nextBody = newBody ?? body;

    if (target !== null) {
      meta.state = target;
    }
    meta.state_entered = now;

    if (target !== null && UNCLAIMED_STATES.includes(target)) {
      meta.claimed_by = null;
      meta.claimed_pid = null;
    }

    if (target !== null && target !== "HELD_PLAN" && target !== "HELD_WORK") {
      meta.held_reason = null;
    }

    if (target === "CLOSED") {
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
        to: target,
        closedPath,
        unblocked,
        dependentsUpdated,
      };
    }

    writeTaskFile(filePath, meta, nextBody);
    return { taskId, from, to: target, unblocked: [], dependentsUpdated: [] };
  });
}
