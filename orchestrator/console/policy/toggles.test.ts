import { describe, expect, test } from "bun:test";
import { idleRow } from "../../agents/domain/slots.ts";
import { SLOTS, viewOf } from "../../testing/console.ts";
import { Toggles } from "./toggles.ts";

const AGENT = SLOTS[0].agent;

const pool = (enabled: boolean) =>
  viewOf({ slots: SLOTS.map((slot) => idleRow(slot, enabled)) });

const enabled = (toggles: Toggles, ...views: boolean[]): boolean[][] =>
  views.map((state) =>
    toggles.apply(pool(state)).slots.map((slot) => slot.enabled),
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

  test("aborting a slot is not a switch to hold", () => {
    // Given a slot abort clicked rather than a switch
    const toggles: Toggles = new Toggles();
    toggles.push({ command: "slot_abort", slot: SLOTS[0].name });

    // When a view arrives
    // Then it is drawn exactly as it was published
    expect(enabled(toggles, true)).toEqual([[true, true]]);
  });
});
