import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { at, present } from "../../testing/present.ts";
import { type Activity, elapsed } from "../../views/activity.ts";
import { idleRow, slotAt } from "../../agents/domain/slots.ts";
import {
  type Line,
  pad,
  renderLine,
  spanWidth,
  textWidth,
} from "../domain/text.ts";
import {
  type Scroll,
  HEADER_LINES,
  MIN_PANE_WIDTH,
  NEWS,
  PaneLines,
  QUEUE_LINES,
  COLLAPSED_WIDTH,
  HIDE,
  LOADING,
  SHOW,
  emptyPool,
  errorFrame,
  panes,
  SWITCH_OFF,
  SWITCH_ON,
  abortButton,
  activityLine,
  baseOf,
  body,
  bodyHeight,
  detailLine,
  FEWER,
  MORE,
  entryLines,
  header,
  newsButton,
  newsRegion,
  overlay,
  paneWidth,
  queueHeader,
  screen,
  scrollBack,
  scrollBottom,
  scrollForward,
  scrollTop,
  slotButtons,
  slotLabel,
  statsLine,
  thousands,
  toggle,
  topOf,
} from "./console.ts";
import { type Mouse, hitAt, within } from "./keys.ts";
import {
  SLOTS,
  busyRow,
  candidateOf,
  entryOf,
  layoutOf,
  paneOf,
  plain,
  viewOf,
} from "../../testing/console.ts";

const NOW = new Date("2026-01-01").getTime();

beforeAll(() => {
  setSystemTime(NOW);
});

afterAll(() => {
  setSystemTime();
});

const bare = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("Feature: joining a slot to the task it is running", () => {
  test("an agent is shown with its task and the check running against it", () => {
    // Given a view where a check is running on the task the agent holds
    const view = {
      checks: [
        {
          task_id: "000123",
          index: 1,
          command: "bun test",
          pid: 99,
          started_at: new Date(0).toISOString(),
          log: "/tmp/check-1.log",
        },
      ],
    };

    // When the view is joined into one pane per slot
    const pane = paneOf(view);

    // Then the pane carries the task's state and the check's command
    expect(pane.task?.state).toBe("WORK");
    expect(pane.check?.command).toBe("bun test");

    // Then the detail line names the task, the role and the process
    expect(detailLine(pane)).toBe("task 000123 worker WORK pid 4242");

    // Then the running check is what the pane says the agent is doing
    expect(activityLine(pane)).toBe("check 1: bun test");
  });

  test("a disabled slot's pane is drawn to the right of a running one", () => {
    // Given a view whose first slot is disabled and whose second is running
    const view = {
      slots: [idleRow(SLOTS[0], SLOTS.length, false), busyRow({ ...SLOTS[1] })],
    };

    // When the view is joined into one pane per slot
    const drawn = panes(viewOf(view));

    // Then the running slot comes first, so the disabled ones group at the right
    expect(drawn.map((pane) => pane.slot.enabled)).toEqual([true, false]);
    expect(at(drawn, 0).slot.name).toBe(SLOTS[1].name);
  });

  test("an unreachable slot says why it is holding no task", () => {
    // Given a view whose only slot is idle because its provider failed its health check
    const view = { slots: [idleRow(SLOTS[1], SLOTS.length, true, false)] };

    // When the pane's detail line is drawn
    const detail = detailLine(paneOf(view));

    // Then it says the provider is what is holding the slot, not that there is no work
    expect(detail).toBe("provider not answering");
  });

  test("a slot outside its schedule says why it is holding no task", () => {
    // Given a view whose only slot is idle because the clock is outside its schedule
    const view = {
      slots: [idleRow(SLOTS[1], SLOTS.length, true, true, false)],
    };

    // When the pane's detail line is drawn
    const detail = detailLine(paneOf(view));

    // Then it says the schedule is what is holding the slot, not that there is no work
    expect(detail).toBe("outside its schedule");
  });

  test("an idle slot shows no task, no check and no clock", () => {
    // Given a view whose only slot is idle
    const view = { slots: [idleRow(SLOTS[1], SLOTS.length)] };

    // When the view is joined into one pane per slot
    const pane = paneOf(view);

    // Then the pane has nothing to draw but the slot itself
    expect(pane.task).toBeUndefined();
    expect(pane.check).toBeUndefined();
    expect(pane.sinceMs).toBeUndefined();
    expect(detailLine(pane)).toBe("no task");
    expect(activityLine(pane)).toBe("");
    expect(statsLine(pane, undefined)).toBe("");
  });

  test("a task the view has dropped still draws from the agent row", () => {
    // Given a view whose task list no longer carries the task an agent holds
    const view = { tasks: [] };

    // When the view is joined into one pane per slot
    const pane = paneOf(view);

    // Then the pane still names the task and the role, without its state
    expect(pane.task).toBeUndefined();
    expect(detailLine(pane)).toBe("task 000123 worker pid 4242");
  });

  test("a slot waiting to retry shows when it will and which attempt", () => {
    // Given a slot backing off after a provider error
    const view = {
      slots: [
        busyRow({
          state: "WAITING",
          retry: { at: new Date(1000).toISOString(), attempt: 3 },
        }),
      ],
    };

    // When the pane's detail line is drawn
    const detail = detailLine(paneOf(view));

    // Then it says which attempt is next and at what time
    expect(detail).toContain("retry 3 at ");
  });
});

describe("Feature: the numbers on a pane header", () => {
  test("the stats line shows the token rate and the context left", () => {
    // Given a busy pane whose agent has used two-fifths of its context
    const pane = paneOf();

    // When the stats line is drawn with a measured rate
    const stats = statsLine(pane, 1234.56);

    // Then it reads as the rate and the context, both rounded for a terminal
    expect(stats).toBe("1.2k tok/s ctx 42%");
  });

  test("a session that has spent money has its cost after the context", () => {
    // Given a pane whose agent has spent forty-five cents on its session
    const pane = paneOf({ slots: [busyRow({ cost: 0.45 })] });

    // When the stats line is drawn
    const stats = statsLine(pane, undefined);

    // Then the cost follows the context percentage, rounded to cents
    expect(stats).toBe("ctx 42% $0.45");
  });

  test("a session that has spent nothing shows no cost", () => {
    // Given a pane whose agent runs a provider that charges nothing
    const pane = paneOf({ slots: [busyRow({ cost: 0 })] });

    // When the stats line is drawn
    const stats = statsLine(pane, undefined);

    // Then no cost is drawn, because a zero is a column spent on nothing
    expect(stats).toBe("ctx 42%");
  });

  test("an agent that has compacted has the count after its context", () => {
    // Given a pane whose agent has compacted three times on this task
    const pane = paneOf({ slots: [busyRow({ compactions: 3 })] });

    // When the stats line is drawn
    const stats = statsLine(pane, undefined);

    // Then the compaction count follows the context percentage
    expect(stats).toBe("ctx 42% x3");
  });

  test("a duration of seconds reads as whole seconds", () => {
    // Given a slot that has been running for five and a half seconds
    const measured = 5_400;

    // When it is written for a header
    const written = elapsed(measured);

    // Then it reads as five seconds, the largest unit that fits it
    expect(written).toBe("5s");
  });

  test("a duration past a minute reads as minutes and seconds", () => {
    // Given a slot that has been running for ninety-five seconds
    const measured = 95_000;

    // When it is written for a header
    const written = elapsed(measured);

    // Then it reads as one minute and thirty-five seconds
    expect(written).toBe("1m35s");
  });

  test("a duration past an hour reads as hours and minutes", () => {
    // Given a slot that has been running for an hour and three minutes
    const measured = 3_780_000;

    // When it is written for a header
    const written = elapsed(measured);

    // Then it reads as one hour and three minutes, dropping the seconds
    expect(written).toBe("1h03m");
  });

  test("a duration that ran backwards reads as no time at all", () => {
    // Given a duration measured across a clock that went backwards
    const measured = -5;

    // When it is written for a header
    const written = elapsed(measured);

    // Then it reads as zero, never as a negative time
    expect(written).toBe("0s");
  });

  test("a token count below a thousand is written out in full", () => {
    // Given a count of tokens below a thousand
    const used = 999;

    // When it is written for a header
    const written = thousands(used);

    // Then every digit of it is shown
    expect(written).toBe("999");
  });

  test("a token count past a thousand is abbreviated", () => {
    // Given a count of tokens past a thousand
    const used = 12_345;

    // When it is written for a header
    const written = thousands(used);

    // Then it is written in thousands, to one decimal place
    expect(written).toBe("12.3k");
  });
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

describe("Feature: keeping a pane's wrapped lines between frames", () => {
  test("lines already wrapped are kept rather than wrapped again", () => {
    // Given a pane whose transcript has already been laid out
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("one"), entryOf("two"), entryOf("three")];
    const before = cache.update(entries, 40);
    const kept = before[0];

    // Given another entry arriving below it
    entries.push(entryOf("four"));

    // When the pane is laid out again
    const after = cache.update(entries, 40);

    // Then the settled lines are the same objects, not rebuilt every frame
    expect(after[0]).toBe(kept);
    expect(after).toHaveLength(4);
  });

  test("the newest entry is laid out again, because it is still growing", () => {
    // Given a pane whose last entry is an answer still being streamed
    const cache: PaneLines = new PaneLines();
    const last = entryOf("thinking");
    const entries = [entryOf("one"), last];
    cache.update(entries, 40);

    // When more text arrives on that last entry
    last.text = "thinking deeper";

    // Then the pane redraws it rather than showing the half of it it cached
    expect(renderLine(at(cache.update(entries, 40), 1))).toContain(
      "thinking deeper",
    );
  });

  test("a resized terminal rebuilds every line of the pane", () => {
    // Given a pane laid out for a narrow terminal
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("a line that will have to wrap somewhere")];
    const narrow = cache.update(entries, 20);

    // When the terminal is widened and the pane laid out again
    const wide = cache.update(entries, 80);

    // Then the lines are rewrapped to the new width and cached at it
    expect(wide.length).toBeLessThan(narrow.length);
    expect(cache.update(entries, 80)).toEqual(wide);
  });

  test("a session rewritten from the start drops the lines it cached", () => {
    // Given a pane holding the lines of a session that has since been replaced
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("one"), entryOf("two"), entryOf("three")];
    cache.update(entries, 40);

    // Given a transcript that has come back shorter than it was
    entries.length = 0;
    entries.push(entryOf("fresh"));

    // When the pane is updated to the shorter transcript
    const refreshed = cache.update(entries, 40);

    // Then the old lines are thrown away and only the new session is drawn
    expect(renderLine(at(refreshed, 0))).toContain("fresh");
    expect(refreshed).toHaveLength(1);
  });
});

describe("Feature: drawing the whole screen", () => {
  function cells(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      pane: paneOf({
        slots: [busyRow({ ...SLOTS[index % SLOTS.length], task_id: "000123" })],
      }),
      rate: undefined,
      lines: (width: number) =>
        new PaneLines().update([entryOf("working")], width),
    }));
  }

  function deep(count: number) {
    const many = cells(2);
    at(many, 0).lines = (width: number) =>
      new PaneLines().update(
        Array.from({ length: count }, (_, index) => entryOf(`line ${index}`)),
        width,
      );
    return many;
  }

  function disabledCell(index: number) {
    return {
      pane: paneOf({
        slots: [idleRow(at(SLOTS, index % SLOTS.length), SLOTS.length, false)],
      }),
      rate: undefined,
      lines: (width: number) => new PaneLines().update([], width),
    };
  }

  test("a disabled pane carries a button to hide every disabled agent", () => {
    // Given one running slot and one whose agent has been turned off
    const panes = [at(cells(1), 0), disabledCell(1)];

    // When the screen is drawn
    const { lines, hits } = screen(panes, [], layoutOf());

    // Then the button sits in the middle of the disabled pane, and is a target
    const hide = hits.filter((hit) => hit.command.command === "hide_disabled");
    expect(hide).toHaveLength(1);
    const button = at(hide, 0);
    expect(bare(at(lines, button.row))).toContain(HIDE.trim());
    expect(button.from).toBeGreaterThan(paneWidth(100, 2));
  });

  test("two disabled panes share one button, centred across both", () => {
    // Given one running slot and two whose agents have been turned off
    const panes = [at(cells(1), 0), disabledCell(1), disabledCell(2)];

    // When the screen is drawn
    const { lines, hits } = screen(panes, [], layoutOf());

    // Then one button is drawn, in the middle of the two disabled panes
    const hide = hits.filter((hit) => hit.command.command === "hide_disabled");
    const width = paneWidth(100, 3);
    const span = { from: width + 1, to: 3 * width + 2 };
    expect(hide).toHaveLength(1);
    const button = at(hide, 0);
    expect(bare(at(lines, button.row))).toContain(HIDE.trim());
    expect(button.to - button.from).toBe(textWidth(HIDE));
    expect(button.from + button.to).toBe(span.from + span.to);
  });

  test("a screen with nothing running offers no button to hide with", () => {
    // Given two slots whose agents have both been turned off
    const panes = [disabledCell(0), disabledCell(1)];

    // When the screen is drawn
    const { lines, hits } = screen(panes, [], layoutOf());

    // Then nothing offers to hide, because hiding them would leave an empty screen
    expect(
      hits.filter((hit) => hit.command.command === "hide_disabled"),
    ).toEqual([]);
    expect(lines.join("\n")).not.toContain(HIDE.trim());
  });

  test("a running pane carries no button to hide anything", () => {
    // Given two slots that are both running
    const panes = cells(2);

    // When the screen is drawn
    const { lines, hits } = screen(panes, [], layoutOf());

    // Then nothing offers to hide, because there is nothing disabled to hide
    expect(
      hits.filter((hit) => hit.command.command === "hide_disabled"),
    ).toEqual([]);
    expect(lines.join("\n")).not.toContain(HIDE.trim());
  });

  test("hidden agents collapse to one column at the right of the screen", () => {
    // Given one running slot, and two disabled agents hidden away
    const panes = cells(1);

    // When the screen is drawn with them hidden
    const { lines } = screen(panes, [], layoutOf(), 2);

    // Then the column is eight columns wide, and the pane takes the rest
    const row = bare(at(lines, QUEUE_LINES));
    expect(row).toHaveLength(100);
    expect(row.indexOf("│")).toBe(100 - COLLAPSED_WIDTH - 1);
  });

  test("the collapsed column is flush right whatever the panes leave over", () => {
    // Given three running slots, whose widths do not divide the terminal evenly
    const panes = cells(3);

    // When the screen is drawn with two agents hidden away
    const { lines, hits } = screen(panes, [], layoutOf(), 2);

    // Then the column still ends at the last column, and its targets sit on it
    const show = hits.filter((hit) => hit.command.command === "show_disabled");
    const button = at(show, 0);
    expect(bare(at(lines, QUEUE_LINES))).toHaveLength(100);
    expect(bare(at(lines, 1)).lastIndexOf("┬")).toBe(100 - COLLAPSED_WIDTH - 1);
    expect(bare(at(lines, button.row)).slice(button.from, button.to)).toBe(
      at(SHOW, 0),
    );
  });

  test("the collapsed column says how to show the agents again", () => {
    // Given one running slot, and two disabled agents hidden away
    const panes = cells(1);

    // When the screen is drawn with them hidden
    const { lines, hits } = screen(panes, [], layoutOf(), 2);

    // Then the button reads down three lines, each of them a target
    const show = hits.filter((hit) => hit.command.command === "show_disabled");
    expect(show).toHaveLength(SHOW.length);
    expect(
      show.map((hit) => bare(at(lines, hit.row)).slice(hit.from, hit.to)),
    ).toEqual(SHOW);
  });

  test("a console that cannot draw says why in the middle of the screen", () => {
    // Given a failure that stopped the frame being drawn at all
    const message = "no server state at /tmp/task-graph-server/-repo";

    // When the screen is drawn from that failure
    const { lines } = errorFrame(message, layoutOf());

    // Then the message is centred, under a line saying the console cannot draw
    expect(lines).toHaveLength(12);
    expect(bare(at(lines, 5)).trim()).toBe("the console cannot draw");
    expect(bare(at(lines, 6)).trim()).toBe(message);
  });

  test("a console that cannot draw offers nothing to click on", () => {
    // Given a failure that stopped the frame being drawn at all
    const message = "no server state at /tmp/task-graph-server/-repo";

    // When the screen is drawn from that failure
    const frame = errorFrame(message, layoutOf());

    // Then there is no switch and nothing to scroll, because there is no pane
    expect(frame.hits).toEqual([]);
    expect(frame.bases).toEqual([]);
    expect(frame.news).toBeUndefined();
  });

  test("a pool with no agents says which file to add one to", () => {
    // Given a console whose server has no agent slots to draw
    const agentsFile = "/home/model/task-graph/project/agents.json";

    // When the screen is drawn
    const { lines } = emptyPool(
      [{ text: "the queue" }],
      layoutOf(),
      agentsFile,
    );

    // Then the queue stays on top and the file to edit is centred below it
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain("the queue");
    expect(bare(at(lines, 6))).toContain("the pool has no agents");
    expect(bare(at(lines, 7))).toContain(`add one to ${agentsFile}`);
  });

  test("a pool with no agents offers no pane to click on", () => {
    // Given a console whose server has no agent slots to draw
    const agentsFile = "/home/model/task-graph/project/agents.json";

    // When the screen is drawn
    const frame = emptyPool([{ text: "the queue" }], layoutOf(), agentsFile);

    // Then there is no switch and nothing to scroll, because there is no pane
    expect(frame.hits).toEqual([]);
    expect(frame.bases).toEqual([]);
    expect(frame.news).toBeUndefined();
  });

  test("the screen is exactly one line per row of the terminal", () => {
    // Given two panes on a terminal twelve rows tall
    const panes = cells(2);

    // When the screen is drawn
    const { lines } = screen(panes, [], layoutOf());

    // Then it fills the terminal exactly, without scrolling it
    expect(lines).toHaveLength(12);
  });

  test("the queue header is the first row, above every pane", () => {
    // Given two panes and a queue line to draw above them
    const panes = cells(2);

    // When the screen is drawn
    const { lines } = screen(panes, [{ text: "the queue" }], layoutOf());

    // Then the queue is the top row and the panes start below it
    expect(lines[0]).toContain("the queue");
    expect(lines[QUEUE_LINES]).toContain("slot 1 / 2");
  });

  test("a rule under the queue splits it from the panes", () => {
    // Given two panes and a queue line to draw above them
    const panes = cells(2);

    // When the screen is drawn
    const { lines } = screen(panes, [{ text: "the queue" }], layoutOf());

    // Then the second row is a full-width rule, forked where the panes divide
    const rule = bare(at(lines, 1));
    expect(rule).toContain("┬");
    expect(rule.indexOf("┬")).toBe(paneWidth(100, 2));
    expect(textWidth(rule)).toBe(100);
  });

  test("the divider between panes crosses where the header ends", () => {
    // Given two panes side by side
    const panes = cells(2);

    // When the screen is drawn
    const { lines } = screen(panes, [], layoutOf());

    // Then the divider is a plain bar until it crosses the header's rule
    expect(lines[QUEUE_LINES]).toContain("│");
    expect(lines[QUEUE_LINES]).not.toContain("┼");
    expect(lines[QUEUE_LINES + HEADER_LINES]).toContain("┼");
  });

  test("emoji in a transcript keep the divider in the same column", () => {
    // Given two screens differing only in the emoji one transcript carries
    const emoji = cells(2);
    at(emoji, 0).lines = (width: number) =>
      new PaneLines().update([entryOf("🔥 shipping 🚀 it")], width);
    const columnOf = (lines: string[], row: number) => {
      const line = bare(at(lines, row));
      return textWidth(line.slice(0, line.indexOf("│")));
    };

    // When the emoji screen is drawn
    const { lines } = screen(emoji, [], layoutOf());

    // Then the divider stands in the same column on every row of both
    const expected = screen(cells(2), [], layoutOf()).lines;
    const rows = Array.from({ length: 12 - QUEUE_LINES - HEADER_LINES - 1 })
      .map((_, index) => index + QUEUE_LINES + HEADER_LINES + 1)
      .map((row) => columnOf(lines, row) === columnOf(expected, row));
    expect(rows.filter((same) => !same)).toEqual([]);
  });

  test("lines arriving below a scrolled screen raise the new messages button", () => {
    // Given a screen scrolled back with more transcript below it
    const scroll = { bases: [0, 0], offsets: [0, 0] };

    // When the screen is drawn
    const { lines, news } = screen(deep(8), [], layoutOf({ scroll }));

    // Then the button appears, so the reader knows there is more to see
    expect(news).toEqual(newsRegion(100, 12));
    expect(lines[present(news, "a news region").row]).toContain(NEWS);
  });

  test("a screen that is following never shows the button", () => {
    // Given a screen following the bottom of a long transcript
    const panes = deep(8);

    // When the screen is drawn
    const drawn = screen(panes, [], layoutOf());

    // Then no button appears, because the reader is already at the newest line
    expect(drawn.news).toBeUndefined();
    expect(drawn.lines.join("")).not.toContain(NEWS);
  });

  test("a scrolled screen with nothing new below it shows no button", () => {
    // Given a screen frozen at the bottom its transcript already reached
    const bottom = topOf(8, bodyHeight(12));
    const scroll = { bases: [bottom, 0], offsets: [2, 0] };

    // When the screen is drawn
    const { news } = screen(deep(8), [], layoutOf({ scroll }));

    // Then no button appears, because nothing has arrived since it froze
    expect(news).toBeUndefined();
  });

  test("lines arriving do not move what a scrolled screen is showing", () => {
    // Given a scrolled screen and the same screen with two more lines in it
    const scroll: Scroll = { bases: [3, 0], offsets: [2, 0] };
    const rowsOf = (count: number) =>
      screen(deep(count), [], layoutOf({ scroll }))
        .lines.slice(QUEUE_LINES + HEADER_LINES + 1)
        .filter((_, index) => index !== 3);

    // When both of those screens are drawn
    const drawn = rowsOf(10);

    // Then the reader is looking at exactly the same transcript
    expect(drawn).toEqual(rowsOf(8));
  });

  test("the screen reports each pane's bottom, which bounds the scroll", () => {
    // Given two panes whose transcripts are shorter than the pane
    const panes = cells(2);

    // When the screen is drawn
    const { bases } = screen(panes, [], layoutOf());

    // Then each bottom is the top of the pane, so there is nothing to scroll to
    expect(bases).toEqual([0, 0]);
  });

  test("every pane's switch is a click target on its header row", () => {
    // Given two panes side by side
    const panes = cells(2);

    // When the screen is drawn
    const { hits } = screen(panes, [], layoutOf());

    // Then each pane offers a switch, on its header row and at its own column
    const toggles = hits.filter((hit) => hit.command.command === "agent");
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toMatchObject({ row: QUEUE_LINES, from: 0 });
    expect(at(toggles, 1).from).toBe(paneWidth(100, 2) + 1);

    // Then clicking one asks for the state its agent is not in
    expect(at(toggles, 0).command).toEqual({
      command: "agent",
      agent: SLOTS[0].agent,
      enabled: false,
    });
  });

  test("a pane inside a bash call offers an abort target on its activity row", () => {
    // Given one pane whose agent is inside a bash tool call
    const panes = cells(1);

    // When the screen is drawn
    const { hits } = screen(panes, [], layoutOf());

    // Then the abort target sits on the activity row and names that slot
    const abort = present(
      hits.find((hit) => hit.command.command === "slot_abort"),
      "an abort target",
    );
    expect(abort.row).toBe(QUEUE_LINES + 2);
    expect(abort.command).toEqual({
      command: "slot_abort",
      slot: SLOTS[0].name,
    });
  });

  test("each pane's abort target sits in that pane's own columns", () => {
    // Given two panes side by side, both inside a bash call
    const panes = cells(2);

    // When the screen is drawn
    const { hits } = screen(panes, [], layoutOf());

    // Then each abort target falls within the columns of its own pane
    const width = paneWidth(100, 2);
    const aborts = hits.filter((hit) => hit.command.command === "slot_abort");
    expect(aborts).toHaveLength(2);
    expect(at(aborts, 0).from).toBeLessThan(width);
    expect(at(aborts, 1).from).toBeGreaterThanOrEqual(width + 1);
  });

  test("a click inside the abort target sends the abort, and past it sends nothing", () => {
    // Given a screen with one abort target on it
    const { hits } = screen(cells(1), [], layoutOf());
    const abort = present(
      hits.find((hit) => hit.command.command === "slot_abort"),
      "an abort target",
    );

    // When a click lands on its first column and another one past its last
    const clicked = [
      hitAt(hits, {
        button: 0,
        column: abort.from,
        row: abort.row,
        pressed: true,
      }),
      hitAt(hits, {
        button: 0,
        column: abort.to,
        row: abort.row,
        pressed: true,
      }),
    ];

    // Then only the click inside the target sends the command
    expect(clicked).toEqual([abort.command, undefined]);
  });

  test("an idle pane offers no abort target", () => {
    // Given a pane whose slot is idle
    const panes = [
      {
        pane: paneOf({ slots: [idleRow(SLOTS[0], SLOTS.length)] }),
        rate: undefined,
        lines: (width: number) =>
          new PaneLines().update([entryOf("nothing")], width),
      },
    ];

    // When the screen is drawn
    const { hits } = screen(panes, [], layoutOf());

    // Then there is no abort target, because there is no command to kill
    expect(hits.some((hit) => hit.command.command === "slot_abort")).toBe(
      false,
    );
  });

  test("a terminal too narrow for its panes says how many columns it needs", () => {
    // Given two panes and a terminal wide enough for barely one
    const panes = cells(2);

    // When the screen is drawn
    const attempt = () =>
      screen(panes, [], layoutOf({ columns: MIN_PANE_WIDTH }));

    // Then it refuses, rather than drawing something unreadable
    expect(attempt).toThrow(/2 panes need/);
  });

  test("a single pane takes the whole terminal", () => {
    // Given a terminal a hundred columns wide, split one way
    const count = 1;

    // When the pane's width is worked out
    const width = paneWidth(100, count);

    // Then no dividers are needed and the pane takes every column
    expect(width).toBe(100);
  });

  test("two panes each leave one column for a divider", () => {
    // Given a terminal a hundred columns wide, split two ways
    const count = 2;

    // When the pane's width is worked out
    const width = paneWidth(100, count);

    // Then the divider's column is subtracted before the split
    expect(width).toBe(49);
  });

  test("three panes leave two columns for the dividers between them", () => {
    // Given a terminal a hundred columns wide, split three ways
    const count = 3;

    // When the pane's width is worked out
    const width = paneWidth(100, count);

    // Then both dividers' columns are subtracted before the split
    expect(width).toBe(32);
  });
});

describe("Feature: the switches on a pane header", () => {
  test("a switch that is on shows its knob on the right", () => {
    // Given a switch that is on, with no label
    const on = toggle(true, "");

    // When it is drawn for a console that can click it
    const drawn = plain(on);

    // Then the knob sits on the on side
    expect(drawn).toBe(SWITCH_ON);
  });

  test("a switch that is off shows its knob on the left", () => {
    // Given a switch that is off, with no label
    const off = toggle(false, "");

    // When it is drawn for a console that can click it
    const drawn = plain(off);

    // Then the knob sits on the off side
    expect(drawn).toBe(SWITCH_OFF);
  });

  test("a labeled switch carries its label after the knob", () => {
    // Given a switch that is on, labeled scheduler
    const on = toggle(true, "scheduler");

    // When it is drawn for a console that can click it
    const drawn = plain(on);

    // Then the label follows the knob on the same line
    expect(drawn).toBe(`${SWITCH_ON} scheduler`);
  });

  test("the pane header leads with the agent's switch", () => {
    // Given a busy pane in a sixty-column terminal
    const pane = paneOf();

    // When its header is drawn
    const lines = header(pane, 60, 1000).lines;

    // Then the switch comes first, then the identity, its slot buttons, then how long it has run
    expect(renderLine(at(lines, 0))).toBe(
      "\x1b[32m[─●]\x1b[0m pi anthropic/claude-sonnet-4-5 slot 1 / 2 \x1b[2m[-]\x1b[0m\x1b[2m[+]\x1b[0m     0s",
    );
  });

  test("a narrow pane clips the model rather than the switch, the slot or the state", () => {
    // Given a busy pane in a thirty-column terminal
    const pane = paneOf();

    // When its header is drawn
    const line = renderLine(at(header(pane, 30, 1000).lines, 0));

    // Then the model is what gives way, and the row still fills the pane
    expect(line).toBe(
      "\x1b[32m[─●]\x1b[0m pi … slot 1 / 2 \x1b[2m[-]\x1b[0m\x1b[2m[+]\x1b[0m 0s",
    );
    expect(textWidth(bare(line))).toBe(30);
  });

  test("a slot of a provider that is down reads as unreachable, in red", () => {
    // Given an idle slot whose provider failed its health check
    const pane = paneOf({
      slots: [idleRow(SLOTS[0], SLOTS.length, true, false)],
    });

    // When its header is drawn
    const line = renderLine(at(header(pane, 60, 1000).lines, 0));

    // Then the switch is still on, because the agent is enabled, and the state is red
    expect(line).toBe(
      "\x1b[32m[─●]\x1b[0m pi anthropic/claude-sonn… slot 1 / 2 \x1b[2m[-]\x1b[0m\x1b[2m[+]\x1b[0m \x1b[31munreachable\x1b[0m",
    );
  });

  test("a slot outside its schedule reads as off schedule", () => {
    // Given an idle slot the clock has taken outside its schedule
    const pane = paneOf({
      slots: [idleRow(SLOTS[0], SLOTS.length, true, true, false)],
    });

    // When its header is drawn
    const line = renderLine(at(header(pane, 60, 1000).lines, 0));

    // Then the switch is still on, and the state is two words rather than one underscored
    expect(line).toBe(
      "\x1b[32m[─●]\x1b[0m pi anthropic/claude-son… slot 1 / 2 \x1b[2m[-]\x1b[0m\x1b[2m[+]\x1b[0m off schedule",
    );
  });

  test("a disabled slot reads as idle behind an off switch", () => {
    // Given a slot whose agent has been turned off
    const pane = paneOf({ slots: [idleRow(SLOTS[0], SLOTS.length, false)] });

    // When its header is drawn
    const line = renderLine(at(header(pane, 60, 1000).lines, 0));

    // Then the switch says disabled and the slot itself still reads as idle
    expect(line).toBe(
      "\x1b[2m[●─]\x1b[0m pi anthropic/claude-sonnet-4-5 slot 1 / 2 \x1b[2m[-]\x1b[0m\x1b[2m[+]\x1b[0m   idle",
    );
  });
});

describe("Feature: the slot count on a pane header", () => {
  const cells = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      pane: paneOf({
        slots: [busyRow({ ...SLOTS[index % SLOTS.length], task_id: "000123" })],
      }),
      rate: undefined,
      lines: (width: number) =>
        new PaneLines().update([entryOf("working")], width),
    }));

  test("the only slot of an agent is drawn without a count", () => {
    // Given a pane whose agent runs one slot
    const slot = busyRow({ index: 1, total: 1 });

    // When its slot is labelled
    const label = slotLabel(slot);

    // Then it is the number alone, because one of one is what a number already says
    expect(label).toBe("slot 1");
  });

  test("one slot of several says which of how many", () => {
    // Given a pane whose agent runs three slots
    const slot = busyRow({ index: 1, total: 3 });

    // When its slot is labelled
    const label = slotLabel(slot);

    // Then the count is beside the number, so a reader sees the whole agent from one pane
    expect(label).toBe("slot 1 / 3");
  });

  test("a slot above its agent's count says so until it goes idle", () => {
    // Given a slot still running after its agent was told to drop to two slots
    const slot = busyRow({ index: 3, total: 2 });

    // When its slot is labelled
    const label = slotLabel(slot);

    // Then it reads above the count, which is why the pane is still drawn at all
    expect(label).toBe("slot 3 / 2");
  });

  test("the only slot of an agent can be added to but not taken away", () => {
    // Given a pane whose agent runs one slot
    const slot = busyRow({ index: 1, total: 1 });

    // When its buttons are drawn
    const drawn = plain(slotButtons(slot));

    // Then only the plus is offered, because an agent with no slots should be disabled
    expect(drawn).toBe(MORE);
  });

  test("a slot of an agent running several offers both buttons", () => {
    // Given a pane whose agent runs two slots
    const slot = busyRow({ index: 1, total: 2 });

    // When its buttons are drawn
    const drawn = plain(slotButtons(slot));

    // Then both are offered, in the order they change the count
    expect(drawn).toBe(`${FEWER}${MORE}`);
  });

  test("a pane the console has asked for reads as loading", () => {
    // Given a pane for a slot clicked into being that the server has not published
    const pane = paneOf({
      slots: [{ ...idleRow(slotAt(SLOTS[0], 3), 3), pending: true }],
    });

    // When its header is drawn
    const lines = header(pane, 60, 1000).lines;

    // Then it takes its place by number, reading as loading rather than idle
    const drawn = plain(at(lines, 0));
    expect(drawn).toContain("slot 3 / 3");
    expect(drawn.trimEnd().endsWith(LOADING)).toBe(true);

    // Then it says what it is waiting on rather than claiming to have no task
    expect(detailLine(pane)).toBe("waiting for the server");
  });

  test("each button asks for the count either side of the one drawn", () => {
    // Given a screen of one pane whose agent runs two slots
    const { hits } = screen(cells(1), [], layoutOf());

    // When the slot targets are read off it
    const slots = hits.filter((hit) => hit.command.command === "slots");

    // Then one asks for a slot fewer and the other for one more, both by agent
    expect(slots.map((hit) => hit.command)).toEqual([
      { command: "slots", agent: SLOTS[0].agent, total: 1 },
      { command: "slots", agent: SLOTS[0].agent, total: 3 },
    ]);
  });

  test("a click on a button sends its count, and past the pair sends nothing", () => {
    // Given a screen with a pair of slot targets on it
    const { hits } = screen(cells(1), [], layoutOf());
    const slots = hits.filter((hit) => hit.command.command === "slots");
    const fewer = at(slots, 0);
    const more = at(slots, 1);

    // When a click lands on each button and another past the pair
    const clicked = [fewer, more, { ...more, from: more.to }].map((target) =>
      hitAt(hits, {
        button: 0,
        column: target.from,
        row: target.row,
        pressed: true,
      }),
    );

    // Then each button sends its own count and the column past them sends nothing
    expect(clicked).toEqual([fewer.command, more.command, undefined]);
  });

  test("each pane's buttons sit in that pane's own columns", () => {
    // Given two panes side by side
    const { hits } = screen(cells(2), [], layoutOf());

    // When the slot targets are read off the screen
    const slots = hits.filter((hit) => hit.command.command === "slots");

    // Then each pair falls within the columns of its own pane, after its switch
    const width = paneWidth(100, 2);
    expect(slots).toHaveLength(4);
    expect(at(slots, 0).from).toBeGreaterThan(spanWidth(toggle(true, "")));
    expect(at(slots, 1).to).toBeLessThanOrEqual(width);
    expect(at(slots, 2).from).toBeGreaterThanOrEqual(width + 1);
    expect(at(slots, 3).to).toBeLessThanOrEqual(2 * width + 1);
  });
});

describe("Feature: the abort button on a pane", () => {
  test("a slot doing nothing offers no button", () => {
    // Given a slot the scheduler has dispatched nothing to
    const pane = paneOf({ slots: [idleRow(SLOTS[0], SLOTS.length)] });

    // When the button is drawn
    const button = abortButton(pane);

    // Then there is none, because there is no command to kill
    expect(button).toEqual([]);
  });

  test("a slot inside a bash call offers a button", () => {
    // Given a slot inside a bash call
    const pane = paneOf();

    // When the button is drawn
    const drawn = plain(abortButton(pane));

    // Then it offers to abort, because a running command can be killed
    expect(drawn).toBe("[abort]");
  });

  test("a slot that is thinking offers no button", () => {
    // Given a slot that is thinking rather than inside a bash call
    const activity: Activity = { kind: "thinking", started_at: NOW };
    const pane = paneOf({ slots: [busyRow({ activity })] });

    // When the button is drawn
    const drawn = plain(abortButton(pane));

    // Then there is none, because only a command can be killed
    expect(drawn).toBe("");
  });

  test("a slot that is compacting offers no button", () => {
    // Given a slot compacting an overflowing context rather than inside a bash call
    const activity: Activity = {
      kind: "compacting",
      reason: "overflow",
      started_at: NOW,
    };
    const pane = paneOf({ slots: [busyRow({ activity })] });

    // When the button is drawn
    const drawn = plain(abortButton(pane));

    // Then there is none, because only a command can be killed
    expect(drawn).toBe("");
  });

  test("a slot inside a read call offers no button", () => {
    // Given a slot reading a file rather than inside a bash call
    const activity: Activity = {
      kind: "tool-call",
      tool: "read",
      target: "a.txt",
      started_at: NOW,
    };
    const pane = paneOf({ slots: [busyRow({ activity })] });

    // When the button is drawn
    const drawn = plain(abortButton(pane));

    // Then there is none, because only a command can be killed
    expect(drawn).toBe("");
  });

  test("the button sits at the right of the activity row", () => {
    // Given a slot inside a bash call
    const pane = paneOf();

    // When the header is drawn
    const line = renderLine(at(header(pane, 60, 1000).lines, 2));

    // Then the activity is at the left of the row and the button at its right
    expect(line).toBe(
      "\x1b[2mtool: bash — bun test\x1b[0m\x1b[2m (0s)\x1b[0m                           \x1b[31m[abort]\x1b[0m",
    );
  });

  test("an idle pane's activity row is blank", () => {
    // Given a slot the scheduler has dispatched nothing to
    const pane = paneOf({ slots: [idleRow(SLOTS[0], SLOTS.length)] });

    // When the header is drawn
    const line = renderLine(at(header(pane, 60, 1000).lines, 2));

    // Then the activity row carries nothing at all
    expect(line).toBe("\x1b[2m\x1b[0m");
  });

  test("a long command is clipped rather than running under the button", () => {
    // Given a slot running a command far wider than its pane
    const pane = paneOf({
      slots: [
        busyRow({
          activity: {
            kind: "tool-call",
            tool: "bash",
            target: "a very long command that would overflow the pane width",
            started_at: NOW,
          },
        }),
      ],
    });

    // When the header is drawn for a thirty-column pane
    const line = renderLine(at(header(pane, 30, 1000).lines, 2));

    // Then the command is clipped, the elapsed time and button both survive
    expect(line).toBe(
      "\x1b[2mtool: bash — a ve\x1b[0m\x1b[2m…\x1b[0m\x1b[2m (0s)\x1b[0m\x1b[31m[abort]\x1b[0m",
    );
    expect(textWidth(bare(line))).toBe(30);
  });
});

describe("Feature: the queue line above the panes", () => {
  test("the scheduler switch is the leftmost thing on the line", () => {
    // Given a view with the scheduler running and one task queued
    const view = viewOf({ scheduling: true, queue: [candidateOf()] });

    // When the queue line is drawn
    const { line } = queueHeader(view, 100);

    // Then the switch comes before the first queued task
    const text = plain(line);
    expect(text.indexOf(SWITCH_ON)).toBe(0);
    expect(text.indexOf("scheduler")).toBeLessThan(text.indexOf("000123"));
  });

  test("the queue reads left to right and ends with how many are waiting", () => {
    // Given a view with three tasks queued at different ranks
    const view = viewOf({
      queue: [
        candidateOf({ task_id: "000001", rank: "WORK_REVIEW" }),
        candidateOf({ task_id: "000002", rank: "WORK_STARTED" }),
        candidateOf({ task_id: "000003", rank: "resume" }),
      ],
    });

    // When the queue line is drawn
    const { line } = queueHeader(view, 120);

    // Then the tasks read in dispatch order, each with its rank
    const text = plain(line);
    expect(text).toContain("000001 WORK_REVIEW");
    expect(text.indexOf("000001")).toBeLessThan(text.indexOf("000002"));
    expect(text).toContain("000003 resume");

    // Then the total sits at the right, and the line fills the terminal
    expect(text.trimEnd().endsWith("3 queued")).toBe(true);
    expect(spanWidth(line)).toBe(120);
  });

  test("a queued task is labelled with the state it will be dispatched into", () => {
    // Given a view with one fresh task queued for work
    const view = viewOf({ queue: [candidateOf({ rank: "WORK_FRESH" })] });

    // When the queue line is drawn
    const { line } = queueHeader(view, 100);

    // Then the task is labelled with its state rather than its rank's name
    expect(plain(line)).toContain("000123 WORK");
  });

  test("an empty queue says so rather than showing a zero", () => {
    // Given a view with nothing queued
    const view = viewOf();

    // When the queue line is drawn
    const { line } = queueHeader(view, 100);

    // Then it reads as nothing queued
    expect(plain(line).trimEnd().endsWith("nothing queued")).toBe(true);
  });

  test("a queue too long for the terminal keeps the count and drops tasks", () => {
    // Given a view with forty tasks queued, on a sixty-column terminal
    const queue = Array.from({ length: 40 }, (_, index) =>
      candidateOf({ task_id: String(index).padStart(6, "0") }),
    );

    // When the queue line is drawn
    const { line } = queueHeader(viewOf({ queue }), 60);

    // Then the total survives, the line fits, and the tail of the queue is cut
    expect(spanWidth(line)).toBe(60);
    expect(plain(line).trimEnd().endsWith("40 queued")).toBe(true);
    expect(plain(line)).not.toContain("000039");
  });

  test("the scheduler switch asks for the state it is not in", () => {
    // Given a view with the scheduler running
    const view = viewOf({ scheduling: true });

    // When the queue line is drawn
    const { hits } = queueHeader(view, 100);

    // Then its switch is a target at the top left that would turn it off
    const toggle = at(hits, 0);
    expect(toggle.command).toEqual({ command: "scheduler", enabled: false });
    expect(toggle.from).toBe(0);
    expect(toggle.row).toBe(0);
  });
});
