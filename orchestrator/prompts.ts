import fs from "node:fs";
import path from "node:path";
import { ROLE_STATE, type Role } from "./runtime.ts";
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
    fragment: (role) => `unreadable-result-${ROLE_STATE[role]}`,
    held: (detail) => `the agent never wrote a readable result: ${detail}`,
  },
  "no-result": {
    attempts: 4,
    fragment: (role) => `no-result-${ROLE_STATE[role]}`,
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
    fragment: (role) => `blocked-${ROLE_STATE[role]}`,
    held: (detail) => detail,
  },
};

export class Prompts {
  private readonly dirs: string[];

  constructor(orchestratorDir: string, overridesDir: string | null = null) {
    this.dirs =
      overridesDir === null
        ? [orchestratorDir]
        : [overridesDir, orchestratorDir];
  }

  systemPrompt(role: Role): string {
    return this.resolve("prompts", ROLE_STATE[role]);
  }

  fragment(name: string, vars: TemplateVars = {}): string {
    return this.read("prompts", name, vars);
  }

  issue(name: IssueName, role: Role, vars: TemplateVars = {}): string {
    return this.fragment(ISSUES[name].fragment(role), vars);
  }

  template(name: string, vars: TemplateVars = {}): string {
    return this.read("templates", name, vars);
  }

  private read(kind: string, name: string, vars: TemplateVars): string {
    return render(fs.readFileSync(this.resolve(kind, name), "utf-8"), vars);
  }

  private resolve(kind: string, name: string): string {
    const file = `${name}.md`;
    for (const dir of this.dirs) {
      const candidate = path.join(dir, kind, file);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(
      `no ${kind}/${file} in ${this.dirs.map((dir) => path.join(dir, kind)).join(" or ")}`,
    );
  }
}
