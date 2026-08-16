import { describe, expect, test } from "bun:test";
import { RECENT_TASKS } from "../domain/rows.ts";
import { keepRecent } from "./recent.ts";
import type { TaskId } from "../../vocabulary/task.ts";

function ids(from: number, count: number): TaskId[] {
  return Array.from({ length: count }, (_, index) =>
    String(from + index).padStart(6, "0"),
  );
}

describe("Feature: the tasks the graph keeps in view", () => {
  test("the task just touched goes to the front", () => {
    // Given a window holding three tasks
    const recent = ["000001", "000002", "000003"];

    // When a task nothing has touched yet is edited
    const kept = keepRecent("000009", recent, new Set(recent));

    // Then it leads the window and nothing is discarded
    expect(kept.recent).toEqual(["000009", "000001", "000002", "000003"]);
    expect(kept.discards).toEqual([]);
  });

  test("a task touched again moves up rather than appearing twice", () => {
    // Given a window whose last entry is edited again
    const recent = ["000001", "000002", "000003"];

    // When that task is remembered
    const kept = keepRecent("000003", recent, new Set(recent));

    // Then it leads the window, still once
    expect(kept.recent).toEqual(["000003", "000001", "000002"]);
  });

  test("the window holds only as many tasks as it is wide", () => {
    // Given a window already full
    const recent = ids(1, RECENT_TASKS);

    // When one more task is remembered
    const kept = keepRecent("000999", recent, new Set(recent));

    // Then the oldest falls out of it
    expect(kept.recent).toHaveLength(RECENT_TASKS);
    expect(kept.recent.at(-1)).toBe(recent.at(-2));
  });

  test("a task that falls out and is gone from the graph is discarded", () => {
    // Given a full window whose oldest task no longer has a document
    const recent = ids(1, RECENT_TASKS);
    const live = new Set(recent.slice(0, -1));

    // When one more task is remembered
    const kept = keepRecent("000999", recent, live);

    // Then its runtime directory is named for discarding
    expect(kept.discards).toEqual([recent.at(-1) ?? ""]);
  });

  test("a task that falls out but still has a document is left alone", () => {
    // Given a full window whose oldest task is still in the graph
    const recent = ids(1, RECENT_TASKS);

    // When one more task is remembered
    const kept = keepRecent("000999", recent, new Set(recent));

    // Then nothing is discarded, because a live task keeps its runtime directory
    expect(kept.discards).toEqual([]);
    expect(kept.recent).not.toContain(recent.at(-1));
  });
});
