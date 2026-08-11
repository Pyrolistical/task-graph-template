import { describe, expect, test } from "bun:test";
import { ExclusiveLock } from "./exclusive-lock.ts";

describe("Feature: a lock that hands one caller the shared state at a time", () => {
  test("a caller still inside keeps everyone else out", async () => {
    // Given a lock with the value "a"
    const lock = new ExclusiveLock("a");

    // Given the first caller with the lock read the value then updated it "b"
    let leave!: () => void;
    const inside = new Promise<void>((resolve) => (leave = resolve));
    const order: string[] = [];
    const first = lock.acquire(async ([value, set]) => {
      order.push(`in:${value}`);
      set("b");
      await inside;
    });

    // Given a second caller waits for the lock to read the value
    const second = lock.acquire(([value]) => {
      order.push(`in:${value}`);
    });

    // When the first caller releases the lock
    leave();
    await Promise.all([first, second]);

    // Then we see the read order as "a", then "b"
    expect(order).toEqual(["in:a", "in:b"]);
  });

  test("a caller that fails still frees the lock", async () => {
    // Given a lock
    const lock = new ExclusiveLock(undefined);

    // When the lock is acquired but an error is thrown
    await expect(
      lock.acquire(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Then the lock is released and can be acquired
    expect(await lock.acquire(() => "ok")).toBe("ok");
  });
});
