import { describe, expect, test } from "bun:test";
import { Latch } from "../domain/latch.ts";
import { Paced } from "./paced.ts";

describe("Feature: a loop that runs one pass at a time", () => {
  test("passes never overlap, however often a redraw is asked for", async () => {
    // Given a loop whose body takes a while
    const paced: Paced = new Paced(10_000);
    const order: string[] = [];
    let passes = 0;
    const loop = paced.run(async () => {
      passes += 1;
      order.push(`in:${passes}`);
      await Bun.sleep(5);
      order.push(`out:${passes}`);
      if (passes === 3) {
        paced.stop();
      } else {
        paced.schedule();
      }
    });

    // When redraws are asked for while a pass is still running
    await Bun.sleep(1);
    paced.schedule();
    paced.schedule();
    paced.schedule();
    await loop;

    // Then each pass finished before the next began
    expect(order).toEqual(["in:1", "out:1", "in:2", "out:2", "in:3", "out:3"]);
  });

  test("redraws asked for during a pass collapse into one more pass", async () => {
    // Given a loop that would otherwise sit idle for a long tick
    const paced: Paced = new Paced(10_000);
    let passes = 0;

    // When two redraws are asked for during the first pass
    await paced.run(async () => {
      passes += 1;
      if (passes === 1) {
        paced.schedule();
        paced.schedule();
      } else {
        paced.stop();
      }
      await Promise.resolve();
    });

    // Then only one further pass ran, rather than one per request
    expect(passes).toBe(2);
  });

  test("a stopped loop does not wait out its tick", async () => {
    // Given a loop with a tick far longer than this test would wait for
    const paced: Paced = new Paced(10_000);

    // When the body stops the loop
    const started = Date.now();
    await paced.run(() => {
      paced.stop();
      return Promise.resolve();
    });

    // Then it returns right away
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("work notified on the shared latch runs the next pass at once", async () => {
    // Given a loop paced by a latch someone else notifies
    const wake = new Latch();
    const paced: Paced = new Paced(10_000, wake);
    let passes = 0;

    // When work is notified after a pass has finished
    const started = Date.now();
    await paced.run(() => {
      passes += 1;
      if (passes === 1) {
        void Bun.sleep(1).then(() => wake.notify());
      } else {
        paced.stop();
      }
      return Promise.resolve();
    });

    // Then the next pass ran without waiting out the tick
    expect(passes).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a body that throws ends the loop and surfaces the failure", async () => {
    // Given a loop whose body fails
    const paced: Paced = new Paced(10_000);
    let passes = 0;

    // When the body throws
    // Then the failure is not swallowed, and no further pass runs
    await expect(
      paced.run(() => {
        passes += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(passes).toBe(1);
  });
});
