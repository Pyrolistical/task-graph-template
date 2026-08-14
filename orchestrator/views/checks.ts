import { z } from "zod";

export const RunningCheck = z.strictObject({
  task_id: z.string(),
  index: z.int(),
  command: z.string(),
  pid: z.int(),
  started_at: z.string(),
  log: z.string(),
});

export type RunningCheck = z.infer<typeof RunningCheck>;

export const ChecksView = z.looseObject({ checks: z.array(RunningCheck) });
