import { describe, expect } from "bun:test";
import { test } from "./temp.ts";
import { Rates, WINDOW, tokensPerSecond } from "./rates.ts";

const NOW = new Date("2026-01-01").getTime();

describe("tokensPerSecond", () => {
  test("no samples give no rate", () => {
    expect(tokensPerSecond([], NOW)).toBeNull();
  });

  test("a single sample measures from when it arrived", () => {
    expect(tokensPerSecond([{ timestampMs: NOW, tokens: 5 }], NOW + 5000)).toBe(
      1,
    );
  });

  test("two samples use the time between them", () => {
    expect(
      tokensPerSecond(
        [
          { timestampMs: NOW, tokens: 3 },
          { timestampMs: NOW + 1000, tokens: 7 },
        ],
        NOW + 10_000,
      ),
    ).toBe(10);
  });

  test("same-time samples fall back to now", () => {
    expect(
      tokensPerSecond(
        [
          { timestampMs: NOW, tokens: 4 },
          { timestampMs: NOW, tokens: 6 },
        ],
        NOW + 2000,
      ),
    ).toBe(5);
  });

  test("a sample in the future gives no rate", () => {
    expect(tokensPerSecond([{ timestampMs: NOW + 1000, tokens: 5 }], NOW)).toBe(
      null,
    );
  });
});

describe("the rate table", () => {
  function measured(agent: string, tokens: number, count = 2): Rates {
    const rates = new Rates();
    for (let i = 0; i < count; i++) {
      rates.record(agent, { timestampMs: NOW + i * 1000, tokens });
    }
    return rates;
  }

  test("an agent nobody has run has no rate", () => {
    expect(new Rates().rate("pi-anthropic-m", NOW)).toBeNull();
  });

  test("the rate is output tokens over the span of its messages", () => {
    expect(measured("pi-anthropic-m", 20).rate("pi-anthropic-m", NOW)).toBe(40);
  });

  test("only the last ten messages count", () => {
    const rates = new Rates();
    for (let i = 0; i <= WINDOW; i++) {
      rates.record("pi-anthropic-m", {
        timestampMs: NOW + i * 1000,
        tokens: i === 0 ? 100_000 : 9,
      });
    }

    expect(rates.rate("pi-anthropic-m", NOW)).toBe(10);
  });

  test("slots of the same model share one window", () => {
    const rates = new Rates();
    rates.record("pi-anthropic-m", { timestampMs: NOW, tokens: 10 });
    rates.record("pi-anthropic-m", { timestampMs: NOW + 1000, tokens: 30 });

    expect(rates.rateOf("pi-anthropic-m")).toBe(40);
    expect(rates.rateOf("pi-openai-m")).toBeNull();
  });
});
