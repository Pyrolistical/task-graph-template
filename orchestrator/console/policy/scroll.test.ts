import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { at } from "../../testing/present.ts";
import { type Line, pad, renderLine, spanWidth } from "../domain/text.ts";
import { PaneLines, entryLines } from "./panes.ts";
import { NEWS, newsButton, newsRegion, overlay } from "./screen.ts";
import {
  type Scroll,
  HEADER_LINES,
  QUEUE_LINES,
  baseOf,
  body,
  bodyHeight,
  scrollBack,
  scrollBottom,
  scrollForward,
  scrollTop,
} from "./scroll.ts";
import { type Mouse, within } from "./keys.ts";
import { entryOf, plain } from "../../testing/console.ts";

const NOW = new Date("2026-01-01").getTime();

beforeAll(() => {
  setSystemTime(NOW);
});

afterAll(() => {
  setSystemTime();
});

describe("Feature: which lines of a transcript a pane shows", () => {
  function linesOf(texts: string[], width = 40): Line[] {
    return new PaneLines().update(
      texts.map((text) => entryOf(text)),
      width,
    );
  }

  function shown(lines: Line[]): string {
    return lines.map(renderLine).join("");
  }

  test("a following pane shows the newest lines when they overflow it", () => {
    // Given three lines of transcript and a pane two rows tall
    const lines = linesOf(["one", "two", "three"]);

    // When the pane is drawn while following the bottom
    const drawn = body(lines, 2, baseOf(lines.length, 2, undefined), 0);

    // Then it shows the newest lines and drops the oldest
    expect(drawn).toHaveLength(2);
    expect(shown(drawn)).toContain("three");
    expect(shown(drawn)).not.toContain("one");
  });

  test("scrolling back by a line reveals the line above", () => {
    // Given three lines of transcript and a pane one row tall
    const lines = linesOf(["one", "two", "three"]);

    // When the pane is drawn one line back from the bottom
    const drawn = body(lines, 1, baseOf(lines.length, 1, undefined), 1);

    // Then the line above the newest is what is shown
    expect(shown(drawn)).toContain("two");
  });

  test("scrolling back further than there is history stops at the top", () => {
    // Given three lines of transcript and a pane one row tall
    const lines = linesOf(["one", "two", "three"]);

    // When the pane is drawn far further back than it has history
    const drawn = body(lines, 1, baseOf(lines.length, 1, undefined), 99);

    // Then it shows the first line rather than scrolling past it
    expect(shown(drawn)).toBe(shown(body(lines, 1, 0, 0)));
  });

  test("a frozen anchor past the end of a shrunken pane is pulled back", () => {
    // Given a pane frozen at a line the transcript no longer reaches
    const frozen = 500;

    // When the anchor is worked out for a pane with one line in it
    const base = baseOf(1, 5, frozen);

    // Then it is pulled back to the top, which is as far as the pane goes
    expect(base).toBe(0);
  });

  test("lines arriving below a scrolled pane do not move what it shows", () => {
    // Given a scrolled pane showing a fixed part of its transcript
    const cache: PaneLines = new PaneLines();
    const entries = ["one", "two", "three", "four"].map((text) =>
      entryOf(text),
    );
    const base = baseOf(cache.update(entries, 40).length, 2, undefined);
    const before = shown(body(cache.update(entries, 40), 2, base, 1));

    // Given two more lines arriving under it
    entries.push(entryOf("five"), entryOf("six"));

    // When the pane is shown again
    const after = shown(
      body(cache.update(entries, 40), 2, baseOf(6, 2, base), 1),
    );

    // Then the reader is still looking at the same lines
    expect(before).toContain("two");
    expect(after).toBe(before);
  });

  test("lines arriving under a following pane do move it", () => {
    // Given a pane following the bottom of its transcript
    const cache: PaneLines = new PaneLines();
    const entries = ["one", "two"].map((text) => entryOf(text));

    // Given another line arriving under the pane
    entries.push(entryOf("three"));

    // When the cache is updated
    const lines = cache.update(entries, 40);

    // Then the pane moves down to it
    expect(
      shown(body(lines, 2, baseOf(lines.length, 2, undefined), 0)),
    ).toContain("three");
  });

  test("panes of different lengths scroll by the same number of lines", () => {
    // Given one short transcript and one long one, in panes of the same height
    const short = linesOf(["a1", "a2", "a3"]);
    const long = linesOf(["b1", "b2", "b3", "b4", "b5", "b6"]);
    const step = (lines: Line[], offset: number) =>
      shown(body(lines, 2, baseOf(lines.length, 2, undefined), offset));

    // When both are scrolled back by two lines
    const stepped = [step(short, 1), step(long, 1)];

    // Then each has moved two lines from its own bottom, not to a shared line
    expect(step(short, 0)).toContain("a3");
    expect(step(long, 0)).toContain("b6");
    expect(stepped[0]).toContain("a1");
    expect(stepped[1]).toContain("b4");
  });

  test("a pane that runs out of history waits at its top for the others", () => {
    // Given a transcript shorter than the pane and one longer than it
    const short = linesOf(["a1", "a2"]);
    const long = linesOf(["b1", "b2", "b3", "b4"]);

    // When both are scrolled back by one line
    const scrolled = [
      shown(body(short, 2, baseOf(2, 2, undefined), 1)),
      shown(body(long, 2, baseOf(4, 2, undefined), 1)),
    ];

    // Then the short one stays at its first line while the long one keeps going
    expect(scrolled[0]).toContain("a1");
    expect(scrolled[1]).toContain("b2");
    expect(scrolled[1]).not.toContain("b4");
  });

  test("the body leaves room for the queue line, the header and its rule", () => {
    // Given a terminal twenty-four rows tall
    const rows = 24;

    // When the height left for the transcript is worked out
    const height = bodyHeight(rows);

    // Then the rows the queue and the header take are all subtracted
    expect(height).toBe(rows - QUEUE_LINES - HEADER_LINES - 1);
  });

  test("a usage record is not drawn in the transcript", () => {
    // Given a transcript whose only entry is a usage record
    const entries = [entryOf("hidden", "usage")];

    // When the pane's lines are built
    const lines = new PaneLines().update(entries, 40);

    // Then nothing is drawn, because usage belongs on the header
    expect(lines).toEqual([]);
  });

  test("a wide pane keeps the timestamp and label on the first line", () => {
    // Given an entry that fits comfortably in its pane
    const entry = entryOf("hello there", "assistant");

    // When the entry is laid out for a forty-column pane
    const lines = entryLines(entry, 40);

    // Then it is one line, led by the time and who said it
    expect(lines).toHaveLength(1);
    expect(plain(at(lines, 0))).toBe("00:00:00 assistant: hello there");
  });

  test("a pane too narrow for the prefix puts the text on its own lines", () => {
    // Given an entry whose prefix alone would fill the pane
    const entry = entryOf("hello there", "assistant");

    // When the entry is laid out for a fourteen-column pane
    const lines = entryLines(entry, 14);

    // Then the prefix takes a line of its own and the text follows below it
    expect(lines.length).toBeGreaterThan(1);
    expect(plain(at(lines, 0))).toBe("00:00:00 assi…");
    expect(lines.slice(1).map(plain).join(" ")).toContain("hello");
  });
});

describe("Feature: scrolling every pane together", () => {
  function mouseAt(column: number, row: number): Mouse {
    return { button: 0, column, row, pressed: true };
  }

  test("the first step back freezes where every pane's bottom was", () => {
    // Given every pane following the bottom of its own transcript
    const scroll: Scroll = { bases: undefined, offsets: [] };

    // When the reader steps back one line
    scrollBack(scroll, [4, 9], 1);

    // Then each pane's bottom is pinned, and both move by the same one line
    expect(scroll).toEqual({ bases: [4, 9], offsets: [1, 1] });
  });

  test("later steps back keep the bottoms that were already frozen", () => {
    // Given panes already scrolled back, with their bottoms pinned
    const scroll: Scroll = { bases: [4, 9], offsets: [1, 1] };

    // When the reader steps back two more lines, after new lines arrived
    scrollBack(scroll, [7, 12], 2);

    // Then the pinned bottoms are kept, so the new lines do not shift the view
    expect(scroll).toEqual({ bases: [4, 9], offsets: [3, 3] });
  });

  test("a pane that runs out of history stops without holding the others", () => {
    // Given one pane with four lines of history and one with nine
    const scroll: Scroll = { bases: undefined, offsets: [] };

    // When the reader steps back six lines
    scrollBack(scroll, [4, 9], 6);

    // Then the short pane stops at its top while the long one goes the full six
    expect(scroll.offsets).toEqual([4, 6]);
  });

  test("a pane at its top moves forward with the rest", () => {
    // Given both panes scrolled to the top of their history
    const scroll: Scroll = { bases: [4, 9], offsets: [4, 9] };

    // When the reader moves forward two lines
    scrollForward(scroll, 2);

    // Then both move together, rather than the short one waiting
    expect(scroll.offsets).toEqual([2, 7]);
  });

  test("moving forward while already following does nothing", () => {
    // Given every pane following the bottom of its own transcript
    const scroll: Scroll = { bases: undefined, offsets: [] };

    // When the reader moves forward
    scrollForward(scroll, 3);

    // Then nothing changes, because there is nothing below the bottom
    expect(scroll).toEqual({ bases: undefined, offsets: [] });
  });

  test("every pane reaching its bottom puts the console back into following", () => {
    // Given panes scrolled back far enough that one is two lines from its bottom
    const scroll: Scroll = { bases: [4, 9], offsets: [2, 2] };

    // When the reader moves forward past the bottom of both
    scrollForward(scroll, 3);

    // Then the frozen bottoms are dropped and the console follows again
    expect(scroll).toEqual({ bases: undefined, offsets: [] });
  });

  test("the top key takes every pane to its first line", () => {
    // Given every pane following the bottom of its own transcript
    const scroll: Scroll = { bases: undefined, offsets: [] };

    // When the reader jumps to the top
    scrollTop(scroll, [4, 9]);

    // Then each pane is scrolled back by the whole of its own history
    expect(scroll).toEqual({ bases: [4, 9], offsets: [4, 9] });
  });

  test("the bottom key puts the console back into following", () => {
    // Given panes scrolled back from their bottoms
    const scroll: Scroll = { bases: [4, 9], offsets: [3, 3] };

    // When the reader jumps to the bottom
    scrollBottom(scroll);

    // Then the frozen bottoms are dropped and the console follows again
    expect(scroll).toEqual({ bases: undefined, offsets: [] });
  });

  test("the new messages button sits centred one row above the bottom", () => {
    // Given a terminal a hundred columns wide and twelve rows tall
    const columns = 100;

    // When the button's place on the screen is worked out
    const region = newsRegion(columns, 12);

    // Then it is one row up from the bottom and centred across the terminal
    expect(region.row).toBe(10);
    expect(region.to - region.from).toBe(spanWidth(newsButton()));
    expect(region.from).toBe(
      Math.floor((columns - (region.to - region.from)) / 2),
    );
  });

  test("the button is laid over a row without moving its columns", () => {
    // Given a full-width row of a pane, and where the button belongs
    const line = pad([{ text: "the pane", sgr: "2" }], 40);
    const region = { row: 10, from: 10, to: 10 + spanWidth(newsButton()) };

    // When the button is laid over that row
    const merged = overlay(line, newsButton(), region);

    // Then the row is still exactly as wide, with the button in its columns
    expect(spanWidth(merged)).toBe(40);
    expect(plain(merged).slice(region.from, region.to)).toBe(NEWS);
  });

  test("a click lands on the button only inside the columns it covers", () => {
    // Given the button drawn on a hundred-column terminal
    const region = newsRegion(100, 12);

    // When clicks are tried at its edges and one row above it
    const hits = [
      within(region, mouseAt(region.from, region.row)),
      within(region, mouseAt(region.to, region.row)),
      within(region, mouseAt(region.from, region.row - 1)),
    ];

    // Then only the click inside its own row and columns counts
    expect(hits).toEqual([true, false, false]);
  });
});
