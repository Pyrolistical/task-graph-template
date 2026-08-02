import fs from "node:fs";
import path from "node:path";
import { AGENT_STATES, type ClaimState } from "./runtime.ts";
import { type TemplateVars, render } from "./template.ts";

export const ISSUE_NAMES = [
  "unparsable-result",
  "missing-result",
  "incomplete-todos",
  "uncommitted",
  "looping",
  "blocked",
  "missing-plan",
  "invalid-remove-todo",
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
  "unparsable-result": {
    attempts: 4,
    states: ALL_AGENT_STATES,
    fragment: (state) => `unparsable-result-${state}`,
    held: (detail) => `the agent never wrote a readable result: ${detail}`,
  },
  "missing-result": {
    attempts: 4,
    states: ALL_AGENT_STATES,
    fragment: (state) => `missing-result-${state}`,
    held: () => "the agent stopped without setting a result",
  },
  "incomplete-todos": {
    attempts: 4,
    states: ["WORKING"],
    fragment: () => "incomplete-todos",
    held: (detail) => `the agent submitted with ${detail} todo(s) still open`,
  },
  uncommitted: {
    attempts: 4,
    states: ["WORKING"],
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
  "missing-plan": {
    attempts: 4,
    states: ["PLANNING"],
    fragment: () => "missing-plan",
    held: () => "the planner submitted a plan with no todos",
  },
  "invalid-remove-todo": {
    attempts: 4,
    states: ["PLANNING"],
    fragment: () => "invalid-remove-todo",
    held: (detail) =>
      `the planner named removeTodos indices that do not exist: ${detail}`,
  },
  "modified-worktree": {
    attempts: 4,
    states: ["PLANNING", "PLAN_REVIEWING"],
    fragment: (state) => `modified-worktree-${state}`,
    held: (detail) =>
      `the agent wrote to the worktree during planning: ${detail}`,
  },
};

const KINDS = ["prompts", "templates"] as const;

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
      for (const kind of KINDS) {
        const sub = path.join(dir, kind);
        if (!fs.existsSync(sub)) {
          continue;
        }
        for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) {
            continue;
          }
          const name = entry.name.slice(0, -3);
          const key = `${kind}/${name}`;
          if (this.cached.has(key)) {
            continue;
          }
          const filePath = path.join(sub, entry.name);
          this.cached.set(key, {
            path: filePath,
            contents: fs.readFileSync(filePath, "utf-8"),
          });
        }
      }
    }
    return this.cachedFiles();
  }

  systemPrompt(state: ClaimState): string {
    return this.file("prompts", state).path;
  }

  fragment(name: string, vars: TemplateVars = {}): string {
    return render(this.file("prompts", name).contents, vars);
  }

  issue(name: IssueName, state: ClaimState, vars: TemplateVars = {}): string {
    return this.fragment(ISSUES[name].fragment(state), vars);
  }

  template(state: ClaimState, vars: TemplateVars = {}): string {
    return render(this.file("templates", state).contents, vars);
  }

  cachedFiles(): string[] {
    return [...this.cached.values()].map((entry) => entry.path);
  }

  private file(kind: string, name: string): CachedFile {
    const entry = this.cached.get(`${kind}/${name}`);
    if (entry === undefined) {
      throw new Error(
        `no ${kind}/${name}.md in ${this.dirs.map((dir) => path.join(dir, kind)).join(" or ")}`,
      );
    }
    return entry;
  }
}
