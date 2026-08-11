import type { Guard } from "./state-machine.ts";
import type { FragmentVars } from "./fragment.ts";

export const STATUS_SHOWN_LINES = 20;

export interface WorktreeStatus {
  dirty: string[];
  commits: number;
}

export function statusOf(dirty: string[], lines = STATUS_SHOWN_LINES): string {
  if (dirty.length <= lines) {
    return dirty.join("\n");
  }
  return [...dirty.slice(0, lines), `… and ${dirty.length - lines} more`].join(
    "\n",
  );
}

export type WorktreeIssue =
  | { name: "uncommitted"; dirty: string[]; empty: boolean }
  | {
      name: "modified-worktree";
      dirty: string[];
      commits: number;
      base: string;
    };

function joined(parts: (string | undefined)[]): string {
  return parts.filter((part) => part).join("; ");
}

function dirtyDetail(dirty: string[]): string | undefined {
  return dirty.length === 0 ? undefined : `${dirty.length} uncommitted file(s)`;
}

export function detailOf(issue: WorktreeIssue): string {
  switch (issue.name) {
    case "uncommitted": {
      return joined([
        issue.empty ? "nothing is committed on the branch" : undefined,
        dirtyDetail(issue.dirty),
      ]);
    }
    case "modified-worktree": {
      return joined([
        issue.commits === 0
          ? undefined
          : `${issue.commits} commit(s) on the branch`,
        dirtyDetail(issue.dirty),
      ]);
    }
  }
}

function dirtyVar(dirty: string[]): Record<string, string>[] {
  return dirty.length === 0 ? [] : [{ status: statusOf(dirty) }];
}

export function varsOf(issue: WorktreeIssue): FragmentVars {
  switch (issue.name) {
    case "uncommitted": {
      return {
        empty: issue.empty ? [{}] : [],
        dirty: dirtyVar(issue.dirty),
      };
    }
    case "modified-worktree": {
      return {
        commits: issue.commits === 0 ? [] : [{}],
        dirty: dirtyVar(issue.dirty),
        base: issue.base,
      };
    }
  }
}

export function worktreeIssue(
  guard: Guard,
  status: WorktreeStatus,
  base: string,
): WorktreeIssue | undefined {
  const { dirty, commits } = status;

  switch (guard) {
    case "none": {
      return undefined;
    }
    case "untouched": {
      if (dirty.length === 0 && commits === 0) {
        return undefined;
      }
      return { name: "modified-worktree", dirty, commits, base };
    }
    case "committed": {
      if (dirty.length === 0 && commits > 0) {
        return undefined;
      }
      return { name: "uncommitted", dirty, empty: commits === 0 };
    }
  }
}
