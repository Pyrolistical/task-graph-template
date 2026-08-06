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

export function identity(repo: string): string[] {
  return ["user.name", "user.email"].flatMap((key) => {
    const result = git(repo, ["config", "--get", key]);
    return result.code === 0 ? [key, result.stdout.trim()] : [];
  });
}

export function addWorkspace(
  repo: string,
  branch: string,
  target: string,
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
    target,
  ]);

  const inherited = identity(repo);
  for (let at = 0; at < inherited.length; at += 2) {
    gitOrThrow(target, ["config", inherited[at]!, inherited[at + 1]!]);
  }

  if (!existing) {
    gitOrThrow(target, ["checkout", "--quiet", "-b", branch]);
  }
}

export function removeWorkspace(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
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

export function sharesRefs(repo: string, target: string): boolean {
  return commonDir(target) === commonDir(repo);
}

export function harvest(repo: string, target: string, branch: string): void {
  if (sharesRefs(repo, target)) {
    return;
  }
  gitOrThrow(repo, [
    "fetch",
    "--quiet",
    "--force",
    target,
    `${branch}:${branch}`,
  ]);
}

export function syncBase(target: string, base: string): void {
  gitOrThrow(target, [
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
