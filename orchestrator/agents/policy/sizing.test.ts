import { describe, expect, test } from "bun:test";
import { type Sized, dropped, taken } from "./sizing.ts";

function aSlot(index: number, idle = true): Sized {
  return { name: `pi-anthropic-sonnet-${index}`, index, idle };
}

describe("Feature: which slot numbers an agent takes as it grows", () => {
  test("an agent growing from one slot takes the numbers above it", () => {
    // Given an agent holding only its first slot
    const held = [1];

    // When it is set to three slots
    const added = taken(held, 3);

    // Then it takes the two numbers above the one it has
    expect(added).toEqual([2, 3]);
  });

  test("an agent takes the free numbers below its highest, before growing past it", () => {
    // Given an agent whose middle slot left while its third was running
    const held = [1, 3];

    // When it is set back to three slots
    const added = taken(held, 3);

    // Then it fills the gap rather than opening a fourth number
    expect(added).toEqual([2]);
  });

  test("an agent already at its count takes nothing", () => {
    // Given an agent holding as many slots as it is set to
    const held = [1, 2];

    // When it is set to the count it already has
    const added = taken(held, 2);

    // Then it takes no number at all
    expect(added).toEqual([]);
  });
});

describe("Feature: which slots an agent drops as it shrinks", () => {
  test("an agent drops its highest numbered slot first", () => {
    // Given an agent holding three idle slots
    const held = [aSlot(1), aSlot(2), aSlot(3)];

    // When it is set to one slot
    const removed = dropped(held, 1);

    // Then the two it drops are the highest numbers, in that order
    expect(removed).toEqual(["pi-anthropic-sonnet-3", "pi-anthropic-sonnet-2"]);
  });

  test("a slot that is running is kept, however high its number", () => {
    // Given an agent whose highest slot is running a task
    const held = [aSlot(1), aSlot(2), aSlot(3, false)];

    // When it is set to one slot
    const removed = dropped(held, 1);

    // Then the running one stays and the idle ones go instead
    expect(removed).toEqual(["pi-anthropic-sonnet-2", "pi-anthropic-sonnet-1"]);
  });

  test("an agent with nothing idle drops nothing", () => {
    // Given an agent whose every slot is running a task
    const held = [aSlot(1, false), aSlot(2, false)];

    // When it is set to one slot
    const removed = dropped(held, 1);

    // Then it drops none of them, and stays above its count until one settles
    expect(removed).toEqual([]);
  });

  test("an agent already at its count drops nothing", () => {
    // Given an agent holding as many slots as it is set to
    const held = [aSlot(1), aSlot(2)];

    // When it is set to the count it already has
    const removed = dropped(held, 2);

    // Then it drops no slot at all
    expect(removed).toEqual([]);
  });
});
