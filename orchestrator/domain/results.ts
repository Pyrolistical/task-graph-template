import type { ClaimState } from "./state-machine.ts";

export const SUBMIT_TOOL = "submit";
export const BLOCKED_TOOL = "blocked";

export const RESULT_TOOLS = [SUBMIT_TOOL, BLOCKED_TOOL] as const;

export interface ResultCall {
  tool: string;
  args: Record<string, unknown>;
}

export type AgentResult =
  | { type: "blocked"; message: string }
  | { type: "submit"; findings: string[]; delegations: string[] };

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
    return {
      type: "submit",
      findings: call.args.findings as string[],
      delegations: [],
    };
  }

  return { type: "submit", findings: [], delegations: [] };
}
