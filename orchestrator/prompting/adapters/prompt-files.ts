import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { hasCode } from "../../kernel/domain/errors.ts";
import type { ClaimState } from "../../vocabulary/state-machine.ts";
import { type IssueName, ISSUES } from "../domain/issues.ts";
import { type FragmentVars, render } from "../domain/fragment.ts";

interface CachedFile {
  path: string;
  contents: string;
}

export class PromptFiles {
  private readonly dirs: string[];
  private readonly cached = new Map<string, CachedFile>();

  private constructor(dirs: string[]) {
    this.dirs = dirs;
  }

  static async open(
    orchestratorDir: string,
    overridesDir?: string,
  ): Promise<PromptFiles> {
    const dirs = !overridesDir
      ? [orchestratorDir]
      : [overridesDir, orchestratorDir];
    const prompts = new PromptFiles(dirs);
    await prompts.reload();
    return prompts;
  }

  async reload(): Promise<string[]> {
    this.cached.clear();
    for (const dir of this.dirs) {
      const sub = path.join(dir, "prompts");
      let entries: Dirent[];
      try {
        entries = await fs.readdir(sub, { withFileTypes: true });
      } catch (err) {
        if (!hasCode(err, "ENOENT")) {
          throw err;
        }
        continue;
      }
      for (const entry of entries) {
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
          contents: await fs.readFile(filePath, "utf-8"),
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
    if (!entry) {
      throw new Error(
        `no prompts/${name}.md in ${this.dirs.map((dir) => path.join(dir, "prompts")).join(" or ")}`,
      );
    }
    return entry;
  }
}
