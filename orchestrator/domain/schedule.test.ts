import { describe, expect, test } from "bun:test";
import { type Schedule, withinSchedule } from "./schedule.ts";

function at(time: string): number {
  return Date.parse(`2026-08-13T${time}:00`);
}

describe("Feature: the hours an agent is allowed to run", () => {
  test("an agent with no schedule runs at any hour", () => {
    // Given an agent that named no hours at all
    const schedule = undefined;

    // When the middle of the night is checked against it
    const open = withinSchedule(schedule, at("03:17"));

    // Then it runs, because a schedule is the only thing that closes an hour
    expect(open).toBe(true);
  });

  test("an agent whose schedule names no segments runs at any hour", () => {
    // Given an agent that declared an empty list of segments
    const schedule: Schedule = [];

    // When the middle of the night is checked against it
    const open = withinSchedule(schedule, at("03:17"));

    // Then it runs, because naming no hours is the same as naming none of them closed
    expect(open).toBe(true);
  });

  test("an agent runs at a time between the ends of its segment", () => {
    // Given an agent allowed to run through the working day
    const schedule = [{ start: "09:00", end: "17:00" }];

    // When the middle of the afternoon is checked against it
    const open = withinSchedule(schedule, at("14:30"));

    // Then it runs
    expect(open).toBe(true);
  });

  test("an agent runs on the minute its segment starts", () => {
    // Given an agent allowed to run through the working day
    const schedule = [{ start: "09:00", end: "17:00" }];

    // When the minute the segment opens is checked against it
    const open = withinSchedule(schedule, at("09:00"));

    // Then it runs, because the start is part of the segment
    expect(open).toBe(true);
  });

  test("an agent is held on the minute its segment ends", () => {
    // Given an agent allowed to run through the working day
    const schedule = [{ start: "09:00", end: "17:00" }];

    // When the minute the segment closes is checked against it
    const open = withinSchedule(schedule, at("17:00"));

    // Then it is held, so a segment ending where the next begins never covers a minute twice
    expect(open).toBe(false);
  });

  test("an agent is held before its segment opens", () => {
    // Given an agent allowed to run through the working day
    const schedule = [{ start: "09:00", end: "17:00" }];

    // When the minute before it opens is checked against it
    const open = withinSchedule(schedule, at("08:59"));

    // Then it is held
    expect(open).toBe(false);
  });

  test("an agent is held in the minutes before its segment opens", () => {
    // Given an agent allowed to run from half past nine
    const schedule = [{ start: "09:30", end: "17:00" }];

    // When the minute before it opens is checked against it
    const open = withinSchedule(schedule, at("09:29"));

    // Then it is held, because the minutes of a segment are read as closely as its hours
    expect(open).toBe(false);
  });

  test("an agent runs in a segment one minute wide", () => {
    // Given an agent allowed to run for the single minute after half past nine
    const schedule = [{ start: "09:30", end: "09:31" }];

    // When that minute is checked against it
    const open = withinSchedule(schedule, at("09:30"));

    // Then it runs, because a minute is the smallest segment the schedule can name
    expect(open).toBe(true);
  });

  test("a segment ending before it starts runs late at night", () => {
    // Given an agent allowed to run overnight, on cheap power
    const schedule = [{ start: "22:00", end: "06:00" }];

    // When an hour before midnight is checked against it
    const open = withinSchedule(schedule, at("23:30"));

    // Then it runs, because an end earlier than its start wraps midnight
    expect(open).toBe(true);
  });

  test("a segment ending before it starts runs early in the morning", () => {
    // Given an agent allowed to run overnight, on cheap power
    const schedule = [{ start: "22:00", end: "06:00" }];

    // When an hour after midnight is checked against it
    const open = withinSchedule(schedule, at("01:00"));

    // Then it runs, because the segment carried over the day boundary
    expect(open).toBe(true);
  });

  test("a segment ending before it starts is held during the day", () => {
    // Given an agent allowed to run overnight, on cheap power
    const schedule = [{ start: "22:00", end: "06:00" }];

    // When the middle of the day is checked against it
    const open = withinSchedule(schedule, at("12:00"));

    // Then it is held, because midday is on neither side of midnight
    expect(open).toBe(false);
  });

  test("an agent of several segments runs inside the second of them", () => {
    // Given an agent allowed to run before work and after it
    const schedule = [
      { start: "06:00", end: "09:00" },
      { start: "18:00", end: "23:00" },
    ];

    // When the evening is checked against it
    const open = withinSchedule(schedule, at("19:00"));

    // Then it runs, because any segment covering the minute is enough
    expect(open).toBe(true);
  });

  test("an agent of several segments is held in the gap between them", () => {
    // Given an agent allowed to run before work and after it
    const schedule = [
      { start: "06:00", end: "09:00" },
      { start: "18:00", end: "23:00" },
    ];

    // When the working day between them is checked against it
    const open = withinSchedule(schedule, at("13:00"));

    // Then it is held, because no segment covers that minute
    expect(open).toBe(false);
  });
});
