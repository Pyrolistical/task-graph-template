import { z } from "zod";
import { tableOf } from "../domain/lookup.ts";
import { type TaskId, type TaskMeta } from "../domain/task.ts";
import { type Slot, agentOf } from "../domain/agents.ts";
import {
  type ClaimStage,
  type ClaimState,
  ALL_ROLES,
  CLAIM_STAGES,
  CLAIM_STATES,
  STAGE_OF,
  isClaimState,
} from "../domain/state-machine.ts";
import type { RateOf } from "../domain/rates.ts";

function ranksOf(stage: ClaimStage) {
  return stage.section === null
    ? ([stage.state] as const)
    : ([`${stage.state}_STARTED`, `${stage.state}_FRESH`] as const);
}

export const RANKS = [
  "resume",
  ...[...CLAIM_STAGES].reverse().flatMap(ranksOf),
] as const;

export type Rank = (typeof RANKS)[number];

export const Candidate = z.strictObject({
  task_id: z.string(),
  rank: z.enum(RANKS),
  state: z.enum(CLAIM_STATES),
  role: z.enum(ALL_ROLES),
  blocking: z.int(),
  prefer_slot: z.string().nullable(),
  session: z.string().nullable(),
});

export type Candidate = z.infer<typeof Candidate>;

export const QueueView = z.looseObject({
  scheduling: z.boolean(),
  queue: z.array(Candidate),
});

function stateOfRank(rank: Rank): ClaimState {
  const state =
    rank === "resume" ? "WORK" : rank.replace(/_(STARTED|FRESH)$/, "");
  if (!isClaimState(state)) {
    throw new Error(`rank "${rank}" does not name a state an agent claims`);
  }
  return state;
}

export const STATE_OF = tableOf(RANKS, (rank) => rank, stateOfRank);

export function rankLabel(rank: Rank): string {
  return rank === "resume" ? rank : STATE_OF[rank];
}

function rankOf(task: TaskMeta, resumable: Set<TaskId>): Rank | null {
  if (task.claimed_by !== null) {
    return null;
  }
  if (resumable.has(task.id)) {
    return "resume";
  }
  if (!isClaimState(task.state)) {
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
      state: STATE_OF[rank],
      role: STAGE_OF[STATE_OF[rank]].role,
      blocking: blocking.get(id) ?? 0,
      prefer_slot: task.workspace?.slot ?? null,
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
  if (candidate.prefer_slot === null) {
    return fastest(eligible, rate);
  }

  const wanted = agentOf(candidate.prefer_slot);
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

export function schedule(
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
