import type { WorktreeStatus } from "../../domain/guard.ts";

export interface Workspaces {
  create(branch: string, worktree: string, base: string): void;
  remove(worktree: string): void;
  exists(worktree: string): boolean;
  branchExists(branch: string): boolean;
  deleteBranch(branch: string): void;
  head(worktree: string): string;
  resetTo(worktree: string, commit: string): void;
  status(worktree: string, base: string): WorktreeStatus;
  harvest(worktree: string, branch: string): void;
  syncBase(worktree: string, base: string): void;
  rebase(worktree: string, base: string): { code: number; stderr: string };
  abortRebase(worktree: string): void;
  fastForward(branch: string): { code: number; stderr: string };
  isAncestor(ref: string, of: string): boolean;
}
