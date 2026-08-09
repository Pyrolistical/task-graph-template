import { memberOf, tableOf } from "./lookup.ts";
import type { TaskId, TaskMeta } from "./task.ts";

export const PHASES = ["design", "plan", "work"] as const;

export type Phase = (typeof PHASES)[number];

export const ALL_ROLES = ["worker", "reviewer", "planner", "designer"] as const;

export type Role = (typeof ALL_ROLES)[number];

export const VALID_STATES = [
  "NEW",
  "BLOCKED",
  "HELD_DESIGN",
  "HELD_PLAN",
  "HELD_WORK",
  "DESIGN",
  "DESIGN_REVIEW",
  "PLAN",
  "PLAN_REVIEW",
  "WORK",
  "CHECK",
  "WORK_REVIEW",
  "MANAGER_REVIEW",
] as const;

export type ValidState = (typeof VALID_STATES)[number];

export const ALL_STATES = [...VALID_STATES, "CLOSED"] as const;

export type TaskState = (typeof ALL_STATES)[number];

export type Guard = "none" | "untouched" | "committed";

type StageFields = {
  state: ValidState;
  phase: Phase;
  guard: Guard;
  body: boolean;
} & (
  | {
      role: Exclude<Role, "reviewer">;
      tools: string;
      section: string;
      missing: string;
      back: null;
    }
  | {
      role: "reviewer";
      tools: string;
      section: null;
      missing: null;
      back: ValidState;
    }
  | {
      role: null;
      tools: null;
      section: null;
      missing: null;
      back: ValidState;
    }
);

export const STAGE_OF = {
  DESIGN: {
    state: "DESIGN",
    phase: "design",
    role: "designer",
    tools: "designer",
    section: "## Design",
    missing: "missing-design",
    guard: "untouched",
    back: null,
    body: false,
  },
  DESIGN_REVIEW: {
    state: "DESIGN_REVIEW",
    phase: "design",
    role: "reviewer",
    tools: "design-reviewer",
    section: null,
    missing: null,
    guard: "untouched",
    back: "DESIGN",
    body: true,
  },
  PLAN: {
    state: "PLAN",
    phase: "plan",
    role: "planner",
    tools: "planner",
    section: "## Todos",
    missing: "missing-todos",
    guard: "untouched",
    back: null,
    body: false,
  },
  PLAN_REVIEW: {
    state: "PLAN_REVIEW",
    phase: "plan",
    role: "reviewer",
    tools: "plan-reviewer",
    section: null,
    missing: null,
    guard: "untouched",
    back: "PLAN",
    body: true,
  },
  WORK: {
    state: "WORK",
    phase: "work",
    role: "worker",
    tools: "worker",
    section: "## Implementation Notes",
    missing: "missing-notes",
    guard: "committed",
    back: null,
    body: true,
  },
  CHECK: {
    state: "CHECK",
    phase: "work",
    role: null,
    tools: null,
    section: null,
    missing: null,
    guard: "none",
    back: "WORK",
    body: false,
  },
  WORK_REVIEW: {
    state: "WORK_REVIEW",
    phase: "work",
    role: "reviewer",
    tools: "work-reviewer",
    section: null,
    missing: null,
    guard: "none",
    back: "WORK",
    body: false,
  },
  MANAGER_REVIEW: {
    state: "MANAGER_REVIEW",
    phase: "work",
    role: null,
    tools: null,
    section: null,
    missing: null,
    guard: "none",
    back: "WORK",
    body: false,
  },
} as const satisfies { [S in ValidState]?: StageFields & { state: S } };

export const STAGES = Object.values(STAGE_OF);

export type Stage = (typeof STAGES)[number];

export type ClaimStage = Extract<Stage, { role: Role }>;

export type ReviewStage = Extract<Stage, { role: "reviewer" }>;

export type StageState = Stage["state"];

export type ClaimState = ClaimStage["state"];

export type ReviewState = ReviewStage["state"];

export type AdvancingState = Exclude<StageState, "MANAGER_REVIEW">;

export const CLAIM_STAGES = STAGES.filter(
  (stage): stage is ClaimStage => stage.role !== null,
);

export const CLAIM_STATES = CLAIM_STAGES.map((stage) => stage.state);

export const REVIEW_STAGES = STAGES.filter(
  (stage): stage is ReviewStage => stage.role === "reviewer",
);

export const REVIEW_STATES = REVIEW_STAGES.map((stage) => stage.state);

export const REVIEW_FAILURE_LIMIT = 2;

export const NEXT_STATE = tableOf(
  STAGES.slice(0, -1),
  (stage) => stage.state,
  (_stage, index) => STAGES[index + 1].state,
);

export const HELD_STATES = ["HELD_DESIGN", "HELD_PLAN", "HELD_WORK"] as const;

export type HeldState = (typeof HELD_STATES)[number];

export const HELD_OF: Record<Phase, HeldState> = {
  design: "HELD_DESIGN",
  plan: "HELD_PLAN",
  work: "HELD_WORK",
};

export const RESUME_TARGETS: Record<HeldState, StageState> = {
  HELD_DESIGN: "DESIGN",
  HELD_PLAN: "PLAN",
  HELD_WORK: "WORK",
};

export const ENTRY_STATE: StageState = "DESIGN";

export const isValidState = memberOf(VALID_STATES);

export const isHeld = memberOf(HELD_STATES);

export function isStage(state: TaskState): state is StageState {
  return state in STAGE_OF;
}

export const isClaimState = memberOf(CLAIM_STATES);

export const isReviewState = memberOf(REVIEW_STATES);

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

const OFF_STAGE: Record<Exclude<ValidState, StageState>, TransitionName[]> = {
  NEW: ["submit"],
  BLOCKED: ["submit"],
  HELD_DESIGN: ["resume", "abort"],
  HELD_PLAN: ["resume", "abort"],
  HELD_WORK: ["resume", "abort"],
};

function allowedFrom(state: ValidState): TransitionName[] {
  if (!isStage(state)) {
    return OFF_STAGE[state];
  }
  if (state === "MANAGER_REVIEW") {
    return ["feedback", "submit", "abort"];
  }

  const stage = STAGE_OF[state];
  if (stage.role === null) {
    return ["pass", "fail", "hold"];
  }
  return stage.role === "reviewer"
    ? ["submit", "feedback", "hold"]
    : ["submit", "hold"];
}

export const ALLOWED_TRANSITIONS = tableOf(
  VALID_STATES,
  (state) => state,
  allowedFrom,
);

const AGENT_SPEECH: TransitionName[] = ["submit", "feedback"];

export interface TransitionArgs {
  reason?: string;
  body?: string;
  findings?: string[];
}

interface Landing {
  taskId: TaskId;
  from: ValidState;
  unblocked: TaskId[];
  dependentsUpdated: TaskId[];
}

export type TransitionResult = Landing &
  (
    | { to: null }
    | { to: Exclude<TaskState, "CLOSED"> }
    | { to: "CLOSED"; closedPath: string }
  );

export type Decision =
  { kind: "stay" } | { kind: "move"; to: TaskState; body: string | null };

function stay(): Decision {
  return { kind: "stay" };
}

function move(to: TaskState, body: string | null = null): Decision {
  return { kind: "move", to, body };
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `"${label}" must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireTexts(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`"${label}" must be a list, got ${JSON.stringify(value)}`);
  }
  return value.map((item) => requireText(item, `an entry of "${label}"`));
}

function requireFindings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`"findings" must be a non-empty list`);
  }
  return requireTexts(value, "findings");
}

function advancing(state: ValidState, name: TransitionName): AdvancingState {
  if (!isStage(state) || state === "MANAGER_REVIEW") {
    throw new Error(
      `"${name}" moves a task on from a stage, and "${state}" is not one`,
    );
  }
  return state;
}

function backFrom(state: StageState, name: TransitionName): ValidState {
  const back = STAGE_OF[state].back;
  if (back === null) {
    throw new Error(
      `"${name}" sends a task back, and "${state}" has nowhere to go`,
    );
  }
  return back;
}

function mutate(
  meta: TaskMeta,
  state: ValidState,
  name: TransitionName,
  args: TransitionArgs,
  body: string,
): Decision {
  switch (name) {
    case "submit": {
      if (state === "NEW") {
        return move(meta.depends_on.length > 0 ? "BLOCKED" : "DESIGN");
      }
      if (state === "BLOCKED") {
        return meta.depends_on.length > 0 ? stay() : move(ENTRY_STATE);
      }
      if (state === "MANAGER_REVIEW") {
        return move("CLOSED");
      }
      const stage = advancing(state, name);
      const submitted = STAGE_OF[stage].body
        ? requireText(args.body, "body")
        : null;
      return move(NEXT_STATE[stage], submitted);
    }

    case "pass": {
      return move(NEXT_STATE[advancing(state, name)]);
    }

    case "fail": {
      return move(backFrom(advancing(state, name), name));
    }

    case "hold": {
      if (!isStage(state)) {
        throw new Error(`Task "${meta.id}" has no phase to be held from`);
      }
      meta.held_reason = requireText(args.reason, "reason");
      return move(HELD_OF[STAGE_OF[state].phase]);
    }

    case "resume": {
      if (!isHeld(state)) {
        throw new Error(`Task "${meta.id}" is not held`);
      }
      if (meta.depends_on.length > 0) {
        return move("BLOCKED");
      }
      return move(RESUME_TARGETS[state]);
    }

    case "feedback": {
      const findings = requireFindings(args.findings);
      if (!isStage(state)) {
        throw new Error(`"${name}" answers a stage, and "${state}" is not one`);
      }
      const target = backFrom(state, name);
      if (target !== "WORK") {
        return move(target);
      }
      const findingsSection = `\n\n# Review findings\n\n${findings
        .map((finding) => `- ${finding}`)
        .join("\n")}\n`;
      return move(target, body + findingsSection);
    }

    case "abort": {
      return move("CLOSED");
    }
  }
}

export function decide(
  meta: TaskMeta,
  body: string,
  name: TransitionName,
  args: TransitionArgs,
): Decision {
  if (meta.state === "CLOSED") {
    throw new Error(
      `Task "${meta.id}" is CLOSED and has no further transitions`,
    );
  }

  const from = meta.state;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(name)) {
    throw new Error(
      `Transition "${name}" is not valid from state "${from}". Valid transitions: ${allowed.join(", ")}`,
    );
  }
  if (
    isClaimState(from) &&
    AGENT_SPEECH.includes(name) &&
    meta.claimed_by === null
  ) {
    throw new Error(
      `Transition "${name}" is the agent holding "${meta.id}" speaking, but nothing is claiming it`,
    );
  }

  return mutate(meta, from, name, args, body);
}
