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

interface Stage {
  state: ValidState;
  phase: Phase;
  role: Role | null;
  tools: string | null;
  section: string | null;
  missing: string | null;
  guard: Guard;
  back: ValidState | null;
  body: boolean;
}

export const STAGES = [
  {
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
  {
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
  {
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
  {
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
  {
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
  {
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
  {
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
  {
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
] as const satisfies readonly Stage[];

type AnyStage = (typeof STAGES)[number];

export type AgentStage = Extract<AnyStage, { role: Role }>;

export type ReviewStage = Extract<AnyStage, { role: "reviewer" }>;

export type StageState = AnyStage["state"];

export type ClaimState = AgentStage["state"];

export type ReviewState = ReviewStage["state"];

export type AdvancingState = Exclude<StageState, "MANAGER_REVIEW">;

export const AGENT_STAGES = STAGES.filter(
  (stage): stage is AgentStage => stage.role !== null,
);

export const AGENT_STATES = AGENT_STAGES.map(
  (stage) => stage.state,
) as ClaimState[];

export const REVIEW_STATES = STAGES.filter(
  (stage) => stage.role === "reviewer",
).map((stage) => stage.state) as ReviewState[];

export const REVIEW_FAILURE_LIMIT = 2;

export const STAGE_OF = Object.fromEntries(
  STAGES.map((stage) => [stage.state, stage]),
) as { [S in StageState]: Extract<AnyStage, { state: S }> };

export const NEXT_STATE = Object.fromEntries(
  STAGES.slice(0, -1).map((stage, index) => [
    stage.state,
    STAGES[index + 1]!.state,
  ]),
) as Record<AdvancingState, StageState>;

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

export function isHeld(state: TaskState): state is HeldState {
  return (HELD_STATES as readonly string[]).includes(state);
}

export function isStage(state: TaskState): state is StageState {
  return state in STAGE_OF;
}

export function isAgentState(state: TaskState): state is ClaimState {
  return (AGENT_STATES as readonly string[]).includes(state);
}

export function isReviewState(state: TaskState): state is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(state);
}

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
      const submitted = STAGE_OF[state as AdvancingState].body
        ? requireText(args.body, "body")
        : null;
      return move(NEXT_STATE[state as AdvancingState], submitted);
    }

    case "pass": {
      return move(NEXT_STATE[state as AdvancingState]);
    }

    case "fail": {
      return move(STAGE_OF[state as AdvancingState].back!);
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
      const target = STAGE_OF[state as StageState].back!;
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
      `Transition "${name}" is the agent holding "${meta.id}" speaking, but nothing is claiming it`,
    );
  }

  return mutate(meta, from, name, args, body);
}
