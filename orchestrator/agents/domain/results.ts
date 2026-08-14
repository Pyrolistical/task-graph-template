import { memberOf } from "../../kernel/domain/lookup.ts";
import {
  type ClaimState,
  isReviewState,
  requireText,
  requireTexts,
} from "../../vocabulary/state-machine.ts";

export const SUBMIT_TOOL = "submit";
export const BLOCKED_TOOL = "blocked";

export const RESULT_TOOLS = [SUBMIT_TOOL, BLOCKED_TOOL] as const;

export const isResultTool = memberOf(RESULT_TOOLS);

export interface ResultCall {
  tool: string;
  args: Record<string, unknown>;
}

export type AgentResult =
  { type: "blocked"; message: string } | { type: "submit"; findings: string[] };

export function resultFromCall(
  state: ClaimState,
  call: ResultCall,
): AgentResult {
  if (call.tool === BLOCKED_TOOL) {
    return {
      type: "blocked",
      message: requireText(call.args.message, "message"),
    };
  }

  if (isReviewState(state)) {
    return {
      type: "submit",
      findings: requireTexts(call.args.findings, "findings"),
    };
  }

  return { type: "submit", findings: [] };
}
