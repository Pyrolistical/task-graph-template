import type { Workspaces } from "../app/ports/workspaces.ts";
import type { WorktreeStatus } from "../domain/guard.ts";
import { exists } from "./files.ts";
import * as git from "./git.ts";

export class GitWorkspaces implements Workspaces {
  constructor(private readonly repo: string) {}

  async create(branch: string, worktree: string, base: string): Promise<void> {
    await git.createWorkspace(this.repo, branch, worktree, base);
  }

  async remove(worktree: string): Promise<void> {
    await git.removeWorkspace(worktree);
  }

  exists(worktree: string): Promise<boolean> {
    return exists(worktree);
  }

  branchExists(branch: string): Promise<boolean> {
    return git.branchExists(this.repo, branch);
  }

  async deleteBranch(branch: string): Promise<void> {
    await git.deleteBranch(this.repo, branch);
  }

  head(worktree: string): Promise<string> {
    return git.head(worktree);
  }

  async resetTo(worktree: string, commit: string): Promise<void> {
    await git.resetTo(worktree, commit);
  }

  async status(worktree: string, base: string): Promise<WorktreeStatus> {
    return {
      dirty: await git.uncommitted(worktree),
      commits: await git.commitCount(worktree, base),
    };
  }

  async harvest(worktree: string, branch: string): Promise<void> {
    await git.harvest(this.repo, worktree, branch);
  }

  async syncBase(worktree: string, base: string): Promise<void> {
    await git.syncBase(worktree, base);
  }

  rebase(
    worktree: string,
    base: string,
  ): Promise<{ code: number; stderr: string }> {
    return git.rebase(worktree, base);
  }

  async abortRebase(worktree: string): Promise<void> {
    await git.abortRebase(worktree);
  }

  fastForward(branch: string): Promise<{ code: number; stderr: string }> {
    return git.mergeFastForward(this.repo, branch);
  }

  isAncestor(ref: string, of: string): Promise<boolean> {
    return git.isAncestor(this.repo, ref, of);
  }
}
