import type { ClaimState } from "./states.ts";

export const SUBMIT_TOOL = "submit";
export const BLOCKED_TOOL = "blocked";

export const RESULT_TOOLS = [SUBMIT_TOOL, BLOCKED_TOOL] as const;

export interface ResultCall {
  tool: string;
  args: Record<string, unknown>;
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

export function resultFromCall(
  state: ClaimState,
  call: ResultCall,
): AgentResult {
  if (call.tool === BLOCKED_TOOL) {
    return { type: "blocked", message: call.args.message as string };
  }

  if (state === "WORK_REVIEW") {
    return {
      type: "submit",
      findings: call.args.findings as string[],
      delegations: call.args.delegations as string[],
    };
  }

  if (state === "DESIGN_REVIEW" || state === "PLAN_REVIEW") {
    return { type: "submit", findings: call.args.findings as string[] };
  }

  return { type: "submit" };
}
