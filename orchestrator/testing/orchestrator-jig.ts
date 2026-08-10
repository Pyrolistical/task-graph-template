import fs from "node:fs/promises";
import path from "node:path";
import * as git from "../adapters/git.ts";
import { tempDir } from "./temp-dirs.ts";

export const ORCHESTRATOR_DIR = path.join(import.meta.dir, "..");

export async function tempRepo(): Promise<string> {
  const repo = await tempDir("orchestrator-repo-");
  await git.gitOrThrow(repo, ["init", "-q", "-b", "master"]);
  await git.gitOrThrow(repo, [
    "config",
    "user.email",
    "orchestrator@example.com",
  ]);
  await git.gitOrThrow(repo, ["config", "user.name", "orchestrator"]);
  await fs.writeFile(path.join(repo, "a.txt"), "one\n");
  await git.gitOrThrow(repo, ["add", "-A"]);
  await git.gitOrThrow(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

export async function commitIn(
  target: string,
  file: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(path.join(target, file), contents);
  await git.gitOrThrow(target, ["add", "-A"]);
  await git.gitOrThrow(target, ["commit", "-q", "-m", `add ${file}`]);
}

export function shippedFile(name: string): Promise<string> {
  return fs.readFile(path.join(ORCHESTRATOR_DIR, name), "utf-8");
}
