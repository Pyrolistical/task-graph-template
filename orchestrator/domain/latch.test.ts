import { describe, expect, test } from "bun:test";
import { Latch } from "./latch.ts";

describe("Feature: a latch that holds on to the wake-up nobody heard", () => {
  test("everyone waiting is woken by one notify", async () => {
    // Given two callers waiting on a latch
    const latch = new Latch();
    const woken: string[] = [];
    void latch.wait().then(() => woken.push("first"));
    void latch.wait().then(() => woken.push("second"));

    // When the latch is notified once
    latch.notify();
    await Promise.resolve();

    // Then both were woken
    expect(woken).toEqual(["first", "second"]);
  });

  test("a notify nobody was waiting for is kept for the next waiter", async () => {
    // Given a latch notified while nothing was waiting
    const latch = new Latch();
    latch.notify();

    // When a caller waits afterwards
    let woken = false;
    void latch.wait().then(() => (woken = true));
    await Promise.resolve();

    // Then it does not wait at all
    expect(woken).toBe(true);
  });

  test("clearing the latch puts the next waiter back to waiting", async () => {
    // Given a latch whose notify has been taken
    const latch = new Latch();
    latch.notify();
    latch.clear();

    // When a caller waits
    let woken = false;
    void latch.wait().then(() => (woken = true));
    await Promise.resolve();

    // Then it waits for the next notify
    expect(woken).toBe(false);
    latch.notify();
    await Promise.resolve();
    expect(woken).toBe(true);
  });

  test("a waiter that gives up is released without a notify", async () => {
    // Given a caller that waits with a signal it controls
    const latch = new Latch();
    const giving: AbortController = new AbortController();
    let woken = false;
    void latch.wait(giving.signal).then(() => (woken = true));

    // When it gives up
    giving.abort();
    await Promise.resolve();

    // Then it is released, and the latch was never raised for anyone else
    expect(woken).toBe(true);
    let next = false;
    void latch.wait().then(() => (next = true));
    await Promise.resolve();
    expect(next).toBe(false);
  });

  test("a caller that has already given up never waits", async () => {
    // Given a signal that is aborted before the wait
    const latch = new Latch();
    const giving: AbortController = new AbortController();
    giving.abort();

    // When a caller waits on it
    let woken = false;
    void latch.wait(giving.signal).then(() => (woken = true));
    await Promise.resolve();

    // Then it returns right away
    expect(woken).toBe(true);
  });
});
