import type { RateOf } from "../../kernel/domain/rates.ts";
import { STAGE_OF, isClaimState } from "../../vocabulary/state-machine.ts";
import { type TaskId, type TaskMeta } from "../../vocabulary/task.ts";
import {
  type Candidate,
  type Rank,
  RANKS,
  STATE_OF,
} from "../../views/queue.ts";
import { type Slot, agentOf } from "../domain/slots.ts";

function rankOf(task: TaskMeta, resumable: Set<TaskId>): Rank | undefined {
  if (task.claimed_by) {
    return undefined;
  }
  if (resumable.has(task.id)) {
    return "resume";
  }
  if (!isClaimState(task.state)) {
    return undefined;
  }
  const stage = STAGE_OF[task.state];
  if (!stage.section) {
    return stage.state;
  }
  return !task.workspace ? `${stage.state}_FRESH` : `${stage.state}_STARTED`;
}

export function candidates(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
  blocking: Map<TaskId, number>,
): Candidate[] {
  const found: Candidate[] = [];

  for (const [id, task] of tasks) {
    const rank = rankOf(task, resumable);
    if (!rank) {
      continue;
    }
    found.push({
      task_id: id,
      rank,
      state: STATE_OF[rank],
      role: STAGE_OF[STATE_OF[rank]].role,
      blocking: blocking.get(id) ?? 0,
      prefer_slot: task.workspace?.slot,
      session: rank === "resume" ? task.workspace?.session : undefined,
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
): Slot | undefined {
  const eligible = free.filter((slot) => slot.roles.includes(candidate.role));
  if (eligible.length === 0) {
    return undefined;
  }
  if (!candidate.prefer_slot) {
    return fastest(eligible, rate);
  }

  const wanted = agentOf(candidate.prefer_slot);
  const same = eligible.find((slot) => agentOf(slot.name) === wanted);
  if (same) {
    return same;
  }

  return candidate.rank === "resume" && !isTop
    ? undefined
    : fastest(eligible, rate);
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
    if (!slot) {
      return;
    }
    remaining.splice(remaining.indexOf(slot), 1);
    dispatches.push({ candidate, slot });
  });

  return dispatches;
}
