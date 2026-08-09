import fs from "node:fs";
import path from "node:path";
import * as git from "../adapters/git.ts";
import { tempDir } from "./temp-dirs.ts";

export const ORCHESTRATOR_DIR = path.join(import.meta.dir, "..");

export async function tempRepo(): Promise<string> {
  const repo = await tempDir("orchestrator-repo-");
  git.gitOrThrow(repo, ["init", "-q", "-b", "master"]);
  git.gitOrThrow(repo, ["config", "user.email", "orchestrator@example.com"]);
  git.gitOrThrow(repo, ["config", "user.name", "orchestrator"]);
  await fs.promises.writeFile(path.join(repo, "a.txt"), "one\n");
  git.gitOrThrow(repo, ["add", "-A"]);
  git.gitOrThrow(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

export async function commitIn(
  target: string,
  file: string,
  contents: string,
): Promise<void> {
  await fs.promises.writeFile(path.join(target, file), contents);
  git.gitOrThrow(target, ["add", "-A"]);
  git.gitOrThrow(target, ["commit", "-q", "-m", `add ${file}`]);
}

export function shippedFile(name: string): Promise<string> {
  return fs.promises.readFile(path.join(ORCHESTRATOR_DIR, name), "utf-8");
}
