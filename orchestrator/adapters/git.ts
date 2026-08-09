import fs from "node:fs";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export function gitOrThrow(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--git-dir"]).code === 0;
}

export function defaultBranch(repo: string): string {
  return gitOrThrow(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export function branchExists(repo: string, branch: string): boolean {
  return (
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
      .code === 0
  );
}

export function identity(repo: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const key of ["user.name", "user.email"]) {
    const result = git(repo, ["config", "--get", key]);
    if (result.code === 0) {
      pairs.push([key, result.stdout.trim()]);
    }
  }
  return pairs;
}

export function createWorkspace(
  repo: string,
  branch: string,
  worktree: string,
  base: string,
): void {
  const existing = branchExists(repo, branch);
  gitOrThrow(repo, [
    "clone",
    "--quiet",
    "--shared",
    "--branch",
    existing ? branch : base,
    repo,
    worktree,
  ]);

  for (const [key, value] of identity(repo)) {
    gitOrThrow(worktree, ["config", key, value]);
  }

  if (!existing) {
    gitOrThrow(worktree, ["checkout", "--quiet", "-b", branch]);
  }
}

export function removeWorkspace(worktree: string): void {
  fs.rmSync(worktree, { recursive: true, force: true });
}

export function head(worktree: string): string {
  return gitOrThrow(worktree, ["rev-parse", "HEAD"]).trim();
}

export function resetTo(worktree: string, commit: string): void {
  gitOrThrow(worktree, ["reset", "--hard", "--quiet", commit]);
  gitOrThrow(worktree, ["clean", "-q", "-f", "-d"]);
}

export function commonDir(cwd: string): string {
  return gitOrThrow(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
}

export function sharesRefs(repo: string, worktree: string): boolean {
  return commonDir(worktree) === commonDir(repo);
}

export function harvest(repo: string, worktree: string, branch: string): void {
  if (sharesRefs(repo, worktree)) {
    return;
  }
  gitOrThrow(repo, [
    "fetch",
    "--quiet",
    "--force",
    worktree,
    `${branch}:${branch}`,
  ]);
}

export function syncBase(worktree: string, base: string): void {
  gitOrThrow(worktree, [
    "fetch",
    "--quiet",
    "--force",
    "origin",
    `${base}:${base}`,
  ]);
}

export function deleteBranch(repo: string, branch: string): void {
  gitOrThrow(repo, ["branch", "-D", branch]);
}

export function isAncestor(repo: string, ref: string, of: string): boolean {
  return git(repo, ["merge-base", "--is-ancestor", ref, of]).code === 0;
}

export function uncommitted(worktree: string): string[] {
  return gitOrThrow(worktree, ["status", "--porcelain"])
    .split("\n")
    .filter((line) => line.length > 0);
}

export function commitCount(worktree: string, base: string): number {
  return Number(
    gitOrThrow(worktree, [
      "rev-list",
      "--count",
      `refs/remotes/origin/${base}..HEAD`,
    ]).trim(),
  );
}

export function rebase(worktree: string, onto: string): GitResult {
  return git(worktree, ["rebase", onto]);
}

export function abortRebase(worktree: string): void {
  git(worktree, ["rebase", "--abort"]);
}

export function mergeFastForward(repo: string, branch: string): GitResult {
  return git(repo, ["merge", "--ff-only", branch]);
}
