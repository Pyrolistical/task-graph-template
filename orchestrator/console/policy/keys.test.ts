import { describe, expect, test } from "bun:test";
import { present } from "../../testing/present.ts";
import { hitAt, keys, mouse, within } from "./keys.ts";
import type { Hit } from "../domain/hits.ts";

describe("Feature: reading a chunk of terminal input", () => {
  test("a burst of wheel events is read as every event in it", () => {
    // Given three wheel reports that arrived in one read
    const chunk = "\x1b[<64;10;20M\x1b[<64;10;20M\x1b[<64;10;20M";

    // When the chunk is split into keys
    const found = keys(chunk);

    // Then each scroll counts, rather than the burst counting once
    expect(found).toEqual([
      "\x1b[<64;10;20M",
      "\x1b[<64;10;20M",
      "\x1b[<64;10;20M",
    ]);
  });

  test("arrow keys held down are read as one key each", () => {
    // Given a chunk of arrow key presses from a held key
    const chunk = "\x1b[A\x1b[A\x1b[B";

    // When the chunk is split into keys
    const found = keys(chunk);

    // Then each press moves the scroll by one, as it would typed slowly
    expect(found).toEqual(["\x1b[A", "\x1b[A", "\x1b[B"]);
  });

  test("ordinary characters are one key each", () => {
    // Given a chunk of plain keys typed quickly
    const chunk = "jjkq";

    // When the chunk is split into keys
    const found = keys(chunk);

    // Then each character is its own key
    expect(found).toEqual(["j", "j", "k", "q"]);
  });

  test("page keys keep the tilde that ends them", () => {
    // Given page down followed by page up
    const chunk = "\x1b[6~\x1b[5~";

    // When the chunk is split into keys
    const found = keys(chunk);

    // Then each sequence is kept whole, tilde and all
    expect(found).toEqual(["\x1b[6~", "\x1b[5~"]);
  });
});

describe("Feature: where the mouse was clicked", () => {
  test("a press reports its button and the cell it landed in", () => {
    // Given an sgr mouse report of a press in the terminal's twelfth column
    const report = "\x1b[<0;12;3M";

    // When it is read as a mouse event
    const event = mouse(report);

    // Then the cell is zero-based, so it lines up with what was drawn
    expect(event).toEqual({ button: 0, column: 11, row: 2, pressed: true });
  });

  test("a release is told apart from a press", () => {
    // Given an sgr mouse report ending in a lowercase m
    const report = "\x1b[<0;12;3m";

    // When it is read as a mouse event
    const event = present(mouse(report), "a mouse event");

    // Then it reads as a release rather than a press
    expect(event.pressed).toBe(false);
  });

  test("a key that is not a mouse report is not one", () => {
    // Given an arrow key rather than a mouse report
    const report = "\x1b[A";

    // When it is read as a mouse event
    const event = mouse(report);

    // Then nothing comes back, and the key is handled as a key
    expect(event).toBeUndefined();
  });

  test("a click inside a switch sends the command that switch carries", () => {
    // Given the scheduler switch occupying the first four columns of the top row
    const hits: Hit[] = [
      {
        row: 0,
        from: 0,
        to: 4,
        command: { command: "scheduler", enabled: true },
      },
    ];

    // When a click lands inside it
    const command = hitAt(
      hits,
      present(mouse("\x1b[<0;4;1M"), "a mouse event"),
    );

    // Then the switch's command is the one that goes to the server
    expect(command).toEqual({ command: "scheduler", enabled: true });
  });

  test("a click past the end of a switch sends nothing", () => {
    // Given the scheduler switch occupying the first four columns of the top row
    const hits: Hit[] = [
      {
        row: 0,
        from: 0,
        to: 4,
        command: { command: "scheduler", enabled: true },
      },
    ];

    // When a click lands one column past it
    const command = hitAt(
      hits,
      present(mouse("\x1b[<0;5;1M"), "a mouse event"),
    );

    // Then nothing is sent, because the click hit no target
    expect(command).toBeUndefined();
  });

  test("a click on the row below a switch sends nothing", () => {
    // Given the scheduler switch occupying the first four columns of the top row
    const region = { row: 0, from: 0, to: 4 };

    // When a click lands in the same columns one row down
    const inside = within(
      region,
      present(mouse("\x1b[<0;1;2M"), "a mouse event"),
    );

    // Then it is outside the switch, because a target is one row tall
    expect(inside).toBe(false);
  });
});
