import type { ClaimState } from "./runtime.ts";

export const SUBMIT_TOOL = "submit";
export const BLOCKED_TOOL = "blocked";

export const RESULT_TOOLS = [SUBMIT_TOOL, BLOCKED_TOOL] as const;

export interface ResultCall {
  tool: string;
  args: Record<string, unknown>;
}

export class ResultError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "ResultError";
    this.issues = issues;
  }
}

export interface SubmitResult {
  type: "submit";
}

export interface BlockedResult {
  type: "blocked";
  message: string;
}

export interface PlanReviewSubmit {
  type: "submit";
  findings: string[];
}

export interface WorkReviewSubmit {
  type: "submit";
  findings: string[];
  delegations: string[];
}

export type PlanResults = SubmitResult | BlockedResult;
export type PlanReviewResults = PlanReviewSubmit | BlockedResult;
export type WorkResult = SubmitResult | BlockedResult;
export type WorkReviewResults = WorkReviewSubmit | BlockedResult;

export type AgentResult =
  PlanResults | PlanReviewResults | WorkResult | WorkReviewResults;

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ResultError([`${label} must be a non-empty string`]);
  }
  return value;
}

function requireTextList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ResultError([`${label} must be a list of non-empty strings`]);
  }
  const issues: string[] = [];
  const list = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(`${label}[${index}] must be a non-empty string`);
    }
    return entry;
  });
  if (issues.length > 0) {
    throw new ResultError(issues);
  }
  return list;
}

function emptyOrNone(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

export function resultFromCall(
  state: ClaimState,
  call: ResultCall,
): AgentResult {
  if (!RESULT_TOOLS.includes(call.tool as (typeof RESULT_TOOLS)[number])) {
    throw new ResultError([
      `the result must come from the ${RESULT_TOOLS.join(" or ")} tool, not ${call.tool}`,
    ]);
  }

  switch (call.tool) {
    case BLOCKED_TOOL:
      return {
        type: "blocked",
        message: requireText(call.args.message, "message"),
      };
    case SUBMIT_TOOL:
      if (state === "PLAN_REVIEWING") {
        if (!emptyOrNone(call.args.delegations)) {
          throw new ResultError(["a plan review cannot carry delegations"]);
        }
        return {
          type: "submit",
          findings: requireTextList(call.args.findings, "findings"),
        };
      }
      if (state === "WORK_REVIEWING") {
        return {
          type: "submit",
          findings: requireTextList(call.args.findings, "findings"),
          delegations: requireTextList(call.args.delegations, "delegations"),
        };
      }
      {
        const issues: string[] = [];
        if (!emptyOrNone(call.args.findings)) {
          issues.push("a plain submit cannot carry findings");
        }
        if (!emptyOrNone(call.args.delegations)) {
          issues.push("a plain submit cannot carry delegations");
        }
        if (issues.length > 0) {
          throw new ResultError(issues);
        }
        return { type: "submit" };
      }
    default:
      throw new ResultError([`unexpected result tool ${call.tool}`]);
  }
}
