import { describe, expect } from "bun:test";
import { tempDir, test } from "./temp.ts";
import fs from "node:fs";
import path from "node:path";
import { idleRow, parseAgents } from "./agents.ts";
import type { AgentRow } from "./agents.ts";
import type { TaskRow } from "./graph.ts";
import {
  type Entry,
  type Layout,
  type Line,
  type Pane,
  type View,
  HEADER_LINES,
  MIN_PANE_WIDTH,
  PaneLines,
  QUEUE_LINES,
  SWITCH_OFF,
  SWITCH_ON,
  Sessions,
  SessionTail,
  activityLine,
  body,
  bodyHeight,
  charWidth,
  clip,
  detailLine,
  elapsed,
  entryLines,
  frame,
  header,
  hitAt,
  keys,
  mouse,
  pad,
  paneWidth,
  panes,
  queueHeader,
  readView,
  recordEntries,
  renderLine,
  screen,
  spanWidth,
  statsLine,
  textWidth,
  thousands,
  toggle,
  wrap,
} from "./console.ts";
import type { Candidate } from "./scheduler.ts";
import {
  type Command,
  takeCommand,
  watchCommands,
  writeCommand,
} from "./command.ts";
import { Runtime, snapshot, writeAtomic } from "./runtime.ts";

const SLOTS = parseAgents({
  agents: [
    {
      type: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      slots: 2,
    },
  ],
});

function busyRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    ...idleRow(SLOTS[0]!),
    state: "BUSY",
    task_id: "000123",
    role: "work",
    pid: 4242,
    started_at: new Date(1000).toISOString(),
    activity: "tool: bash — bun test",
    tokens: 12300,
    context_percent: 41.6,
    session: "/tmp/session.jsonl",
    log: "/tmp/agent-rpc.jsonl",
    ...overrides,
  };
}

function taskRowOf(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "000123",
    title: "port the console",
    state: "WORKING",
    state_entered: new Date(1000).toISOString(),
    open_todos: 2,
    failures: 0,
    open_task_graph_updates: 0,
    depends_on: [],
    blocking: 0,
    claimed_by: SLOTS[0]!.name,
    held_reason: null,
    worktree: "/tmp/worktree",
    ...overrides,
  };
}

function viewOf(overrides: Partial<View> = {}): View {
  return {
    agents: [busyRow()],
    tasks: [taskRowOf()],
    checks: [],
    queue: [],
    scheduling: false,
    ...overrides,
  };
}

function candidateOf(overrides: Partial<Candidate> = {}): Candidate {
  return {
    task_id: "000123",
    rank: "READY_WORK_FRESH",
    blocking: 0,
    open_todos: 0,
    prefer_agent: null,
    session: null,
    ...overrides,
  };
}

function layoutOf(overrides: Partial<Layout> = {}): Layout {
  return {
    columns: 100,
    rows: 12,
    nowMs: 1000,
    scroll: { anchor: 0, follow: true },
    readOnly: false,
    ...overrides,
  };
}

function paneOf(view: Partial<View> = {}): Pane {
  return panes(viewOf(view))[0]!;
}

function entryOf(text: string, label = "text"): Entry {
  return { timestampMs: 0, label, text, error: false };
}

function plain(line: Line): string {
  return line.map((span) => span.text).join("");
}

describe("spans", () => {
  test("clip truncates with an ellipsis and keeps the sgr", () => {
    const line = clip([{ text: "hello world", sgr: "2" }], 8);

    expect(line.map((span) => span.text).join("")).toBe("hello w…");
    expect(spanWidth(line)).toBe(8);
    expect(line.every((span) => span.sgr === "2")).toBe(true);
  });

  test("clip keeps spans that fit exactly", () => {
    expect(clip([{ text: "abcd" }], 4)).toEqual([{ text: "abcd" }]);
    expect(clip([{ text: "abcd" }], 0)).toEqual([]);
  });

  test("pad fills the pane width", () => {
    expect(spanWidth(pad([{ text: "ab" }], 6))).toBe(6);
    expect(spanWidth(pad([{ text: "abcdefgh" }], 6))).toBe(6);
  });

  test("emoji, cjk and keycaps take two columns; ascii takes one", () => {
    expect(charWidth("a")).toBe(1);
    expect(charWidth("…")).toBe(1);
    expect(charWidth("✔")).toBe(1);
    expect(charWidth("✔️")).toBe(2);
    expect(charWidth("🔥")).toBe(2);
    expect(charWidth("漢")).toBe(2);
    expect(charWidth("1️⃣")).toBe(2);
  });

  test("a zwj sequence and a flag are one two-column cluster", () => {
    expect(textWidth("👨‍👩‍👧")).toBe(2);
    expect(textWidth("🇺🇸")).toBe(2);
  });

  test("text width counts columns, not code points", () => {
    expect(textWidth("ok 🔥")).toBe(5);
  });

  test("clip never lets an emoji spill past the width", () => {
    expect(spanWidth(clip([{ text: "ab🔥cd" }], 4))).toBeLessThanOrEqual(4);
    expect(plain(clip([{ text: "ab🔥cd" }], 4))).toBe("ab…");
    expect(plain(clip([{ text: "🔥🔥" }], 4))).toBe("🔥🔥");
  });

  test("pad fills the column a clipped emoji could not use", () => {
    expect(spanWidth(pad([{ text: "ab🔥cd" }], 4))).toBe(4);
    expect(spanWidth(pad([{ text: "🔥ab" }], 6))).toBe(6);
  });

  test("render wraps sgr spans in escapes and leaves plain text alone", () => {
    expect(renderLine([{ text: "a", sgr: "2" }, { text: "b" }])).toBe(
      "\x1b[2ma\x1b[0mb",
    );
  });
});

describe("wrap", () => {
  test("wraps on words with a narrower first line", () => {
    expect(wrap("aaa bbb ccc ddd", 7, 11)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  test("hard splits words longer than the width", () => {
    expect(wrap("abcdefghij", 4, 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("empty text still produces one line", () => {
    expect(wrap("", 10, 10)).toEqual([""]);
  });

  test("wraps on emoji columns rather than code points", () => {
    expect(wrap("🔥🔥 ab", 4, 4)).toEqual(["🔥🔥", "ab"]);
    expect(wrap("🔥🔥🔥", 4, 4)).toEqual(["🔥🔥", "🔥"]);
  });

  test("an emoji wider than the width still makes progress", () => {
    expect(wrap("🔥🔥", 1, 1)).toEqual(["🔥", "🔥"]);
  });
});

describe("session records", () => {
  test("assistant text, thinking and tool calls become entries", () => {
    const { entries, usage } = recordEntries({
      type: "message",
      timestamp: "1970-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: " plan " },
          { type: "text", text: "on it" },
          { type: "toolCall", name: "bash", arguments: { command: "ls -l" } },
        ],
        usage: { input: 10, output: 2, cacheRead: 100 },
      },
    });

    expect(entries.map((entry) => [entry.label, entry.text])).toEqual([
      ["thinking", "plan"],
      ["text", "on it"],
      ["bash", "ls -l"],
    ]);
    expect(entries[0]!.timestampMs).toBe(1000);
    expect(usage).toEqual({ input: 10, output: 2, cacheRead: 100 });
  });

  test("tool results collapse to a line count and errors are flagged", () => {
    const result = recordEntries({
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "a\nb\nc" }],
      },
    });
    expect(result.entries[0]).toMatchObject({
      label: "result",
      text: "3 lines",
      error: false,
    });

    const failed = recordEntries({
      type: "message",
      message: {
        role: "toolResult",
        isError: true,
        content: [{ type: "text", text: "boom\ndetails" }],
      },
    });
    expect(failed.entries[0]).toMatchObject({
      label: "error",
      text: "boom",
      error: true,
    });
  });

  test("unknown record types are ignored", () => {
    expect(recordEntries({ type: "agent_settled" })).toEqual({
      entries: [],
      usage: null,
    });
  });
});

describe("SessionTail", () => {
  function write(filePath: string, records: unknown[]): void {
    fs.appendFileSync(
      filePath,
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      "utf-8",
    );
  }

  function assistant(text: string): unknown {
    return {
      type: "message",
      timestamp: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 1, output: 2, cacheRead: 3 },
      },
    };
  }

  test("reads only what was appended since the last read", () => {
    const dir = tempDir("console-");
    const file = path.join(dir, "session.jsonl");
    write(file, [assistant("first")]);

    const tail: SessionTail = new SessionTail(file);
    expect(tail.read().map((entry) => entry.text)).toEqual(["first"]);

    write(file, [assistant("second")]);
    expect(tail.read().map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(tail.totalUsage).toEqual({ input: 2, output: 4, cacheRead: 6 });
  });

  test("a truncated file restarts the tail", () => {
    const dir = tempDir("console-");
    const file = path.join(dir, "session.jsonl");
    write(file, [assistant("first"), assistant("second")]);

    const tail: SessionTail = new SessionTail(file);
    expect(tail.read()).toHaveLength(2);

    fs.writeFileSync(file, "", "utf-8");
    write(file, [assistant("fresh")]);
    expect(tail.read().map((entry) => entry.text)).toEqual(["fresh"]);
    expect(tail.totalUsage).toEqual({ input: 1, output: 2, cacheRead: 3 });
  });

  test("a half written line is held until its newline arrives", () => {
    const dir = tempDir("console-");
    const file = path.join(dir, "session.jsonl");
    const record = JSON.stringify(assistant("split"));
    fs.writeFileSync(file, record.slice(0, 12), "utf-8");

    const tail: SessionTail = new SessionTail(file);
    expect(tail.read()).toEqual([]);

    fs.appendFileSync(file, `${record.slice(12)}\n`, "utf-8");
    expect(tail.read().map((entry) => entry.text)).toEqual(["split"]);
  });

  test("a missing session file reads as empty", () => {
    const tail: SessionTail = new SessionTail(
      path.join(tempDir("console-"), "nothing.jsonl"),
    );
    expect(tail.read()).toEqual([]);
  });
});

describe("Sessions", () => {
  test("usage is null until the tail has been read and dropped agents are forgotten", () => {
    const dir = tempDir("console-");
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: "message",
        timestamp: 0,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input: 4, output: 1, cacheRead: 0 },
        },
      })}\n`,
      "utf-8",
    );

    const sessions: Sessions = new Sessions();
    expect(sessions.usage(file)).toBeNull();
    expect(sessions.entries(file)).toHaveLength(1);
    expect(sessions.usage(file)).toEqual({ input: 4, output: 1, cacheRead: 0 });

    expect(sessions.entries(null)).toEqual([]);
    expect(sessions.usage(null)).toBeNull();

    sessions.keep(new Set());
    expect(sessions.usage(file)).toBeNull();
  });
});

describe("panes", () => {
  test("an agent is joined to its task and its running check", () => {
    const pane = paneOf({
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
    });

    expect(pane.task?.state).toBe("WORKING");
    expect(pane.check?.command).toBe("bun test");
    expect(pane.sinceMs).toBe(1000);
    expect(detailLine(pane)).toBe("task 000123 · work · WORKING · pid 4242");
    expect(activityLine(pane)).toBe("check 1: bun test");
  });

  test("an idle agent has no task, no check and no clock", () => {
    const pane = paneOf({ agents: [idleRow(SLOTS[1]!)] });

    expect(pane.task).toBeNull();
    expect(pane.check).toBeNull();
    expect(pane.sinceMs).toBeNull();
    expect(detailLine(pane)).toBe("no task");
    expect(activityLine(pane)).toBe("");
    expect(statsLine(pane, null)).toBe("");
  });

  test("a task the view does not carry still renders from the agent row", () => {
    const pane = paneOf({ tasks: [] });

    expect(pane.task).toBeNull();
    expect(detailLine(pane)).toBe("task 000123 · work · pid 4242");
  });

  test("a retrying agent shows its attempt", () => {
    const pane = paneOf({
      agents: [
        busyRow({
          state: "WAITING",
          retry_at: new Date(1000).toISOString(),
          attempt: 3,
        }),
      ],
    });

    expect(detailLine(pane)).toContain("retry 3 at ");
    expect(activityLine(pane)).toBe("tool: bash — bun test");
  });

  test("stats merge the agent row with the session usage", () => {
    const pane = paneOf();

    expect(statsLine(pane, { input: 900, output: 12000, cacheRead: 0 })).toBe(
      "12.3k tokens · ctx 42% · 900 in · 12.0k out · 0 cached",
    );
  });
});

describe("formatting", () => {
  test("elapsed switches units", () => {
    expect(elapsed(5_400)).toBe("5s");
    expect(elapsed(95_000)).toBe("1m35s");
    expect(elapsed(3_780_000)).toBe("1h03m");
    expect(elapsed(-5)).toBe("0s");
  });

  test("thousands only abbreviates past a thousand", () => {
    expect(thousands(999)).toBe("999");
    expect(thousands(12_345)).toBe("12.3k");
  });
});

describe("body", () => {
  function linesOf(texts: string[], width = 40): Line[] {
    return new PaneLines().update(
      texts.map((text) => entryOf(text)),
      width,
    );
  }

  function shown(lines: Line[]): string {
    return lines.map(renderLine).join("");
  }

  test("following keeps the newest entries when they overflow the pane", () => {
    const lines = body(linesOf(["one", "two", "three"]), 2, {
      anchor: 0,
      follow: true,
    });

    expect(lines).toHaveLength(2);
    expect(shown(lines)).toContain("three");
    expect(shown(lines)).not.toContain("one");
  });

  test("scrolling back reveals older entries", () => {
    const lines = body(linesOf(["one", "two", "three"]), 1, {
      anchor: 1,
      follow: false,
    });

    expect(shown(lines)).toContain("two");
  });

  test("an anchor past the end is clamped without being forgotten", () => {
    const scroll = { anchor: 500, follow: false };
    expect(body(linesOf(["only"]), 5, scroll)).toHaveLength(1);
    expect(scroll.anchor).toBe(500);
  });

  test("new lines do not move what a scrolled pane is showing", () => {
    const cache: PaneLines = new PaneLines();
    const entries = ["one", "two", "three", "four"].map((text) =>
      entryOf(text),
    );
    const scroll = { anchor: 1, follow: false };

    const before = shown(body(cache.update(entries, 40), 2, scroll));
    entries.push(entryOf("five"), entryOf("six"));
    const after = shown(body(cache.update(entries, 40), 2, scroll));

    expect(before).toContain("two");
    expect(after).toBe(before);
  });

  test("a following pane still moves with new lines", () => {
    const cache: PaneLines = new PaneLines();
    const entries = ["one", "two"].map((text) => entryOf(text));
    const scroll = { anchor: 0, follow: true };

    body(cache.update(entries, 40), 2, scroll);
    entries.push(entryOf("three"));

    expect(shown(body(cache.update(entries, 40), 2, scroll))).toContain(
      "three",
    );
  });

  test("the body height leaves room for the queue, the header and its rule", () => {
    expect(bodyHeight(24)).toBe(24 - QUEUE_LINES - HEADER_LINES - 1);
  });

  test("usage entries are skipped", () => {
    expect(new PaneLines().update([entryOf("hidden", "usage")], 40)).toEqual(
      [],
    );
  });

  test("a wide pane keeps the prefix on the first line", () => {
    const lines = entryLines(entryOf("hello there", "assistant"), 40);

    expect(lines).toHaveLength(1);
    expect(plain(lines[0]!)).toBe("00:00:00 assistant: hello there");
  });

  test("a pane too narrow for the prefix puts the text on its own lines", () => {
    const lines = entryLines(entryOf("hello there", "assistant"), 14);

    expect(lines.length).toBeGreaterThan(1);
    expect(plain(lines[0]!)).toBe("00:00:00 assi…");
    expect(lines.slice(1).map(plain).join(" ")).toContain("hello");
  });
});

describe("wrapped pane lines", () => {
  test("entries already wrapped are not wrapped again", () => {
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("one"), entryOf("two"), entryOf("three")];

    const before = cache.update(entries, 40);
    const kept = before[0]!;
    entries.push(entryOf("four"));
    const after = cache.update(entries, 40);

    expect(after[0]).toBe(kept);
    expect(after).toHaveLength(4);
  });

  test("the last entry is re-wrapped, because it is still being appended to", () => {
    const cache: PaneLines = new PaneLines();
    const last = entryOf("thinking");
    const entries = [entryOf("one"), last];

    cache.update(entries, 40);
    last.text = "thinking · deeper";

    expect(renderLine(cache.update(entries, 40)[1]!)).toContain(
      "thinking · deeper",
    );
  });

  test("a width change rebuilds every line", () => {
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("a line that will have to wrap somewhere")];

    const narrow = cache.update(entries, 20);
    const wide = cache.update(entries, 80);

    expect(wide.length).toBeLessThan(narrow.length);
    expect(cache.update(entries, 80)).toEqual(wide);
  });

  test("a session that was rewritten from the start drops the old lines", () => {
    const cache: PaneLines = new PaneLines();
    const entries = [entryOf("one"), entryOf("two"), entryOf("three")];
    cache.update(entries, 40);

    entries.length = 0;
    entries.push(entryOf("fresh"));

    expect(renderLine(cache.update(entries, 40)[0]!)).toContain("fresh");
    expect(cache.update(entries, 40)).toHaveLength(1);
  });
});

describe("key chunks", () => {
  test("a burst of wheel events is not lost to a single match", () => {
    expect(keys("\x1b[<64;10;20M\x1b[<64;10;20M\x1b[<64;10;20M")).toEqual([
      "\x1b[<64;10;20M",
      "\x1b[<64;10;20M",
      "\x1b[<64;10;20M",
    ]);
  });

  test("held arrow keys arrive in one chunk and count once each", () => {
    expect(keys("\x1b[A\x1b[A\x1b[B")).toEqual(["\x1b[A", "\x1b[A", "\x1b[B"]);
  });

  test("plain keys are one key each", () => {
    expect(keys("jjkq")).toEqual(["j", "j", "k", "q"]);
  });

  test("page keys keep their tilde", () => {
    expect(keys("\x1b[6~\x1b[5~")).toEqual(["\x1b[6~", "\x1b[5~"]);
  });
});

describe("screen", () => {
  function cells(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      pane: paneOf({
        agents: [
          busyRow({ ...SLOTS[index % SLOTS.length]!, task_id: "000123" }),
        ],
      }),
      usage: null,
      lines: (width: number) =>
        new PaneLines().update([entryOf("working")], width),
    }));
  }

  test("renders exactly one line per terminal row", () => {
    const { lines } = screen(cells(2), [], layoutOf());

    expect(lines).toHaveLength(12);
  });

  test("the queue header is the first row, above every pane", () => {
    const { lines } = screen(cells(2), [{ text: "the queue" }], layoutOf());

    expect(lines[0]).toContain("the queue");
    expect(lines[QUEUE_LINES]).toContain("anthropic/claude-sonnet-4-5");
  });

  test("a rule under the queue row splits it from the panes", () => {
    const { lines } = screen(cells(2), [{ text: "the queue" }], layoutOf());
    const rule = lines[1]!.replace(/\x1b\[[0-9;]*m/g, "");

    expect(rule).toContain("─");
    expect(rule).toContain("┬");
    expect(rule.indexOf("┬")).toBe(paneWidth(100, 2));
    expect(textWidth(rule)).toBe(100);
  });

  test("panes are separated by a rule that crosses under the header", () => {
    const { lines } = screen(cells(2), [], layoutOf());

    expect(lines[QUEUE_LINES + HEADER_LINES]).toContain("┼");
    expect(lines[QUEUE_LINES]).toContain("│");
    expect(lines[QUEUE_LINES]).not.toContain("┼");
  });

  test("emoji in a pane keep the divider in the same column", () => {
    const emoji = cells(2);
    emoji[0]!.lines = (width: number) =>
      new PaneLines().update([entryOf("🔥 shipping 🚀 it")], width);
    const plainCells = cells(2);

    const columnOf = (lines: string[], row: number) => {
      const bare = lines[row]!.replace(/\x1b\[[0-9;]*m/g, "");
      return textWidth(bare.slice(0, bare.indexOf("│")));
    };

    const { lines } = screen(emoji, [], layoutOf());
    const expected = screen(plainCells, [], layoutOf()).lines;

    for (let row = QUEUE_LINES + HEADER_LINES + 1; row < 12; row++) {
      expect(columnOf(lines, row)).toBe(columnOf(expected, row));
    }
  });

  test("the reported total is the longest pane, which bounds the scroll", () => {
    const { total } = screen(cells(2), [], layoutOf());

    expect(total).toBe(1);
  });

  test("every pane switch is a hit region on the pane header row", () => {
    const { hits } = screen(cells(2), [], layoutOf());
    const width = paneWidth(100, 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ row: QUEUE_LINES, from: 0 });
    expect(hits[1]!.from).toBe(width + 1);
    expect(hits[0]!.command).toEqual({
      command: "agent",
      agent: SLOTS[0]!.agent,
      enabled: false,
    });
  });

  test("a read-only screen offers nothing to click", () => {
    expect(screen(cells(2), [], layoutOf({ readOnly: true })).hits).toEqual([]);
  });

  test("a terminal too narrow for the panes fails", () => {
    expect(() =>
      screen(cells(2), [], layoutOf({ columns: MIN_PANE_WIDTH })),
    ).toThrow(/2 panes need/);
  });

  test("an empty agent view fails", () => {
    expect(() => screen([], [], layoutOf())).toThrow(/empty/);
  });

  test("pane width accounts for the separator columns", () => {
    expect(paneWidth(100, 1)).toBe(100);
    expect(paneWidth(100, 2)).toBe(49);
    expect(paneWidth(100, 3)).toBe(32);
  });
});

describe("switches", () => {
  test("a switch shows its state by where the knob sits", () => {
    expect(plain(toggle(true, "", false))).toBe(SWITCH_ON);
    expect(plain(toggle(false, "", false))).toBe(SWITCH_OFF);
    expect(plain(toggle(true, "scheduler", false))).toBe(
      `${SWITCH_ON} scheduler`,
    );
  });

  test("read only turns the switches into labels", () => {
    expect(plain(toggle(true, "", true))).toBe("enabled");
    expect(plain(toggle(false, "", true))).toBe("disabled");
    expect(plain(toggle(false, "scheduler", true))).toBe("scheduler disabled");
  });

  test("the pane header leads with the agent switch", () => {
    const lines = header(paneOf(), null, 60, 1000, false);

    expect(plain(lines[0]!).startsWith(`${SWITCH_ON} pi · `)).toBe(true);
  });

  test("a narrow pane clips the identity, never the switch or the state", () => {
    const line = plain(header(paneOf(), null, 30, 1000, false)[0]!);

    expect(line.startsWith(SWITCH_ON)).toBe(true);
    expect(line.endsWith("busy 0s")).toBe(true);
    expect(line).toContain("…");
    expect(textWidth(line)).toBe(30);
  });

  test("a disabled slot reads as idle behind an off switch, not as a state", () => {
    const pane = paneOf({ agents: [idleRow(SLOTS[0]!, false)] });
    const line = plain(header(pane, null, 60, 1000, false)[0]!);

    expect(line.startsWith(SWITCH_OFF)).toBe(true);
    expect(line.trimEnd().endsWith("idle")).toBe(true);
  });

  test("a read-only pane header says enabled or disabled instead", () => {
    const pane = paneOf({ agents: [idleRow(SLOTS[0]!, false)] });

    expect(plain(header(pane, null, 60, 1000, true)[0]!)).toContain("disabled");
  });
});

describe("the queue header", () => {
  test("the scheduler switch is the leftmost item, before the first task", () => {
    const { line } = queueHeader(
      viewOf({ scheduling: true, queue: [candidateOf()] }),
      100,
      false,
    );

    expect(plain(line).indexOf(SWITCH_ON)).toBe(0);
    expect(plain(line).indexOf("scheduler")).toBeLessThan(
      plain(line).indexOf("000123"),
    );
  });

  test("the queue runs left to right and ends with how many are left", () => {
    const { line } = queueHeader(
      viewOf({
        queue: [
          candidateOf({ task_id: "000001", rank: "READY_AGENT_REVIEW" }),
          candidateOf({ task_id: "000002", rank: "READY_WORK_STARTED" }),
          candidateOf({ task_id: "000003", rank: "resume" }),
        ],
      }),
      120,
      false,
    );
    const text = plain(line);

    expect(text).toContain("000001 READY_AGENT_REVIEW");
    expect(text.indexOf("000001")).toBeLessThan(text.indexOf("000002"));
    expect(text).toContain("000002 READY_WORK");
    expect(text).toContain("000003 resume");
    expect(text.trimEnd().endsWith("3 queued")).toBe(true);
    expect(spanWidth(line)).toBe(120);
  });

  test("a queued task is labelled with its task state", () => {
    const { line } = queueHeader(
      viewOf({ queue: [candidateOf({ rank: "READY_WORK_FRESH" })] }),
      100,
      false,
    );

    expect(plain(line)).toContain("000123 READY_WORK");
  });

  test("an empty queue says so", () => {
    const { line } = queueHeader(viewOf(), 100, false);

    expect(plain(line).trimEnd().endsWith("nothing queued")).toBe(true);
  });

  test("a queue too long for the terminal keeps the count", () => {
    const queue = Array.from({ length: 40 }, (_, index) =>
      candidateOf({ task_id: String(index).padStart(6, "0") }),
    );
    const { line } = queueHeader(viewOf({ queue }), 60, false);

    expect(spanWidth(line)).toBe(60);
    expect(plain(line).trimEnd().endsWith("40 queued")).toBe(true);
    expect(plain(line)).not.toContain("000039");
  });

  test("clicking the scheduler switch asks for the state it is not in", () => {
    const { hits } = queueHeader(viewOf({ scheduling: true }), 100, false);

    expect(hits[0]!.command).toEqual({ command: "scheduler", enabled: false });
    expect(hits[0]!.from).toBe(0);
    expect(hits[0]!.row).toBe(0);
  });

  test("a read-only queue header offers nothing to click", () => {
    expect(queueHeader(viewOf(), 100, true).hits).toEqual([]);
  });
});

describe("the mouse", () => {
  test("an sgr report is a button, a zero-based cell and a press", () => {
    expect(mouse("\x1b[<0;12;3M")).toEqual({
      button: 0,
      column: 11,
      row: 2,
      pressed: true,
    });
    expect(mouse("\x1b[<0;12;3m")!.pressed).toBe(false);
    expect(mouse("\x1b[A")).toBeNull();
  });

  test("a click lands on the switch under it and nowhere else", () => {
    const hits = [
      {
        row: 0,
        from: 0,
        to: 4,
        command: { command: "scheduler" as const, enabled: true },
      },
    ];

    expect(hitAt(hits, mouse("\x1b[<0;4;1M")!)).toEqual({
      command: "scheduler",
      enabled: true,
    });
    expect(hitAt(hits, mouse("\x1b[<0;5;1M")!)).toBeNull();
    expect(hitAt(hits, mouse("\x1b[<0;1;2M")!)).toBeNull();
  });
});

describe("console commands", () => {
  function runtimeIn(root: string): Runtime {
    return new Runtime(path.join(root, "repo"), root);
  }

  test("the server takes the command the console wrote, once", () => {
    const runtime = runtimeIn(tempDir("console-"));

    expect(writeCommand(runtime, { command: "scheduler", enabled: true })).toBe(
      true,
    );
    expect(takeCommand(runtime)).toEqual({
      command: "scheduler",
      enabled: true,
    });
    expect(takeCommand(runtime)).toBeNull();
  });

  test("the console does not write over a command nobody has taken yet", () => {
    const runtime = runtimeIn(tempDir("console-"));
    writeCommand(runtime, { command: "scheduler", enabled: true });

    expect(
      writeCommand(runtime, {
        command: "agent",
        agent: "pi-fake-fake",
        enabled: false,
      }),
    ).toBe(false);
    expect(takeCommand(runtime)).toEqual({
      command: "scheduler",
      enabled: true,
    });
  });

  test("a command that does not parse is dropped, and the file with it", () => {
    const runtime = runtimeIn(tempDir("console-"));
    fs.writeFileSync(runtime.consoleCommand, `{ "command": "explode" }`);

    expect(takeCommand(runtime)).toBeNull();
    expect(fs.existsSync(runtime.consoleCommand)).toBe(false);
  });

  test("the watcher hands over the command the console just wrote", async () => {
    const runtime = runtimeIn(tempDir("console-"));
    const taken: Command[] = [];
    const watcher = watchCommands(runtime, (command) => {
      taken.push(command);
    });

    writeCommand(runtime, { command: "scheduler", enabled: true });
    for (let waited = 0; waited < 100 && taken.length === 0; waited++) {
      await Bun.sleep(10);
    }
    watcher.close();

    expect(taken).toEqual([{ command: "scheduler", enabled: true }]);
    expect(fs.existsSync(runtime.consoleCommand)).toBe(false);
  });
});

describe("runtime views", () => {
  function seed(root: string): Runtime {
    const runtime: Runtime = new Runtime(path.join(root, "repo"), root);
    writeAtomic(runtime.agentsView, snapshot(1, "agents", [busyRow()]));
    writeAtomic(runtime.tasksView, snapshot(1, "tasks", [taskRowOf()]));
    writeAtomic(runtime.checksView, snapshot(1, "checks", []));
    writeAtomic(
      runtime.queueView,
      snapshot(1, "queue", [candidateOf()], { scheduling: true }),
    );
    return runtime;
  }

  test("reads the agents, tasks, checks and queue the server wrote", () => {
    const view = readView(seed(tempDir("console-")));

    expect(view.agents[0]!.name).toBe(SLOTS[0]!.name);
    expect(view.tasks[0]!.id).toBe("000123");
    expect(view.checks).toEqual([]);
    expect(view.queue[0]!.task_id).toBe("000123");
    expect(view.scheduling).toBe(true);
  });

  test("a queue view with no scheduler flag fails", () => {
    const runtime = seed(tempDir("console-"));
    writeAtomic(runtime.queueView, snapshot(1, "queue", []));

    expect(() => readView(runtime)).toThrow(/has no "scheduling" flag/);
  });

  test("a runtime dir with no views fails", () => {
    const runtime: Runtime = new Runtime(
      path.join(tempDir("console-"), "repo"),
      tempDir("console-"),
    );

    expect(() => readView(runtime)).toThrow(/no server state/);
  });

  test("a view missing its rows fails", () => {
    const runtime = seed(tempDir("console-"));
    writeAtomic(runtime.tasksView, `${JSON.stringify({ at: "now" })}\n`);

    expect(() => readView(runtime)).toThrow(/has no "tasks" array/);
  });

  test("frame tails the session named by the agent row", () => {
    const root = tempDir("console-");
    const runtime: Runtime = new Runtime(path.join(root, "repo"), root);
    const session = path.join(root, "session.jsonl");
    fs.writeFileSync(
      session,
      `${JSON.stringify({
        type: "message",
        timestamp: 0,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      })}\n`,
      "utf-8",
    );
    writeAtomic(
      runtime.agentsView,
      snapshot(1, "agents", [busyRow({ session })]),
    );
    writeAtomic(runtime.tasksView, snapshot(1, "tasks", [taskRowOf()]));
    writeAtomic(runtime.checksView, snapshot(1, "checks", []));
    writeAtomic(
      runtime.queueView,
      snapshot(1, "queue", [candidateOf({ task_id: "000456" })], {
        scheduling: true,
      }),
    );

    const { lines, hits } = frame(runtime, new Sessions(), layoutOf());
    const text = lines.join("\n");

    expect(text).toContain("task 000123");
    expect(text).toContain("hi");
    expect(lines[0]).toContain("000456");
    expect(hits.map((hit) => hit.command.command)).toEqual([
      "scheduler",
      "agent",
    ]);
  });
});
