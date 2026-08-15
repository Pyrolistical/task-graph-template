import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { at, present } from "../../testing/present.ts";
import { idleRow } from "../../agents/domain/slots.ts";
import { spanWidth, textWidth } from "../domain/text.ts";
import { PaneLines, SWITCH_ON } from "./panes.ts";
import {
  COLLAPSED_WIDTH,
  HIDE,
  MIN_PANE_WIDTH,
  NEWS,
  SHOW,
  emptyPool,
  errorFrame,
  newsRegion,
  paneWidth,
  queueHeader,
  screen,
} from "./screen.ts";
import {
  type Scroll,
  HEADER_LINES,
  QUEUE_LINES,
  bodyHeight,
  topOf,
} from "./scroll.ts";
import { hitAt } from "./keys.ts";
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
