import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const SubmitParams = z.object({
  findings: z
    .array(z.string().min(1))
    .describe(
      "the gaps or defects you found, one per entry; an empty list means you are satisfied",
    ),
  delegations: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "defects outside this work, one per entry; a work review only, never a plan review",
    ),
});
type SubmitParams = z.infer<typeof SubmitParams>;

const submit = defineTool({
  name: "submit",
  label: "Submit",
  description:
    "Finish a review and hand it in. Call it as your last action, with nothing after it. findings are the gaps between the plan and the acceptance criteria, or the defects in the work — each becomes feedback, verbatim, and the work comes back to be redone; an empty list means you are satisfied. delegations are defects outside this work: they go to the manager, who decides whether they become tasks.",
  promptSnippet: "End the review by calling submit",
  promptGuidelines: [
    "A finding is a description, not an instruction: name the symbol, the file and the input that breaks it, say what goes wrong, and stop there.",
    "Anything you would have fixed but must not belongs in delegations, not findings.",
    "submit and blocked are terminal: after either one, make no further tool calls in the turn.",
  ],
  parameters: z.toJSONSchema(SubmitParams) as never,
  async execute(_toolCallId, params: SubmitParams) {
    const delegations = params.delegations ?? [];
    return {
      content: [
        {
          type: "text",
          text:
            params.findings.length === 0
              ? "Work accepted."
              : `Work rejected with ${params.findings.length} finding(s).`,
        },
      ],
      details: { findings: params.findings, delegations },
      terminate: true,
    };
  },
});

const blocked = defineTool({
  name: "blocked",
  label: "Blocked",
  description:
    "Stop because the one thing in your way is a wall you cannot get past without a decision or an access you do not have. A person reads your message and unblocks you.",
  promptSnippet: "Stop on a wall by calling blocked",
  promptGuidelines: [
    "Call blocked only when you genuinely cannot proceed; a submit you can still make is not a wall.",
    "submit and blocked are terminal: after either one, make no further tool calls in the turn.",
  ],
  parameters: z.toJSONSchema(
    z.object({
      message: z
        .string()
        .min(1)
        .describe(
          "the one thing that stands in the way; a person reads it and unblocks you",
        ),
    }),
  ) as never,
  async execute(_toolCallId, params: { message: string }) {
    return {
      content: [{ type: "text", text: "Stopped: awaiting a person." }],
      details: { message: params.message },
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(submit);
  pi.registerTool(blocked);
}
