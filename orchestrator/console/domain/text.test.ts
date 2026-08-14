import { describe, expect, test } from "bun:test";
import {
  type Line,
  charWidth,
  clip,
  drop,
  pad,
  renderLine,
  spanWidth,
  take,
  textWidth,
  wrap,
} from "./text.ts";

function plain(line: Line): string {
  return line.map((span) => span.text).join("");
}

describe("Feature: how wide a piece of text draws", () => {
  test("an ascii letter draws in a single column", () => {
    // Given a plain ascii letter
    const letter = "a";

    // When it is measured in terminal columns
    const width = charWidth(letter);

    // Then it takes the one column a narrow character takes
    expect(width).toBe(1);
  });

  test("an ellipsis draws in a single column", () => {
    // Given the ellipsis character on its own
    const ellipsis = "…";

    // When it is measured in terminal columns
    const width = charWidth(ellipsis);

    // Then it takes one column
    expect(width).toBe(1);
  });

  test("a bare checkmark draws in a single column", () => {
    // Given the checkmark character on its own
    const checkmark = "✔";

    // When it is measured in terminal columns
    const width = charWidth(checkmark);

    // Then it takes one column
    expect(width).toBe(1);
  });

  test("a checkmark with a variation selector draws wide", () => {
    // Given a checkmark followed by the emoji variation selector
    const checkmark = "✔️";

    // When it is measured in terminal columns
    const width = charWidth(checkmark);

    // Then it takes two columns
    expect(width).toBe(2);
  });

  test("a fire emoji draws wide", () => {
    // Given the fire emoji on its own
    const fire = "🔥";

    // When it is measured in terminal columns
    const width = charWidth(fire);

    // Then it takes two columns
    expect(width).toBe(2);
  });

  test("a cjk character draws wide", () => {
    // Given a cjk character on its own
    const cjk = "漢";

    // When it is measured in terminal columns
    const width = charWidth(cjk);

    // Then it takes two columns
    expect(width).toBe(2);
  });

  test("a keycap draws wide", () => {
    // Given the keycap emoji, made of a digit and a combining cap
    const keycap = "1️⃣";

    // When it is measured in terminal columns
    const width = charWidth(keycap);

    // Then it takes two columns
    expect(width).toBe(2);
  });

  test("a family built from several code points draws as one wide cluster", () => {
    // Given a family emoji joined from several code points
    const family = "👨‍👩‍👧";

    // When it is measured in terminal columns
    const width = textWidth(family);

    // Then it takes two columns, not one for each code point
    expect(width).toBe(2);
  });

  test("a flag built from two regional indicators draws as one wide cluster", () => {
    // Given a flag made of two joined regional indicators
    const flag = "🇺🇸";

    // When it is measured in terminal columns
    const width = textWidth(flag);

    // Then it takes two columns, not one for each indicator
    expect(width).toBe(2);
  });

  test("the width of a string counts columns rather than code points", () => {
    // Given a string with an emoji in it
    const text = "ok 🔥";

    // When the string is measured
    const width = textWidth(text);

    // Then the emoji is counted as the two columns it draws in
    expect(width).toBe(5);
  });
});

describe("Feature: clipping a line to the width it has", () => {
  test("a line too long for its pane ends in an ellipsis", () => {
    // Given a line wider than the pane it must fit
    const line: Line = [{ text: "hello world", sgr: "2" }];

    // When it is clipped to eight columns
    const clipped = clip(line, 8);

    // Then it ends in an ellipsis and fills exactly the width it was given
    expect(plain(clipped)).toBe("hello w…");
    expect(spanWidth(clipped)).toBe(8);

    // Then every piece of it keeps the colour it was written in
    expect(clipped.every((span) => span.sgr === "2")).toBe(true);
  });

  test("a line that fits exactly is left as it was", () => {
    // Given a line exactly as wide as its pane
    const line: Line = [{ text: "abcd" }];

    // When it is clipped to that width
    const clipped = clip(line, 4);

    // Then nothing is cut and no ellipsis is added
    expect(clipped).toEqual([{ text: "abcd" }]);
  });

  test("a pane with no width at all draws nothing", () => {
    // Given a line and a pane with no room in it
    const line: Line = [{ text: "abcd" }];

    // When the line is clipped to no columns
    const clipped = clip(line, 0);

    // Then nothing is drawn, rather than an ellipsis on its own
    expect(clipped).toEqual([]);
  });

  test("an emoji is never allowed to spill past the width", () => {
    // Given a line whose emoji straddles the column it would be cut at
    const line: Line = [{ text: "ab🔥cd" }];

    // When it is clipped to four columns
    const clipped = clip(line, 4);

    // Then the emoji is dropped whole, and the line stays inside its pane
    expect(plain(clipped)).toBe("ab…");
    expect(spanWidth(clipped)).toBeLessThanOrEqual(4);
  });

  test("emoji that fill the width exactly are all kept", () => {
    // Given a line of two emoji, four columns wide
    const line: Line = [{ text: "🔥🔥" }];

    // When it is clipped to four columns
    const clipped = clip(line, 4);

    // Then both are kept, because neither straddles the edge
    expect(plain(clipped)).toBe("🔥🔥");
  });
});

describe("Feature: padding a line out to its pane", () => {
  test("a short line is filled out to the width of the pane", () => {
    // Given a line narrower than its pane
    const line: Line = [{ text: "ab" }];

    // When it is padded to six columns
    const padded = pad(line, 6);

    // Then it fills the pane, so the pane beside it starts where it should
    expect(spanWidth(padded)).toBe(6);
  });

  test("a long line is cut to the width of the pane", () => {
    // Given a line wider than its pane
    const line: Line = [{ text: "abcdefgh" }];

    // When it is padded to six columns
    const padded = pad(line, 6);

    // Then it is cut back to the pane rather than overflowing it
    expect(spanWidth(padded)).toBe(6);
  });

  test("the column a clipped emoji could not use is filled with a space", () => {
    // Given a line whose emoji cannot fit in the columns left
    const line: Line = [{ text: "ab🔥cd" }];

    // When it is padded to four columns
    const padded = pad(line, 4);

    // Then the pane is still filled exactly, with a space where the emoji was
    expect(spanWidth(padded)).toBe(4);
  });
});

describe("Feature: splitting a line at a column", () => {
  test("taking a prefix cuts at the column with no ellipsis", () => {
    // Given a line wider than the cut
    const line: Line = [{ text: "hello world" }];

    // When the first five columns are taken
    const head = take(line, 5);

    // Then the text is simply cut, because this is a split and not a clip
    expect(plain(head)).toBe("hello");
  });

  test("taking a prefix across two spans keeps their colours", () => {
    // Given a line of two spans written in different colours
    const line: Line = [{ text: "ab", sgr: "2" }, { text: "cd" }];

    // When the first three columns are taken
    const head = take(line, 3);

    // Then each piece keeps the colour of the span it came from
    expect(head).toEqual([
      { text: "ab", sgr: "2" },
      { text: "c", sgr: undefined },
    ]);
  });

  test("an emoji straddling the cut is replaced by the space it left", () => {
    // Given a line whose emoji straddles the column being cut at
    const line: Line = [{ text: "ab🔥cd" }];

    // When the first three columns are taken
    const head = take(line, 3);

    // Then the emoji is dropped and its half column becomes a space
    expect(plain(head)).toBe("ab ");
    expect(spanWidth(head)).toBe(3);
  });

  test("dropping a prefix keeps everything past the column", () => {
    // Given a line wider than the cut
    const line: Line = [{ text: "hello world" }];

    // When the first six columns are dropped
    const tail = drop(line, 6);

    // Then what is left is everything after them
    expect(plain(tail)).toBe("world");
  });

  test("dropping a whole span leaves only the spans after it", () => {
    // Given a line of two spans
    const line: Line = [{ text: "ab", sgr: "2" }, { text: "cd" }];

    // When the columns of the first span are dropped
    const tail = drop(line, 2);

    // Then only the second span is left, untouched
    expect(tail).toEqual([{ text: "cd" }]);
  });

  test("an emoji straddling the drop is replaced by the space it left", () => {
    // Given a line whose emoji straddles the column being cut at
    const line: Line = [{ text: "ab🔥cd" }];

    // When the first three columns are dropped
    const tail = drop(line, 3);

    // Then the emoji is dropped and its half column becomes a space
    expect(plain(tail)).toBe(" cd");
    expect(spanWidth(tail)).toBe(3);
  });

  test("the two halves of a split always add up to the whole line", () => {
    // Given a line with an emoji in it, split at every column in turn
    const line: Line = [{ text: "ab🔥cd", sgr: "2" }, { text: "ef" }];

    // When each split is measured on both sides
    const totals = Array.from(
      { length: spanWidth(line) + 1 },
      (_, at) => spanWidth(take(line, at)) + spanWidth(drop(line, at)),
    );

    // Then no column is ever lost or gained, wherever the cut falls
    expect(totals).toEqual(totals.map(() => spanWidth(line)));
  });
});

describe("Feature: turning a line into what the terminal reads", () => {
  test("a coloured span is wrapped in escapes and plain text is left alone", () => {
    // Given a line with one coloured span and one plain one
    const line: Line = [{ text: "a", sgr: "2" }, { text: "b" }];

    // When the line is rendered for the terminal
    const rendered = renderLine(line);

    // Then only the coloured span carries escapes, and it closes them again
    expect(rendered).toBe("\x1b[2ma\x1b[0mb");
  });
});

describe("Feature: wrapping a transcript entry", () => {
  test("text wraps on word boundaries, with a narrower first line", () => {
    // Given an entry whose first line is shortened by its timestamp and label
    const text = "aaa bbb ccc ddd";

    // When it is wrapped to seven columns first and eleven after
    const lines = wrap(text, 7, 11);

    // Then it breaks between words rather than inside them
    expect(lines).toEqual(["aaa bbb", "ccc ddd"]);
  });

  test("a word longer than the pane is split rather than overflowing", () => {
    // Given a single word wider than the pane
    const text = "abcdefghij";

    // When it is wrapped to four columns
    const lines = wrap(text, 4, 4);

    // Then it is broken across as many lines as it needs
    expect(lines).toEqual(["abcd", "efgh", "ij"]);
  });

  test("an entry with no text still takes up one line", () => {
    // Given an entry with nothing in it
    const text = "";

    // When the empty entry is wrapped to the pane
    const lines = wrap(text, 10, 10);

    // Then it still occupies a line, so the transcript keeps its shape
    expect(lines).toEqual([""]);
  });

  test("wrapping counts emoji columns rather than code points", () => {
    // Given text whose emoji fill the pane
    const text = "🔥🔥 ab";

    // When it is wrapped to four columns
    const lines = wrap(text, 4, 4);

    // Then the break falls where the columns run out, not where the words do
    expect(lines).toEqual(["🔥🔥", "ab"]);
  });

  test("an emoji wider than the pane still makes progress", () => {
    // Given a pane one column wide and emoji two columns wide
    const text = "🔥🔥";

    // When the text is wrapped to that pane
    const lines = wrap(text, 1, 1);

    // Then each emoji takes a line of its own rather than looping forever
    expect(lines).toEqual(["🔥", "🔥"]);
  });
});
