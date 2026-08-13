import { z } from "zod";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Time = z.string().regex(HH_MM, "must be a 24 hour time hh:mm");

export const Segment = z
  .strictObject({
    start: Time,
    end: Time,
  })
  .refine((segment) => segment.start !== segment.end, {
    message: "starts and ends at the same minute, so it never opens",
  });

export type Segment = z.infer<typeof Segment>;

export const Schedule = z.array(Segment);

export type Schedule = z.infer<typeof Schedule>;

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function minuteOfDay(nowMs: number): number {
  const at = new Date(nowMs);
  return at.getHours() * 60 + at.getMinutes();
}

function opens(segment: Segment, minute: number): boolean {
  const start = minutesOf(segment.start);
  const end = minutesOf(segment.end);
  if (start < end) {
    return minute >= start && minute < end;
  }
  return minute >= start || minute < end;
}

export function withinSchedule(
  schedule?: Schedule,
  nowMs = Date.now(),
): boolean {
  if (!schedule || schedule.length === 0) {
    return true;
  }
  const minute = minuteOfDay(nowMs);
  return schedule.some((segment) => opens(segment, minute));
}
