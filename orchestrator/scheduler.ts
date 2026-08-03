import { type TaskId, type TaskMeta } from "./task.ts";
import { type AgentSlot, agentModelKey } from "./agents.ts";
import { blockingCounts } from "./graph.ts";
import type { Role } from "./runtime.ts";

export const RANKS = [
  "resume",
  "READY_WORK_REVIEW",
  "READY_WORK_STARTED",
  "READY_WORK_FRESH",
  "READY_PLAN_REVIEW",
  "READY_PLAN_STARTED",
  "READY_PLAN_FRESH",
] as const;

export type Rank = (typeof RANKS)[number];

export interface Candidate {
  task_id: TaskId;
  rank: Rank;
  role: Role;
  blocking: number;
  prefer_agent: string | null;
  session: string | null;
}

const RANK_ROLE: Record<Rank, Role> = {
  resume: "worker",
  READY_WORK_REVIEW: "reviewer",
  READY_WORK_STARTED: "worker",
  READY_WORK_FRESH: "worker",
  READY_PLAN_REVIEW: "reviewer",
  READY_PLAN_STARTED: "planner",
  READY_PLAN_FRESH: "planner",
};

function rankOf(task: TaskMeta, resumable: Set<TaskId>): Rank | null {
  if (resumable.has(task.id)) {
    return "resume";
  }
  if (task.state === "READY_WORK_REVIEW") {
    return "READY_WORK_REVIEW";
  }
  if (task.state === "READY_WORK") {
    return task.workspace === null ? "READY_WORK_FRESH" : "READY_WORK_STARTED";
  }
  if (task.state === "READY_PLAN_REVIEW") {
    return "READY_PLAN_REVIEW";
  }
  if (task.state === "READY_PLAN") {
    return task.workspace === null ? "READY_PLAN_FRESH" : "READY_PLAN_STARTED";
  }
  return null;
}

export function candidates(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
): Candidate[] {
  const blocking = blockingCounts(tasks);
  const found: Candidate[] = [];

  for (const [id, task] of tasks) {
    const rank = rankOf(task, resumable);
    if (rank === null) {
      continue;
    }
    found.push({
      task_id: id,
      rank,
      role: RANK_ROLE[rank],
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

export function pickSlot(
  free: AgentSlot[],
  candidate: Candidate,
  isTop: boolean,
): AgentSlot | null {
  const eligible = free.filter((slot) => slot.roles.includes(candidate.role));
  if (eligible.length === 0) {
    return null;
  }
  if (candidate.prefer_agent === null) {
    return eligible[0]!;
  }

  const wanted = agentModelKey(candidate.prefer_agent);
  const same = eligible.find((slot) => agentModelKey(slot.name) === wanted);
  if (same !== undefined) {
    return same;
  }

  return candidate.rank === "resume" && !isTop ? null : eligible[0]!;
}

export interface Dispatch {
  candidate: Candidate;
  slot: AgentSlot;
}

export function plan(
  tasks: Map<TaskId, TaskMeta>,
  resumable: Set<TaskId>,
  free: AgentSlot[],
): Dispatch[] {
  const remaining = [...free];
  const dispatches: Dispatch[] = [];

  candidates(tasks, resumable).forEach((candidate, index) => {
    const slot = pickSlot(remaining, candidate, index === 0);
    if (slot === null) {
      return;
    }
    remaining.splice(remaining.indexOf(slot), 1);
    dispatches.push({ candidate, slot });
  });

  return dispatches;
}
