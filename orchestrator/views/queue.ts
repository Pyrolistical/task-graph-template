import { z } from "zod";
import { tableOf } from "../kernel/domain/lookup.ts";
import { maybe } from "../kernel/domain/schema.ts";
import {
  type ClaimStage,
  type ClaimState,
  ALL_ROLES,
  CLAIM_STAGES,
  CLAIM_STATES,
  isClaimState,
} from "../vocabulary/state-machine.ts";

function ranksOf(stage: ClaimStage) {
  return !stage.section
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
  prefer_slot: maybe(z.string()),
  session: maybe(z.string()),
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
