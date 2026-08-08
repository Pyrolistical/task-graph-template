import { type ClaimState, isReviewState } from "./state-machine.ts";

export const SUBMIT_TOOL = "submit";
export const BLOCKED_TOOL = "blocked";

export const RESULT_TOOLS = [SUBMIT_TOOL, BLOCKED_TOOL] as const;

export interface ResultCall {
  tool: string;
  args: Record<string, unknown>;
}

export type AgentResult =
  | { type: "blocked"; message: string }
  | { type: "submit"; findings: string[] };

export function resultFromCall(
  state: ClaimState,
  call: ResultCall,
): AgentResult {
  if (call.tool === BLOCKED_TOOL) {
    return { type: "blocked", message: call.args.message as string };
  }

  if (isReviewState(state)) {
    return { type: "submit", findings: call.args.findings as string[] };
  }

  return { type: "submit", findings: [] };
}
