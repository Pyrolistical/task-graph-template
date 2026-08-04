import { defineTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const TERMINAL_GUIDELINE =
  "submit and blocked are terminal: after either one, make no further tool calls in the turn.";

export const FINDING_GUIDELINE =
  "A finding is a description, not an instruction: name the symbol, the file and the input that breaks it, say what goes wrong, and stop there.";

export const findings = z
  .array(z.string().min(1))
  .describe(
    "the gaps or defects you found, one per entry; an empty list means you are satisfied",
  );

const NoParams = z.object({});
type NoParams = z.infer<typeof NoParams>;

const FindingsParams = z.object({ findings });
type FindingsParams = z.infer<typeof FindingsParams>;

export function verdict(found: number): string {
  return found === 0
    ? "Work accepted."
    : `Work rejected with ${found} finding(s).`;
}

export function findingsSubmit(what: string) {
  return defineTool({
    name: "submit",
    label: "Submit",
    description: `Finish a ${what} review and hand it in. Call it as your last action, with nothing after it. findings are the gaps between the ${what} and the acceptance criteria — each becomes feedback, verbatim, and the ${what} comes back to be redone; an empty list means you are satisfied.`,
    promptSnippet: "End the review by calling submit",
    promptGuidelines: [FINDING_GUIDELINE, TERMINAL_GUIDELINE],
    parameters: z.toJSONSchema(FindingsParams) as never,
    async execute(_toolCallId, params: FindingsParams) {
      return {
        content: [{ type: "text", text: verdict(params.findings.length) }],
        details: { findings: params.findings },
        terminate: true,
      };
    },
  });
}

export function plainSubmit(finish: string, noun: string) {
  return defineTool({
    name: "submit",
    label: "Submit",
    description: `Finish ${finish}. Call it as your last action, with nothing after it.`,
    promptSnippet: "End the task by calling submit",
    promptGuidelines: [
      `Call submit only when the ${noun} the assignment asks of you is genuinely done.`,
      TERMINAL_GUIDELINE,
    ],
    parameters: z.toJSONSchema(NoParams) as never,
    async execute(_toolCallId, _params: NoParams) {
      return {
        content: [{ type: "text", text: "Submitted." }],
        details: {},
        terminate: true,
      };
    },
  });
}

export const blocked = defineTool({
  name: "blocked",
  label: "Blocked",
  description:
    "Stop because the one thing in your way is a wall you cannot get past without a decision or an access you do not have. A person reads your message and unblocks you.",
  promptSnippet: "Stop on a wall by calling blocked",
  promptGuidelines: [
    "Call blocked only when you genuinely cannot proceed; a submit you can still make is not a wall.",
    TERMINAL_GUIDELINE,
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
