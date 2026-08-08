import { type ClaimState } from "./state-machine.ts";

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
  fragment: (state: ClaimState) => string;
  held: (detail: string) => string;
}

export const ISSUES: Record<IssueName, Issue> = {
  "missing-result": {
    attempts: 8,
    fragment: () => "missing-result",
    held: () => "the agent stopped without calling a submit or blocked tool",
  },
  "missing-todos": {
    attempts: 4,
    fragment: () => "missing-todos",
    held: () =>
      "the planner submitted without appending a todo list to the assignment",
  },
  "missing-design": {
    attempts: 4,
    fragment: () => "missing-design",
    held: () =>
      "the designer submitted without appending a design section to the assignment",
  },
  "missing-notes": {
    attempts: 4,
    fragment: () => "missing-notes",
    held: () =>
      "the worker submitted without appending implementation notes to the assignment",
  },
  "modified-assignment": {
    attempts: 4,
    fragment: (state) => `modified-assignment-${state}`,
    held: () =>
      "the agent changed parts of the assignment it may not; only the section it was instructed to write may be appended",
  },
  uncommitted: {
    attempts: 4,
    fragment: () => "uncommitted",
    held: (detail) => `the agent submitted work it never committed: ${detail}`,
  },
  looping: {
    attempts: 3,
    fragment: () => "looping",
    held: (detail) => `the agent kept repeating one command: ${detail}`,
  },
  blocked: {
    attempts: 1,
    fragment: () => "blocked",
    held: (detail) => detail,
  },
  "modified-worktree": {
    attempts: 4,
    fragment: () => "modified-worktree",
    held: (detail) =>
      `the agent wrote to the worktree during design or planning: ${detail}`,
  },
};
