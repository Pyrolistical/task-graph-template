import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const SubmitParams = z.object({});
type SubmitParams = z.infer<typeof SubmitParams>;

const submit = defineTool({
  name: "submit",
  label: "Submit",
  description:
    "Finish and hand in your work. Call it as your last action, with nothing after it.",
  promptSnippet: "End the task by calling submit",
  promptGuidelines: [
    "Call submit only when the work the assignment asks of you is genuinely done.",
    "submit and blocked are terminal: after either one, make no further tool calls in the turn.",
  ],
  parameters: z.toJSONSchema(SubmitParams) as never,
  async execute(_toolCallId, _params: SubmitParams) {
    return {
      content: [{ type: "text", text: "Submitted." }],
      details: {},
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
