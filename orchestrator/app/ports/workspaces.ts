import type { Awaitable } from "../../domain/awaitable.ts";
import type { WorktreeStatus } from "../../domain/guard.ts";

export interface Workspaces {
  create(branch: string, worktree: string, base: string): Awaitable<void>;
  remove(worktree: string): Awaitable<void>;
  exists(worktree: string): Awaitable<boolean>;
  branchExists(branch: string): Awaitable<boolean>;
  deleteBranch(branch: string): Awaitable<void>;
  head(worktree: string): Awaitable<string>;
  resetTo(worktree: string, commit: string): Awaitable<void>;
  status(worktree: string, base: string): Awaitable<WorktreeStatus>;
  harvest(worktree: string, branch: string): Awaitable<void>;
  syncBase(worktree: string, base: string): Awaitable<void>;
  rebase(
    worktree: string,
    base: string,
  ): Awaitable<{ code: number; stderr: string }>;
  abortRebase(worktree: string): Awaitable<void>;
  fastForward(branch: string): Awaitable<{ code: number; stderr: string }>;
  isAncestor(ref: string, of: string): Awaitable<boolean>;
}
