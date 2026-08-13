import { describe, expect, test } from "bun:test";
import { type Cost, carriedOn, costOf, recorded, secondsOf } from "./costs.ts";

const HOUR = 3600000;

const FREE = { wattage: 0, costPerKwh: 0 };

const METERED = { wattage: 300, costPerKwh: 0.2 };

describe("Feature: what a session cost", () => {
  test("a provider that prices its tokens is taken at its word", () => {
    // Given an hour on a box that draws power, on a provider that charges 45 cents

    // When the session is priced
    const cost = costOf(METERED, HOUR, 0.45);

    // Then the provider's price is the cost, because the meter is not a second bill
    expect(cost).toBe(0.45);
  });

  test("a model with no price is billed for the power it drew", () => {
    // Given an hour on a 300W box at 20 cents a kWh, priced by pi at nothing

    // When the session is priced
    const cost = costOf(METERED, HOUR);

    // Then the hour it ran is billed as the energy it took
    expect(cost).toBe(0.06);
  });

  test("half an hour costs half as much", () => {
    // Given the same box run for half the time

    // When the session is priced
    const cost = costOf(METERED, HOUR / 2);

    // Then the cost follows how long the state ran
    expect(cost).toBe(0.03);
  });

  test("a model with neither a price nor a meter costs zero", () => {
    // Given an hour on a local model whose agent declares no wattage

    // When the session is priced
    const cost = costOf(FREE, HOUR);

    // Then it is zero rather than nothing at all, because the session did run
    expect(cost).toBe(0);
  });

  test("a resumed metered session adds to what it had already spent", () => {
    // Given a session already billed 6 cents, resumed on the meter for another hour

    // When the session is priced
    const cost = costOf(METERED, HOUR, undefined, 0.06);

    // Then the entry carries the whole session, since one entry is one session
    expect(cost).toBe(0.12);
  });

  test("a resumed priced session ignores what was carried", () => {
    // Given a resumed session whose reported price already spans every turn it took

    // When the session is priced
    const cost = costOf(METERED, HOUR, 0.45, 0.3);

    // Then the reported total stands alone, because pi counts the whole session file
    expect(cost).toBe(0.45);
  });
});

describe("Feature: how long a session ran", () => {
  test("a session is timed to the second it held its slot", () => {
    // Given a session that held a slot for an hour and a half a second more

    // When the session is timed
    const seconds = secondsOf(HOUR + 500);

    // Then it reads in whole seconds, the resolution a person reads a phase in
    expect(seconds).toBe(3601);
  });

  test("a resumed session adds to the clock its entry already held", () => {
    // Given a session that had run 10 minutes, resumed for another hour

    // When the session is timed
    const seconds = secondsOf(HOUR, 600);

    // Then the entry holds the whole session, price or no price
    expect(seconds).toBe(4200);
  });
});

describe("Feature: the ledger a task carries", () => {
  const design: Cost = {
    state: "DESIGN",
    slot: "pi-anthropic-opus-1",
    seconds: 300,
    cost: 0.1,
  };
  const work: Cost = {
    state: "WORK",
    slot: "pi-anthropic-opus-1",
    seconds: 900,
    cost: 0.4,
  };

  test("a session that ends is appended in the order it ran", () => {
    // Given a task that has paid for its design
    const costs = [design];

    // When a work session ends
    const after = recorded(costs, work, false);

    // Then the ledger reads as the task ran
    expect(after).toEqual([design, work]);
  });

  test("a resumed session replaces its own entry instead of adding one", () => {
    // Given a work session already in the ledger
    const costs = [design, work];

    // When it is resumed on another slot and ends dearer
    const resumed: Cost = {
      state: "WORK",
      slot: "pi-anthropic-opus-2",
      seconds: 1500,
      cost: 0.7,
    };
    const after = recorded(costs, resumed, true);

    // Then one session is still one entry, on the slot holding its total
    expect(after).toEqual([design, resumed]);
  });

  test("a second work session after a review is its own entry", () => {
    // Given a task sent back by a review, which starts a fresh session
    const costs = [design, work];

    // When that new session ends
    const after = recorded(
      costs,
      { state: "WORK", slot: "pi-anthropic-opus-1", seconds: 60, cost: 0.2 },
      false,
    );

    // Then the ledger shows both, because the work was paid for twice
    expect(after).toEqual([
      design,
      work,
      { state: "WORK", slot: "pi-anthropic-opus-1", seconds: 60, cost: 0.2 },
    ]);
  });

  test("what a state has spent is read off the last entry it holds", () => {
    // Given a task that has worked twice
    const second: Cost = {
      state: "WORK",
      slot: "pi-anthropic-opus-1",
      seconds: 60,
      cost: 0.2,
    };
    const costs = [work, second];

    // When the live work session is asked what it has already run and cost
    const carried = carriedOn(costs, "WORK");

    // Then it is the newest of them, the session a resume would rejoin
    expect(carried).toEqual({ seconds: 60, cost: 0.2 });
  });

  test("a state that has never run has spent nothing", () => {
    // Given a task that has only ever been designed
    const costs = [design];

    // When the work session is asked what it carries
    const carried = carriedOn(costs, "WORK");

    // Then there is nothing to carry
    expect(carried).toEqual({ seconds: 0, cost: 0 });
  });
});
