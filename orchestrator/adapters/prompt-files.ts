import fs from "node:fs";
import path from "node:path";
import type { ClaimState } from "../domain/state-machine.ts";
import { type IssueName, ISSUES } from "../domain/issues.ts";
import { type FragmentVars, render } from "../domain/fragment.ts";

interface CachedFile {
  path: string;
  contents: string;
}

export class PromptFiles {
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

  fragment(name: string, vars: FragmentVars = {}): string {
    return render(this.file(name).contents, vars);
  }

  issue(name: IssueName, state: ClaimState, vars: FragmentVars = {}): string {
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
