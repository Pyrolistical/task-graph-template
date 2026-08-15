import { describe, expect, test } from "bun:test";
import { idleRow, slotAt } from "../../agents/domain/slots.ts";
import { SLOTS, busyRow, viewOf } from "../../testing/console.ts";
import type { ConsoleSlot } from "./panes.ts";
import { Toggles } from "./toggles.ts";

const AGENT = SLOTS[0].agent;

const pool = (enabled: boolean) =>
  viewOf({ slots: SLOTS.map((slot) => idleRow(slot, SLOTS.length, enabled)) });

const enabled = (toggles: Toggles, ...views: boolean[]): boolean[][] =>
  views.map((state) =>
    toggles.apply(pool(state)).slots.map((slot) => slot.enabled),
  );

const published = (total: number, slots: number = SLOTS.length) =>
  viewOf({
    slots: Array.from({ length: slots }, (_, index) =>
      idleRow(slotAt(SLOTS[0], index + 1), total),
    ),
  });

const numbered = (slot: ConsoleSlot) =>
  `${slot.index} of ${slot.total}${slot.pending ? " loading" : ""}`;

const counted = (toggles: Toggles, ...views: number[]): string[][] =>
  views.map((total) =>
    toggles.apply(published(total, total)).slots.map(numbered),
  );

describe("Feature: switching an agent or the scheduler on and off", () => {
  test("a click switches the agent before any view has agreed", () => {
    // Given an agent the views still report as enabled
    const toggles: Toggles = new Toggles();

    // When it is switched off
    toggles.push({ command: "agent", agent: AGENT, enabled: false });

    // Then every slot of it draws as off against a view that still says on
    expect(enabled(toggles, true)).toEqual([[false, false]]);
  });

  test("a view published before the server read the command does not flip the switch back", () => {
    // Given an agent switched off and drawn off against one stale view
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "agent", agent: AGENT, enabled: false });
    enabled(toggles, true);

    // When the server catches up and every later view reports it off
    // Then the switch never flipped back, and follows the views from then on
    expect(enabled(toggles, false, false, true)).toEqual([
      [false, false],
      [false, false],
      [true, true],
    ]);
  });

  test("a command the server never applied resets the switch after two views", () => {
    // Given an agent switched off
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "agent", agent: AGENT, enabled: false });

    // When two views in a row still report it enabled
    // Then the first is taken as stale and the second gives the server back
    expect(enabled(toggles, true, true, true)).toEqual([
      [false, false],
      [true, true],
      [true, true],
    ]);
  });

  test("clicking again gives the switch a fresh two views", () => {
    // Given an agent switched off and rejected once
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "agent", agent: AGENT, enabled: false });
    enabled(toggles, true);

    // When it is switched off again
    toggles.push({ command: "agent", agent: AGENT, enabled: false });

    // Then it takes two more rejecting views to reset it
    expect(enabled(toggles, true, true)).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  test("an agent no view reports is not held on the screen", () => {
    // Given an agent switched on that no slot in the views belongs to
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "agent", agent: "pi-gone-model", enabled: true });

    // When two views arrive without it
    const rows = enabled(toggles, false, false);

    // Then nothing is overridden and the pending switch is dropped
    expect(rows).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  test("the scheduler switch flips at once and resets the same way", () => {
    // Given the scheduler switched on while the views say it is off
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "scheduler", enabled: true });

    // When three views in a row still report it off
    const scheduling = [false, false, false].map(
      (state) => toggles.apply(viewOf({ scheduling: state })).scheduling,
    );

    // Then it draws on once, then two rejections hand it back to the server
    expect(scheduling).toEqual([true, false, false]);
  });

  test("a slot asked for is drawn at once as a pane still loading", () => {
    // Given an agent the views still report as running two slots
    const toggles: Toggles = new Toggles();

    // When a third slot is asked for
    toggles.push({ command: "slots", agent: AGENT, total: 3 });

    // Then a third pane is on the screen before the server has answered
    expect(counted(toggles, 2)).toEqual([
      ["1 of 3", "2 of 3", "3 of 3 loading"],
    ]);
  });

  test("a slot given up on leaves the screen at once", () => {
    // Given an agent running two idle slots
    const toggles: Toggles = new Toggles();

    // When one of them is given up
    toggles.push({ command: "slots", agent: AGENT, total: 1 });

    // Then the pane is gone before the server has answered
    expect(counted(toggles, 2)).toEqual([["1 of 1"]]);
  });

  test("a slot holding a task is never the one taken off the screen", () => {
    // Given an agent whose second slot is busy and whose first is idle
    const toggles: Toggles = new Toggles();
    const view = viewOf({
      slots: [
        idleRow(SLOTS[0], 2),
        busyRow({ ...SLOTS[1], total: 2, task_id: "000123" }),
      ],
    });

    // When one slot is given up
    toggles.push({ command: "slots", agent: AGENT, total: 1 });

    // Then the idle one leaves and the transcript being drawn is left alone
    expect(toggles.apply(view).slots.map((slot) => slot.name)).toEqual([
      SLOTS[1].name,
    ]);
  });

  test("a count the server never applied resets after two views", () => {
    // Given an agent asked for a third slot
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "slots", agent: AGENT, total: 3 });

    // When two views in a row still report two slots
    // Then the first is taken as stale and the second gives the server back
    expect(counted(toggles, 2, 2, 2)).toEqual([
      ["1 of 3", "2 of 3", "3 of 3 loading"],
      ["1 of 2", "2 of 2"],
      ["1 of 2", "2 of 2"],
    ]);
  });

  test("a count the server applied is followed from then on", () => {
    // Given an agent asked for a third slot
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "slots", agent: AGENT, total: 3 });

    // When the view catches up, the pane it drew is the one the server published
    // Then the clicked count is let go of, and later views are drawn as published
    expect(counted(toggles, 3, 4)).toEqual([
      ["1 of 3", "2 of 3", "3 of 3"],
      ["1 of 4", "2 of 4", "3 of 4", "4 of 4"],
    ]);
  });

  test("aborting a slot is not a switch to hold", () => {
    // Given a slot abort clicked rather than a switch
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "slot_abort", slot: SLOTS[0].name });

    // When a view arrives
    // Then it is drawn exactly as it was published
    expect(enabled(toggles, true)).toEqual([[true, true]]);
  });
});
