import fs from "node:fs";
import path from "node:path";
import type { Role } from "./runtime.ts";
import { type TemplateVars, render } from "./template.ts";

export const ISSUE_NAMES = [
  "unreadable-result",
  "no-result",
  "open-todos",
  "uncommitted",
  "looping",
  "blocked",
] as const;

export type IssueName = (typeof ISSUE_NAMES)[number];

export interface Issue {
  attempts: number;
  fragment: (role: Role) => string;
  held: (detail: string) => string;
}

export const ISSUES: Record<IssueName, Issue> = {
  "unreadable-result": {
    attempts: 4,
    fragment: (role) => `unreadable-result-${role}`,
    held: (detail) => `the agent never wrote a readable result: ${detail}`,
  },
  "no-result": {
    attempts: 4,
    fragment: (role) => `no-result-${role}`,
    held: () => "the agent stopped without setting a result",
  },
  "open-todos": {
    attempts: 4,
    fragment: () => "open-todos",
    held: (detail) => `the agent submitted with ${detail} todo(s) still open`,
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
    fragment: (role) => `blocked-${role}`,
    held: (detail) => detail,
  },
};

export class Prompts {
  private readonly dir: string;

  constructor(orchestratorDir: string) {
    this.dir = path.join(orchestratorDir, "prompts");
  }

  systemPrompt(role: Role): string {
    return path.join(this.dir, `${role}.md`);
  }

  fragment(name: string, vars: TemplateVars = {}): string {
    return render(
      fs.readFileSync(path.join(this.dir, `${name}.md`), "utf-8"),
      vars,
    );
  }

  issue(name: IssueName, role: Role, vars: TemplateVars = {}): string {
    return this.fragment(ISSUES[name].fragment(role), vars);
  }
}
