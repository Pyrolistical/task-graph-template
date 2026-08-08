import fs from "node:fs";
import path from "node:path";
import * as git from "../adapters/git.ts";
import { tempDir } from "./temp-dirs.ts";

export const ORCHESTRATOR_DIR = path.join(import.meta.dir, "..");

export function tempRepo(): string {
  const repo = tempDir("orchestrator-repo-");
  git.gitOrThrow(repo, ["init", "-q", "-b", "master"]);
  git.gitOrThrow(repo, ["config", "user.email", "orchestrator@example.com"]);
  git.gitOrThrow(repo, ["config", "user.name", "orchestrator"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git.gitOrThrow(repo, ["add", "-A"]);
  git.gitOrThrow(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

export function commitIn(target: string, file: string, contents: string): void {
  fs.writeFileSync(path.join(target, file), contents);
  git.gitOrThrow(target, ["add", "-A"]);
  git.gitOrThrow(target, ["commit", "-q", "-m", `add ${file}`]);
}

export function shippedFile(name: string): string {
  return fs.readFileSync(path.join(ORCHESTRATOR_DIR, name), "utf-8");
}
