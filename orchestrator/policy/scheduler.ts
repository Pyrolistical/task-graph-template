import { type TaskId, type TaskMeta } from "../domain/task.ts";
import { type Slot, agentOf } from "../domain/agents.ts";
import {
  type AgentStage,
  type ClaimState,
  type Role,
  AGENT_STAGES,
  STAGE_OF,
  isAgentState,
} from "../domain/state-machine.ts";
import type { RateOf } from "../domain/rates.ts";

function ranksOf(stage: AgentStage) {
  return stage.section === null
    ? ([stage.state] as const)
    : ([`${stage.state}_STARTED`, `${stage.state}_FRESH`] as const);
}

export const RANKS = [
  "resume",
  ...[...AGENT_STAGES].reverse().flatMap(ranksOf),
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

export const RANK_STAGE = Object.fromEntries(
  RANKS.map((rank) => [
    rank,
    rank === "resume" ? "WORK" : rank.replace(/_(STARTED|FRESH)$/, ""),
  ]),
) as Record<Rank, ClaimState>;

export function rankLabel(rank: Rank): string {
  return rank === "resume" ? rank : RANK_STAGE[rank];
}

function rankOf(task: TaskMeta, resumable: Set<TaskId>): Rank | null {
  if (task.claimed_by !== null) {
    return null;
  }
  if (resumable.has(task.id)) {
    return "resume";
  }
  if (!isAgentState(task.state)) {
    return null;
  }
  const stage = STAGE_OF[task.state];
  if (stage.section === null) {
    return stage.state;
  }
  return task.workspace === null
    ? `${stage.state}_FRESH`
    : `${stage.state}_STARTED`;
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
      role: STAGE_OF[RANK_STAGE[rank]].role,
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

function fastest(slots: Slot[], rate: RateOf): Slot {
  const score = (slot: Slot) => rate(slot.agent) ?? Infinity;
  return slots.reduce((best, slot) =>
    score(slot) > score(best) ? slot : best,
  );
}

export function pickSlot(
  free: Slot[],
  candidate: Candidate,
  isTop: boolean,
  rate: RateOf,
): Slot | null {
  const eligible = free.filter((slot) => slot.roles.includes(candidate.role));
  if (eligible.length === 0) {
    return null;
  }
  if (candidate.prefer_agent === null) {
    return fastest(eligible, rate);
  }

  const wanted = agentOf(candidate.prefer_agent);
  const same = eligible.find((slot) => agentOf(slot.name) === wanted);
  if (same !== undefined) {
    return same;
  }

  return candidate.rank === "resume" && !isTop ? null : fastest(eligible, rate);
}

export interface Dispatch {
  candidate: Candidate;
  slot: Slot;
}

export function plan(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
  blocking: Map<TaskId, number>,
  free: Slot[],
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
