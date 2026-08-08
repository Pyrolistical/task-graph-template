import { describe, expect, test } from "bun:test";
import { Rates, WINDOW, tokensPerSecond } from "./rates.ts";

const NOW = new Date("2026-01-01").getTime();

describe("Feature: measuring how fast an agent writes", () => {
  test("an agent that has produced nothing has no rate", () => {
    // Given no samples at all
    const samples: never[] = [];

    // When the rate is measured
    const rate = tokensPerSecond(samples, NOW);

    // Then there is no rate to report
    expect(rate).toBeNull();
  });

  test("a single sample is measured from when it arrived", () => {
    // Given one message of five tokens, five seconds ago
    const samples = [{ timestampMs: NOW, tokens: 5 }];

    // When the rate is measured
    const rate = tokensPerSecond(samples, NOW + 5000);

    // Then it is one token per second
    expect(rate).toBe(1);
  });

  test("two samples are measured over the span between them", () => {
    // Given two messages a second apart carrying ten tokens together
    const samples = [
      { timestampMs: NOW, tokens: 3 },
      { timestampMs: NOW + 1000, tokens: 7 },
    ];

    // When the rate is measured long after both arrived
    const rate = tokensPerSecond(samples, NOW + 10_000);

    // Then the idle time since is not counted against the agent
    expect(rate).toBe(10);
  });

  test("samples that share a timestamp fall back to measuring until now", () => {
    // Given two messages stamped at the same instant
    const samples = [
      { timestampMs: NOW, tokens: 4 },
      { timestampMs: NOW, tokens: 6 },
    ];

    // When the rate is measured two seconds later
    const rate = tokensPerSecond(samples, NOW + 2000);

    // Then the span is taken from the first sample to now
    expect(rate).toBe(5);
  });

  test("a sample stamped in the future gives no rate", () => {
    // Given a message whose clock ran ahead of ours
    const samples = [{ timestampMs: NOW + 1000, tokens: 5 }];

    // When the rate is measured
    const rate = tokensPerSecond(samples, NOW);

    // Then there is no rate rather than a negative one
    expect(rate).toBeNull();
  });
});

describe("Feature: the rate table the scheduler picks slots by", () => {
  test("an agent nobody has run yet has no rate", () => {
    // Given a table nothing has been recorded into
    const rates = new Rates();

    // When an agent's rate is read
    const rate = rates.rate("pi-anthropic-m", NOW);

    // Then it has none, which the scheduler reads as untried
    expect(rate).toBeNull();
  });

  test("an agent's rate is its output tokens over the span of its messages", () => {
    // Given an agent that produced twenty tokens in each of two messages
    const rates = new Rates();
    rates.record("pi-anthropic-m", { timestampMs: NOW, tokens: 20 });
    rates.record("pi-anthropic-m", { timestampMs: NOW + 1000, tokens: 20 });

    // When its rate is read
    const rate = rates.rate("pi-anthropic-m", NOW);

    // Then forty tokens over one second is forty per second
    expect(rate).toBe(40);
  });

  test("only the last ten messages count towards the rate", () => {
    // Given an agent whose first message was enormous
    const rates = new Rates();
    rates.record("pi-anthropic-m", { timestampMs: NOW, tokens: 100_000 });

    // Given ten ordinary messages after it, one a second
    for (let i = 1; i <= WINDOW; i++) {
      rates.record("pi-anthropic-m", {
        timestampMs: NOW + i * 1000,
        tokens: 9,
      });
    }

    // When its rate is read
    const rate = rates.rate("pi-anthropic-m", NOW);

    // Then the enormous message has fallen out of the window
    expect(rate).toBe(10);
  });

  test("slots of the same model share one window", () => {
    // Given two messages recorded against one agent key
    const rates = new Rates();
    rates.record("pi-anthropic-m", { timestampMs: NOW, tokens: 10 });
    rates.record("pi-anthropic-m", { timestampMs: NOW + 1000, tokens: 30 });

    // When its rate is read
    const measured = rates.rateOf("pi-anthropic-m");

    // Then the samples belong to the agent, not to the slot that produced them
    expect(measured).toBe(40);

    // Then a different agent is still untried
    expect(rates.rateOf("pi-openai-m")).toBeNull();
  });
});
