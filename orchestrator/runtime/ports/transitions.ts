import { z } from "zod";
import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import { ALL_STATES } from "../../vocabulary/state-machine.ts";

export const TransitionEntry = z.strictObject({
  seq: z.int(),
  at: z.string(),
  task_id: z.string(),
  transition: z.string(),
  from: z.enum(ALL_STATES),
  to: z.enum(ALL_STATES),
  by: z.string(),
});

export type TransitionEntry = z.infer<typeof TransitionEntry>;

export interface Transitions {
  readonly cursor: number;
  read(): Awaitable<TransitionEntry[]>;
  append(
    entry: Omit<TransitionEntry, "seq" | "at">,
  ): Awaitable<TransitionEntry>;
  close(): Awaitable<void>;
}
