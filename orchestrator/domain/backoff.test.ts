import { describe, expect, test } from "bun:test";
import {
  BACKOFF_CAP_MS,
  BACKOFF_START_MS,
  MODEL_LOADING_MS,
  type Wait,
  due,
  nextWait,
  retryOf,
} from "./backoff.ts";

const NOW = Date.parse("2026-07-29T00:00:00.000Z");

describe("Feature: waiting out a provider that is not answering", () => {
  test("the first error waits the shortest step and counts an attempt", () => {
    // Given a run that has not waited on the provider before
    const first = undefined;

    // When its turn ends on a provider error
    const wait = nextWait("502 bad gateway", first, NOW);

    // Then it waits the opening step, and the console has an attempt to draw
    expect({ delayMs: wait.delayMs, attempt: wait.attempt }).toEqual({
      delayMs: BACKOFF_START_MS,
      attempt: 1,
    });
  });

  test("each further error doubles the wait and counts another attempt", () => {
    // Given a run that has already waited out one provider error
    const first = nextWait("502 bad gateway", undefined, NOW);

    // When the turn after it ends the same way
    const second = nextWait("502 bad gateway", first, NOW);

    // Then the wait doubles and the attempts keep counting up
    expect({ delayMs: second.delayMs, attempt: second.attempt }).toEqual({
      delayMs: BACKOFF_START_MS * 2,
      attempt: 2,
    });
  });

  test("the wait stops growing at the cap", () => {
    // Given a run that has waited out error after error
    let wait: Wait | undefined = undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      wait = nextWait("502 bad gateway", wait, NOW);
    }

    // When the next one arrives
    const capped = nextWait("502 bad gateway", wait, NOW);

    // Then the wait is held at the cap rather than growing without end
    expect(capped.delayMs).toBe(BACKOFF_CAP_MS);
  });

  test("a model that is still loading is waited on without spending an attempt", () => {
    // Given a run that has already waited out a provider error
    const first = nextWait("502 bad gateway", undefined, NOW);

    // When the next turn ends saying the model is loading
    const loading = nextWait("503 model is loading", first, NOW);

    // Then it waits the loading step, and the attempt count stands still
    expect({
      delayMs: loading.delayMs,
      attempt: loading.attempt,
      loading: loading.loading,
    }).toEqual({
      delayMs: MODEL_LOADING_MS,
      attempt: first.attempt,
      loading: true,
    });
  });

  test("a wait is due once the clock reaches the time it named", () => {
    // Given a wait of one step from now
    const wait = nextWait("502 bad gateway", undefined, NOW);

    // When the clock is read before that time and again on it
    const early = due(wait, NOW + BACKOFF_START_MS - 1);
    const reached = due(wait, NOW + BACKOFF_START_MS);

    // Then only the second is due, so a tick re-prompts no sooner than it should
    expect({ early, reached }).toEqual({ early: false, reached: true });
  });

  test("the console is told when the retry is and which attempt it is", () => {
    // Given a run waiting out its second provider error
    const wait = nextWait(
      "502 bad gateway",
      nextWait("502 bad gateway", undefined, NOW),
      NOW,
    );

    // When the slot row is drawn
    const retry = retryOf(wait);

    // Then it carries the time and the attempt, and nothing of the ladder behind them
    expect(retry).toEqual({
      at: new Date(NOW + BACKOFF_START_MS * 2).toISOString(),
      attempt: 2,
    });
  });
});
