import fs from "node:fs";
import path from "node:path";
import { AGENT_STATES, type ClaimState } from "./states.ts";
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

export const ISSUES: Record<IssueName, Issue> = {
  "missing-result": {
    attempts: 4,
    states: ALL_AGENT_STATES,
    fragment: (state) => `missing-result-${state}`,
    held: () => "the agent stopped without calling a submit or blocked tool",
  },
  "missing-todos": {
    attempts: 4,
    states: ["PLAN"],
    fragment: () => "missing-todos",
    held: () =>
      "the planner submitted without appending a todo list to the assignment",
  },
  "missing-design": {
    attempts: 4,
    states: ["DESIGN"],
    fragment: () => "missing-design",
    held: () =>
      "the designer submitted without appending a design section to the assignment",
  },
  "missing-notes": {
    attempts: 4,
    states: ["WORK"],
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
    states: ["WORK"],
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
    states: ["DESIGN", "DESIGN_REVIEW", "PLAN", "PLAN_REVIEW"],
    fragment: (state) => `modified-worktree-${state}`,
    held: (detail) =>
      `the agent wrote to the worktree during design or planning: ${detail}`,
  },
};

interface CachedFile {
  path: string;
  contents: string;
}

export class Prompts {
  private readonly dirs: string[];
  private readonly cached = new Map<string, CachedFile>();

  constructor(orchestratorDir: string, overridesDir: string | null = null) {
    this.dirs =
      overridesDir === null
        ? [orchestratorDir]
        : [overridesDir, orchestratorDir];
    this.reload();
  }

  reload(): string[] {
    this.cached.clear();
    for (const dir of this.dirs) {
      const sub = path.join(dir, "prompts");
      if (!fs.existsSync(sub)) {
        continue;
      }
      for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }
        const name = entry.name.slice(0, -3);
        if (this.cached.has(name)) {
          continue;
        }
        const filePath = path.join(sub, entry.name);
        this.cached.set(name, {
          path: filePath,
          contents: fs.readFileSync(filePath, "utf-8"),
        });
      }
    }
    return this.cachedFiles();
  }

  fragment(name: string, vars: TemplateVars = {}): string {
    return render(this.file(name).contents, vars);
  }

  issue(name: IssueName, state: ClaimState, vars: TemplateVars = {}): string {
    return this.fragment(ISSUES[name].fragment(state), vars);
  }

  cachedFiles(): string[] {
    return [...this.cached.values()].map((entry) => entry.path);
  }

  private file(name: string): CachedFile {
    const entry = this.cached.get(name);
    if (entry === undefined) {
      throw new Error(
        `no prompts/${name}.md in ${this.dirs.map((dir) => path.join(dir, "prompts")).join(" or ")}`,
      );
    }
    return entry;
  }
}
