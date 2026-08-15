import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { at } from "../../testing/present.ts";
import { type Activity, elapsed } from "../../views/activity.ts";
import { idleRow, slotAt } from "../../agents/domain/slots.ts";
import { renderLine, spanWidth, textWidth } from "../domain/text.ts";
import {
  FEWER,
  LOADING,
  MORE,
  PaneLines,
  SWITCH_OFF,
  SWITCH_ON,
  abortButton,
  activityLine,
  detailLine,
  header,
  panes,
  slotButtons,
  slotLabel,
  statsLine,
  thousands,
  toggle,
} from "./panes.ts";
import { paneWidth, screen } from "./screen.ts";

import { hitAt } from "./keys.ts";
import {
  SLOTS,
  busyRow,
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
    const label = slotLabel(slot, 1);

    // Then it is the number alone, because one of one is what a number already says
    expect(label).toBe("slot 1");
  });

  test("one slot of several says which of how many", () => {
    // Given a pane whose agent runs three slots
    const slot = busyRow({ index: 1, total: 3 });

    // When its slot is labelled
    const label = slotLabel(slot, 1);

    // Then the count is beside the number, so a reader sees the whole agent from one pane
    expect(label).toBe("slot 1 / 3");
  });

  test("a slot above its agent's count says so until it goes idle", () => {
    // Given a third pane still drawn after its agent was told to drop to two slots
    const slot = busyRow({ index: 3, total: 2 });

    // When its slot is labelled
    const label = slotLabel(slot, 3);

    // Then it reads above the count, which is why the pane is still drawn at all
    expect(label).toBe("slot 3 / 2");
  });

  test("the panes of an agent are numbered by where they are drawn", () => {
    // Given an agent whose slot 1 was taken away, leaving the pool holding 2 and 3
    const view = viewOf({
      slots: [
        busyRow({ ...slotAt(SLOTS[0], 2), total: 2 }),
        busyRow({ ...slotAt(SLOTS[0], 3), total: 2 }),
      ],
    });

    // When the panes are labelled
    const labels = panes(view).map((pane) => slotLabel(pane.slot, pane.number));

    // Then they count from one across the panes on screen, not from the numbers the pool kept
    expect(labels).toEqual(["slot 1 / 2", "slot 2 / 2"]);
  });

  test("each agent's panes are numbered from one", () => {
    // Given two agents drawn side by side, each holding one slot
    const view = viewOf({
      slots: [
        busyRow({ ...slotAt(SLOTS[0], 2), total: 1 }),
        busyRow({
          ...slotAt(SLOTS[0], 4),
          agent: "pi-anthropic-claude-opus-4-5",
          name: "pi-anthropic-claude-opus-4-5-4",
          total: 1,
        }),
      ],
    });

    // When the panes are labelled
    const labels = panes(view).map((pane) => slotLabel(pane.slot, pane.number));

    // Then neither agent's numbering is carried into the other's
    expect(labels).toEqual(["slot 1", "slot 1"]);
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

  test("an agent at its limit is offered no plus to click", () => {
    // Given a pane whose agent runs the two slots its limit allows
    const slot = busyRow({ index: 1, total: 2, max: 2 });

    // When its buttons are drawn
    const drawn = plain(slotButtons(slot));

    // Then only the minus is offered, because the limit is what the console may not pass
    expect(drawn).toBe(FEWER);
  });

  test("an agent below its limit is still offered the plus", () => {
    // Given a pane whose agent runs one of the three slots its limit allows
    const slot = busyRow({ index: 1, total: 1, max: 3 });

    // When its buttons are drawn
    const drawn = plain(slotButtons(slot));

    // Then the plus stands until the count reaches the limit
    expect(drawn).toBe(MORE);
  });

  test("a slot at its agent's limit takes no growing click", () => {
    // Given a header drawn for an agent that runs the one slot its limit allows
    const pane = paneOf({ slots: [busyRow({ index: 1, total: 1, max: 1 })] });

    // When the header is drawn
    const { hits } = header(pane, 60, 2000);

    // Then no hit region offers a count above the limit
    expect(hits.filter((hit) => hit.command.command === "slots")).toHaveLength(
      0,
    );
  });

  test("a pane the console has asked for reads as loading", () => {
    // Given a pane for a slot clicked into being that the server has not published
    const view = viewOf({
      slots: [
        busyRow({ ...SLOTS[0], total: 3 }),
        busyRow({ ...SLOTS[1], total: 3 }),
        { ...idleRow(slotAt(SLOTS[0], 3), 3), pending: true },
      ],
    });
    const pane = at(panes(view), 2);

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
