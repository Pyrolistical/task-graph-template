import { type TaskId, type TaskMeta } from "./task.ts";
import { type AgentSlot, agentModelKey } from "./agents.ts";
import { type ClaimState, type Role, STATE_ROLE } from "./states.ts";
import type { RateOf } from "./rates.ts";

export const RANKS = [
  "resume",
  "WORK_REVIEW",
  "WORK_STARTED",
  "WORK_FRESH",
  "PLAN_REVIEW",
  "PLAN_STARTED",
  "PLAN_FRESH",
  "DESIGN_REVIEW",
  "DESIGN_STARTED",
  "DESIGN_FRESH",
] as const;

export type Rank = (typeof RANKS)[number];

export interface Candidate {
  task_id: TaskId;
  rank: Rank;
  stage: ClaimState;
  role: Role;
  blocking: number;
  prefer_agent: string | null;
  session: string | null;
}

const RANK_STAGE: Record<Rank, ClaimState> = {
  resume: "WORK",
  WORK_REVIEW: "WORK_REVIEW",
  WORK_STARTED: "WORK",
  WORK_FRESH: "WORK",
  PLAN_REVIEW: "PLAN_REVIEW",
  PLAN_STARTED: "PLAN",
  PLAN_FRESH: "PLAN",
  DESIGN_REVIEW: "DESIGN_REVIEW",
  DESIGN_STARTED: "DESIGN",
  DESIGN_FRESH: "DESIGN",
};

function rankOf(task: TaskMeta, resumable: Set<TaskId>): Rank | null {
  if (task.claimed_by !== null) {
    return null;
  }
  if (resumable.has(task.id)) {
    return "resume";
  }
  if (task.state === "WORK_REVIEW") {
    return "WORK_REVIEW";
  }
  if (task.state === "WORK") {
    return task.workspace === null ? "WORK_FRESH" : "WORK_STARTED";
  }
  if (task.state === "PLAN_REVIEW") {
    return "PLAN_REVIEW";
  }
  if (task.state === "PLAN") {
    return task.workspace === null ? "PLAN_FRESH" : "PLAN_STARTED";
  }
  if (task.state === "DESIGN_REVIEW") {
    return "DESIGN_REVIEW";
  }
  if (task.state === "DESIGN") {
    return task.workspace === null ? "DESIGN_FRESH" : "DESIGN_STARTED";
  }
  return null;
}

export function candidates(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
  blocking: Map<TaskId, number>,
): Candidate[] {
  const found: Candidate[] = [];

  for (const [id, task] of tasks) {
    const rank = rankOf(task, resumable);
    if (rank === null) {
      continue;
    }
    found.push({
      task_id: id,
      rank,
      stage: RANK_STAGE[rank],
      role: STATE_ROLE[RANK_STAGE[rank]],
      blocking: blocking.get(id) ?? 0,
      prefer_agent: task.workspace?.agent ?? null,
      session: rank === "resume" ? (task.workspace?.session ?? null) : null,
    });
  }

  return found.sort(
    (a, b) =>
      RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) ||
      b.blocking - a.blocking ||
      a.task_id.localeCompare(b.task_id),
  );
}

function fastest(slots: AgentSlot[], rate: RateOf): AgentSlot {
  const score = (slot: AgentSlot) => rate(slot.agent) ?? Infinity;
  return slots.reduce((best, slot) =>
    score(slot) > score(best) ? slot : best,
  );
}

export function pickSlot(
  free: AgentSlot[],
  candidate: Candidate,
  isTop: boolean,
  rate: RateOf,
): AgentSlot | null {
  const eligible = free.filter((slot) => slot.roles.includes(candidate.role));
  if (eligible.length === 0) {
    return null;
  }
  if (candidate.prefer_agent === null) {
    return fastest(eligible, rate);
  }

  const wanted = agentModelKey(candidate.prefer_agent);
  const same = eligible.find((slot) => agentModelKey(slot.name) === wanted);
  if (same !== undefined) {
    return same;
  }

  return candidate.rank === "resume" && !isTop ? null : fastest(eligible, rate);
}

export interface Dispatch {
  candidate: Candidate;
  slot: AgentSlot;
}

export function plan(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
  blocking: Map<TaskId, number>,
  free: AgentSlot[],
  rate: RateOf,
): Dispatch[] {
  const remaining = [...free];
  const dispatches: Dispatch[] = [];

  candidates(tasks, resumable, blocking).forEach((candidate, index) => {
    const slot = pickSlot(remaining, candidate, index === 0, rate);
    if (slot === null) {
      return;
    }
    remaining.splice(remaining.indexOf(slot), 1);
    dispatches.push({ candidate, slot });
  });

  return dispatches;
}
