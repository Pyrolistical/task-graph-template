import { z } from "zod";
import { maybe } from "../kernel/domain/schema.ts";

export const TaskRow = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  state_entered: maybe(z.string()),
  depends_on: z.array(z.string()),
  blocking: z.int(),
  claimed_by: maybe(z.string()),
  held_reason: maybe(z.string()),
  worktree: maybe(z.string()),
});

export type TaskRow = z.infer<typeof TaskRow>;

export const TasksView = z.looseObject({ tasks: z.array(TaskRow) });
