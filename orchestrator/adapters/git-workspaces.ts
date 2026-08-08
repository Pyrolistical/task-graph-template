import fs from "node:fs";
import type { Workspaces } from "../app/ports/workspaces.ts";
import type { WorktreeStatus } from "../domain/guard.ts";
import * as git from "./git.ts";

export class GitWorkspaces implements Workspaces {
  constructor(private readonly repo: string) {}

  create(branch: string, worktree: string, base: string): void {
    git.createWorkspace(this.repo, branch, worktree, base);
  }

  remove(worktree: string): void {
    git.removeWorkspace(worktree);
  }

  exists(worktree: string): boolean {
    return fs.existsSync(worktree);
  }

  branchExists(branch: string): boolean {
    return git.branchExists(this.repo, branch);
  }

  deleteBranch(branch: string): void {
    git.deleteBranch(this.repo, branch);
  }

  head(worktree: string): string {
    return git.head(worktree);
  }

  resetTo(worktree: string, commit: string): void {
    git.resetTo(worktree, commit);
  }

  status(worktree: string, base: string): WorktreeStatus {
    return {
      dirty: git.uncommitted(worktree),
      commits: git.commitCount(worktree, base),
    };
  }

  harvest(worktree: string, branch: string): void {
    git.harvest(this.repo, worktree, branch);
  }

  syncBase(worktree: string, base: string): void {
    git.syncBase(worktree, base);
  }

  rebase(worktree: string, base: string): { code: number; stderr: string } {
    return git.rebase(worktree, base);
  }

  abortRebase(worktree: string): void {
    git.abortRebase(worktree);
  }

  fastForward(branch: string): { code: number; stderr: string } {
    return git.mergeFastForward(this.repo, branch);
  }

  isAncestor(ref: string, of: string): boolean {
    return git.isAncestor(this.repo, ref, of);
  }
}
