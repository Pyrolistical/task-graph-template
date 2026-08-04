import fs from "node:fs";
import path from "node:path";
import {
  type TaskId,
  type TaskMeta,
  closeTaskFile,
  findTaskFile,
  readTaskFile,
  withLock,
  writeTaskFile,
} from "./task.ts";
import {
  type AdvancingState,
  type HeldState,
  type TaskState,
  type ValidState,
  ENTRY_STATE,
  HELD_OF,
  NEXT_STATE,
  PHASE_OF,
  RESUME_TARGETS,
  isAgentState,
  isHeld,
  isStage,
} from "./states.ts";

export const TRANSITION_NAMES = [
  "submit",
  "pass",
  "fail",
  "hold",
  "resume",
  "feedback",
  "abort",
] as const;

export type TransitionName = (typeof TRANSITION_NAMES)[number];

export const ALLOWED_TRANSITIONS: Record<ValidState, TransitionName[]> = {
  NEW: ["submit"],
  BLOCKED: ["submit"],
  HELD_DESIGN: ["resume", "abort"],
  HELD_PLAN: ["resume", "abort"],
  HELD_WORK: ["resume", "abort"],
  DESIGN: ["submit", "hold"],
  DESIGN_REVIEW: ["submit", "feedback", "hold"],
  PLAN: ["submit", "hold"],
  PLAN_REVIEW: ["submit", "feedback", "hold"],
  WORK: ["submit", "hold"],
  CHECK: ["pass", "fail", "hold"],
  WORK_REVIEW: ["submit", "feedback", "hold"],
  MANAGER_REVIEW: ["feedback", "submit", "abort"],
};

const FAIL_TARGETS: Partial<Record<ValidState, ValidState>> = {
  CHECK: "WORK",
};

const AGENT_SPEECH: TransitionName[] = ["submit", "feedback"];

export interface TransitionArgs {
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
    case "submit": {
      if (state === "NEW") {
        return {
          target: meta.depends_on.length > 0 ? "BLOCKED" : "DESIGN",
        };
      }
      if (state === "BLOCKED") {
        return {
          target: meta.depends_on.length > 0 ? null : ENTRY_STATE,
        };
      }
      if (state === "MANAGER_REVIEW") {
        return { target: "CLOSED" };
      }
      const submitted =
        state === "DESIGN_REVIEW" || state === "PLAN_REVIEW" || state === "WORK"
          ? requireText(args.body, "body")
          : undefined;
      return { target: NEXT_STATE[state as AdvancingState], body: submitted };
    }

    case "pass": {
      return { target: NEXT_STATE[state as AdvancingState] };
    }

    case "fail": {
      return { target: FAIL_TARGETS[state]! };
    }

    case "hold": {
      if (!isStage(state)) {
        throw new Error(`Task "${meta.id}" has no phase to be held from`);
      }
      meta.held_reason = requireText(args.reason, "reason");
      return { target: HELD_OF[PHASE_OF[state]] };
    }

    case "resume": {
      if (!isHeld(state)) {
        throw new Error(`Task "${meta.id}" is not held`);
      }
      if (meta.depends_on.length > 0) {
        return { target: "BLOCKED" };
      }
      return { target: RESUME_TARGETS[state] };
    }

    case "feedback": {
      const findings = requireFindings(args.findings);
      if (state === "DESIGN_REVIEW") {
        return { target: "DESIGN" };
      }
      if (state === "PLAN_REVIEW") {
        return { target: "PLAN" };
      }
      const findingsSection = `\n\n# Review findings\n\n${findings
        .map((finding) => `- ${finding}`)
        .join("\n")}\n`;
      return { target: "WORK", body: body + findingsSection };
    }

    case "abort": {
      return { target: "CLOSED" };
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
      meta.state = ENTRY_STATE;
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
    if (
      isAgentState(from) &&
      AGENT_SPEECH.includes(name) &&
      meta.claimed_by === null
    ) {
      throw new Error(
        `Transition "${name}" is the agent holding "${taskId}" speaking, but nothing is claiming it`,
      );
    }

    const now = new Date().toISOString();
    const { target, body: newBody } = mutate(meta, from, name, args, body);
    const nextBody = newBody ?? body;

    if (target !== null) {
      meta.state = target;
    }
    meta.state_entered = now;
    meta.claimed_by = null;
    meta.claimed_pid = null;

    if (target !== null && !isHeld(target)) {
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
