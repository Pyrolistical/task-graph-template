import {
  type ClaimState,
  type Guard,
  AGENT_STAGES,
  AGENT_STATES,
} from "./state-machine.ts";
import { type TemplateVars, render } from "./template.ts";

export const ISSUE_NAMES = [
  "missing-result",
  "missing-todos",
  "missing-design",
  "missing-notes",
  "modified-assignment",
  "uncommitted",
  "looping",
  "blocked",
  "modified-worktree",
] as const;

export type IssueName = (typeof ISSUE_NAMES)[number];

export interface Issue {
  attempts: number;
  states: ClaimState[];
  fragment: (state: ClaimState) => string;
  held: (detail: string) => string;
}

const ALL_AGENT_STATES: ClaimState[] = [...AGENT_STATES];

function guarding(guard: Guard): ClaimState[] {
  return AGENT_STAGES.filter((stage) => stage.guard === guard).map(
    (stage) => stage.state,
  );
}

function appending(missing: IssueName): ClaimState[] {
  return AGENT_STAGES.filter((stage) => stage.missing === missing).map(
    (stage) => stage.state,
  );
}

export const ISSUES: Record<IssueName, Issue> = {
  "missing-result": {
    attempts: 8,
    states: ALL_AGENT_STATES,
    fragment: (state) => `missing-result-${state}`,
    held: () => "the agent stopped without calling a submit or blocked tool",
  },
  "missing-todos": {
    attempts: 4,
    states: appending("missing-todos"),
    fragment: () => "missing-todos",
    held: () =>
      "the planner submitted without appending a todo list to the assignment",
  },
  "missing-design": {
    attempts: 4,
    states: appending("missing-design"),
    fragment: () => "missing-design",
    held: () =>
      "the designer submitted without appending a design section to the assignment",
  },
  "missing-notes": {
    attempts: 4,
    states: appending("missing-notes"),
    fragment: () => "missing-notes",
    held: () =>
      "the worker submitted without appending implementation notes to the assignment",
  },
  "modified-assignment": {
    attempts: 4,
    states: ALL_AGENT_STATES,
    fragment: (state) => `modified-assignment-${state}`,
    held: () =>
      "the agent changed parts of the assignment it may not; only the section it was instructed to write may be appended",
  },
  uncommitted: {
    attempts: 4,
    states: guarding("committed"),
    fragment: () => "uncommitted",
    held: (detail) => `the agent submitted work it never committed: ${detail}`,
  },
  looping: {
    attempts: 3,
    states: ALL_AGENT_STATES,
    fragment: (state) => `looping-${state}`,
    held: (detail) => `the agent kept repeating one command: ${detail}`,
  },
  blocked: {
    attempts: 1,
    states: ALL_AGENT_STATES,
    fragment: (state) => `blocked-${state}`,
    held: (detail) => detail,
  },
  "modified-worktree": {
    attempts: 4,
    states: guarding("untouched"),
    fragment: (state) => `modified-worktree-${state}`,
    held: (detail) =>
      `the agent wrote to the worktree during design or planning: ${detail}`,
  },
};
