import { z } from "zod";

export const Command = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("scheduler"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    command: z.literal("agent"),
    agent: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.strictObject({
    command: z.literal("slot_abort"),
    slot: z.string().min(1),
  }),
]);

export type Command = z.infer<typeof Command>;
