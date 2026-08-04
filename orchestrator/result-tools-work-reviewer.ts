import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  FINDING_GUIDELINE,
  TERMINAL_GUIDELINE,
  blocked,
  findings,
  verdict,
} from "./result-tools.ts";

const SubmitParams = z.object({
  findings,
  delegations: z
    .array(z.string().min(1))
    .describe(
      "defects outside this work, one per entry; an empty list means you found none",
    ),
});
type SubmitParams = z.infer<typeof SubmitParams>;

const submit = defineTool({
  name: "submit",
  label: "Submit",
  description:
    "Finish a work review and hand it in. Call it as your last action, with nothing after it. findings are the defects in the work — each becomes feedback, verbatim, and the work comes back to be redone; an empty list means you are satisfied. delegations are defects outside this work, recorded but not acted on here; pass an empty list when there are none.",
  promptSnippet: "End the review by calling submit",
  promptGuidelines: [
    FINDING_GUIDELINE,
    "Anything you would have fixed but must not belongs in delegations, not findings.",
    TERMINAL_GUIDELINE,
  ],
  parameters: z.toJSONSchema(SubmitParams) as never,
  async execute(_toolCallId, params: SubmitParams) {
    return {
      content: [{ type: "text", text: verdict(params.findings.length) }],
      details: { findings: params.findings, delegations: params.delegations },
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(submit);
  pi.registerTool(blocked);
}
