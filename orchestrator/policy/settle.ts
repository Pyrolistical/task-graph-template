import type { AssignmentDiff } from "../domain/assignment.ts";
import {
  type WorktreeStatus,
  detailOf,
  varsOf,
  worktreeIssue,
} from "../domain/guard.ts";
import type { IssueName } from "../domain/issues.ts";
import { type StopReason, LOOP_LIMIT } from "../domain/protocol.ts";
import { type ResultCall, resultFromCall } from "../domain/results.ts";
import { type ClaimState, STAGE_OF } from "../domain/state-machine.ts";
import type { FragmentVars } from "../domain/fragment.ts";

export interface Settlement {
  state: ClaimState;
  alive: boolean;
  stopReason?: StopReason;
  looping?: string;
  calls: ResultCall[];
  diff: AssignmentDiff;
  worktree: WorktreeStatus;
  base: string;
}

export type Intent =
  | { kind: "abandon" }
  | { kind: "back-off" }
  | { kind: "raise"; issue: IssueName; detail: string; vars: FragmentVars }
  | { kind: "restore"; section?: string }
  | { kind: "feedback"; findings: string[] }
  | { kind: "submit"; body: boolean };

export function decideSettle(settled: Settlement): Intent[] {
  if (!settled.alive) {
    return [{ kind: "abandon" }];
  }
  if (settled.stopReason === "error") {
    return [{ kind: "back-off" }];
  }
  if (settled.looping) {
    return [
      {
        kind: "raise",
        issue: "looping",
        detail: settled.looping,
        vars: { command: settled.looping, limit: LOOP_LIMIT },
      },
    ];
  }
  if (settled.stopReason === "aborted") {
    return [{ kind: "abandon" }];
  }

  const last = settled.calls[settled.calls.length - 1];
  if (settled.stopReason === "length" || !last) {
    return [raise("missing-result")];
  }

  const result = resultFromCall(settled.state, last);
  if (result.type === "blocked") {
    return [raise("blocked", result.message)];
  }

  const stage = STAGE_OF[settled.state];

  if (!stage.section) {
    if (settled.diff !== "unchanged") {
      return [{ kind: "restore" }, raise("modified-assignment")];
    }
  } else if (settled.diff === "unchanged") {
    return [raise(stage.missing)];
  } else if (settled.diff === "modified") {
    return [
      { kind: "restore", section: stage.section },
      raise("modified-assignment"),
    ];
  }

  const broken = worktreeIssue(stage.guard, settled.worktree, settled.base);
  if (broken) {
    return [raise(broken.name, detailOf(broken), varsOf(broken))];
  }

  if (result.findings.length > 0) {
    return [{ kind: "feedback", findings: result.findings }];
  }

  return [{ kind: "submit", body: stage.body }];
}

function raise(issue: IssueName, detail = "", vars: FragmentVars = {}): Intent {
  return { kind: "raise", issue, detail, vars };
}
