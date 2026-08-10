import fs from "node:fs/promises";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--git-dir"])).code === 0;
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await gitOrThrow(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function branchExists(
  repo: string,
  branch: string,
): Promise<boolean> {
  return (
    (
      await git(repo, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ])
    ).code === 0
  );
}

export async function identity(repo: string): Promise<[string, string][]> {
  const pairs: [string, string][] = [];
  for (const key of ["user.name", "user.email"]) {
    const result = await git(repo, ["config", "--get", key]);
    if (result.code === 0) {
      pairs.push([key, result.stdout.trim()]);
    }
  }
  return pairs;
}

export async function createWorkspace(
  repo: string,
  branch: string,
  worktree: string,
  base: string,
): Promise<void> {
  const existing = await branchExists(repo, branch);
  await gitOrThrow(repo, [
    "clone",
    "--quiet",
    "--shared",
    "--branch",
    existing ? branch : base,
    repo,
    worktree,
  ]);

  for (const [key, value] of await identity(repo)) {
    await gitOrThrow(worktree, ["config", key, value]);
  }

  if (!existing) {
    await gitOrThrow(worktree, ["checkout", "--quiet", "-b", branch]);
  }
}

export async function removeWorkspace(worktree: string): Promise<void> {
  await fs.rm(worktree, { recursive: true, force: true });
}

export async function head(worktree: string): Promise<string> {
  return (await gitOrThrow(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function resetTo(worktree: string, commit: string): Promise<void> {
  await gitOrThrow(worktree, ["reset", "--hard", "--quiet", commit]);
  await gitOrThrow(worktree, ["clean", "-q", "-f", "-d"]);
}

export async function commonDir(cwd: string): Promise<string> {
  return (
    await gitOrThrow(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  ).trim();
}

export async function sharesRefs(
  repo: string,
  worktree: string,
): Promise<boolean> {
  return (await commonDir(worktree)) === (await commonDir(repo));
}

export async function harvest(
  repo: string,
  worktree: string,
  branch: string,
): Promise<void> {
  if (await sharesRefs(repo, worktree)) {
    return;
  }
  await gitOrThrow(repo, [
    "fetch",
    "--quiet",
    "--force",
    worktree,
    `${branch}:${branch}`,
  ]);
}

export async function syncBase(worktree: string, base: string): Promise<void> {
  await gitOrThrow(worktree, [
    "fetch",
    "--quiet",
    "--force",
    "origin",
    `${base}:${base}`,
  ]);
}

export async function deleteBranch(
  repo: string,
  branch: string,
): Promise<void> {
  await gitOrThrow(repo, ["branch", "-D", branch]);
}

export async function isAncestor(
  repo: string,
  ref: string,
  of: string,
): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", ref, of])).code === 0;
}

export async function uncommitted(worktree: string): Promise<string[]> {
  return (await gitOrThrow(worktree, ["status", "--porcelain"]))
    .split("\n")
    .filter((line) => line.length > 0);
}

export async function commitCount(
  worktree: string,
  base: string,
): Promise<number> {
  return Number(
    (
      await gitOrThrow(worktree, [
        "rev-list",
        "--count",
        `refs/remotes/origin/${base}..HEAD`,
      ])
    ).trim(),
  );
}

export function rebase(worktree: string, onto: string): Promise<GitResult> {
  return git(worktree, ["rebase", onto]);
}

export async function abortRebase(worktree: string): Promise<void> {
  await git(worktree, ["rebase", "--abort"]);
}

export function mergeFastForward(
  repo: string,
  branch: string,
): Promise<GitResult> {
  return git(repo, ["merge", "--ff-only", branch]);
}
