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

export const CLOSED_STATE = "CLOSED";

export const ALL_STATES = [...VALID_STATES, CLOSED_STATE] as const;

export type TaskState = (typeof ALL_STATES)[number];

interface Stage {
  state: ValidState;
  phase: Phase;
  role: Role | null;
  tools: string | null;
}

export const STAGES = [
  {
    state: "DESIGN",
    phase: "design",
    role: "designer",
    tools: "designer",
  },
  {
    state: "DESIGN_REVIEW",
    phase: "design",
    role: "reviewer",
    tools: "design-reviewer",
  },
  {
    state: "PLAN",
    phase: "plan",
    role: "planner",
    tools: "planner",
  },
  {
    state: "PLAN_REVIEW",
    phase: "plan",
    role: "reviewer",
    tools: "plan-reviewer",
  },
  {
    state: "WORK",
    phase: "work",
    role: "worker",
    tools: "worker",
  },
  {
    state: "CHECK",
    phase: "work",
    role: null,
    tools: null,
  },
  {
    state: "WORK_REVIEW",
    phase: "work",
    role: "reviewer",
    tools: "work-reviewer",
  },
  {
    state: "MANAGER_REVIEW",
    phase: "work",
    role: null,
    tools: null,
  },
] as const satisfies readonly Stage[];

type AgentStage = Extract<(typeof STAGES)[number], { role: Role }>;

export type StageState = (typeof STAGES)[number]["state"];

export type ClaimState = AgentStage["state"];

export type AdvancingState = Exclude<StageState, "MANAGER_REVIEW">;

const AGENT_STAGES = STAGES.filter(
  (stage): stage is AgentStage => stage.role !== null,
);

export const NEXT_STATE = Object.fromEntries(
  STAGES.slice(0, -1).map((stage, index) => [
    stage.state,
    STAGES[index + 1]!.state,
  ]),
) as Record<AdvancingState, StageState>;

export const AGENT_STATES = AGENT_STAGES.map(
  (stage) => stage.state,
) as ClaimState[];

export const STATE_ROLE = Object.fromEntries(
  AGENT_STAGES.map((stage) => [stage.state, stage.role]),
) as Record<ClaimState, Role>;

export const STATE_TOOLS = Object.fromEntries(
  AGENT_STAGES.map((stage) => [stage.state, stage.tools]),
) as Record<ClaimState, string>;

export const PHASE_OF = Object.fromEntries(
  STAGES.map((stage) => [stage.state, stage.phase]),
) as Record<StageState, Phase>;

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
  return state in PHASE_OF;
}

export function isAgentState(state: TaskState): state is ClaimState {
  return (AGENT_STATES as readonly string[]).includes(state);
}
