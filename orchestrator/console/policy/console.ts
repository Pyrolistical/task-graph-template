import type { SlotRow } from "../../views/slots.ts";
import {
  abortable,
  describeActivity,
  describeLabel,
  elapsed,
  elapsedSuffix,
} from "../../views/activity.ts";
import type { RunningCheck } from "../../views/checks.ts";
import type { Command } from "../../runtime/domain/command.ts";
import type { TaskRow } from "../../views/tasks.ts";
import type { Entry } from "../domain/session.ts";
import type { TaskId } from "../../vocabulary/task.ts";
import {
  type Line,
  type Span,
  DIM,
  GREEN,
  RED,
  REVERSE,
  clip,
  drop,
  oneLine,
  pad,
  renderLine,
  spanWidth,
  take,
  textWidth,
  wrap,
} from "../domain/text.ts";
import { type Candidate, rankLabel } from "../../views/queue.ts";

export const QUEUE_LINES = 2;
export const HEADER_LINES = 4;
export const MIN_PANE_WIDTH = 24;

export const SWITCH_ON = "[─●]";
export const SWITCH_OFF = "[●─]";
export const FEWER = "[-]";
export const MORE = "[+]";
export const NEWS = " New messages ↓ ";
export const HIDE = " hide disabled ";
export const SHOW = ["  show  ", "disabled", " agents "];
export const COLLAPSED_WIDTH = 8;

export type Local = { command: "hide_disabled" } | { command: "show_disabled" };

export type ConsoleSlot = SlotRow & { pending?: boolean };

export interface ConsoleView {
  agentsFile: string;
  slots: ConsoleSlot[];
  tasks: TaskRow[];
  checks: RunningCheck[];
  queue: Candidate[];
  scheduling: boolean;
}

export interface Pane {
  slot: ConsoleSlot;
  task?: TaskRow;
  check?: RunningCheck;
  sinceMs?: number;
}

export function panes(view: ConsoleView): Pane[] {
  const tasks = new Map<TaskId, TaskRow>(
    view.tasks.map((row) => [row.id, row]),
  );
  const checks = new Map<TaskId, RunningCheck>();
  for (const check of view.checks) {
    if (!checks.has(check.task_id)) {
      checks.set(check.task_id, check);
    }
  }

  return view.slots
    .map((slot) => ({
      slot,
      task: slot.task_id ? tasks.get(slot.task_id) : undefined,
      check: slot.task_id ? checks.get(slot.task_id) : undefined,
      sinceMs: !slot.started_at ? undefined : Date.parse(slot.started_at),
    }))
    .sort((one, two) => Number(two.slot.enabled) - Number(one.slot.enabled));
}

export function clock(timestampMs: number): string {
  const at = new Date(timestampMs);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function thousands(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return `${(n / 1000).toFixed(1)}k`;
}

export interface Region {
  row: number;
  from: number;
  to: number;
}

export interface Hit extends Region {
  command: Command | Local;
}

export function toggle(on: boolean, label: string): Line {
  const suffix = label === "" ? "" : ` ${label}`;
  return [
    {
      text: `${on ? SWITCH_ON : SWITCH_OFF}${suffix}`,
      sgr: on ? GREEN : DIM,
    },
  ];
}

export function abortButton(pane: Pane): Line {
  if (!abortable(pane.slot.activity)) {
    return [];
  }
  return [{ text: "[abort]", sgr: RED }];
}

export function queueHeader(
  view: ConsoleView,
  columns: number,
): { line: Line; hits: Hit[] } {
  const scheduler = toggle(view.scheduling, "scheduler");
  const divider: Span = { text: " │ ", sgr: DIM };
  const summary =
    view.queue.length === 0 ? "nothing queued" : `${view.queue.length} queued`;
  const limit = columns - textWidth(summary) - 1;

  const items: Line = [];
  let used = spanWidth(scheduler) + textWidth(divider.text);

  for (const candidate of view.queue) {
    const item: Line = [
      ...(items.length === 0 ? [] : [{ text: " ", sgr: DIM }]),
      { text: candidate.task_id },
      { text: ` ${rankLabel(candidate.rank)}`, sgr: DIM },
    ];
    if (used + spanWidth(item) > limit) {
      break;
    }
    items.push(...item);
    used += spanWidth(item);
  }

  const gap = Math.max(1, columns - used - textWidth(summary));
  return {
    line: clip(
      [
        ...scheduler,
        divider,
        ...items,
        { text: " ".repeat(gap) },
        { text: summary, sgr: DIM },
      ],
      columns,
    ),
    hits: [
      {
        row: 0,
        from: 0,
        to: spanWidth(scheduler),
        command: { command: "scheduler", enabled: !view.scheduling },
      },
    ],
  };
}

export function slotLabel(slot: SlotRow): string {
  return slot.index === 1 && slot.total === 1
    ? `slot ${slot.index}`
    : `slot ${slot.index} / ${slot.total}`;
}

function identity(slot: SlotRow): string {
  return [slot.type, `${slot.provider}/${slot.model}`].join(" ");
}

export function slotButtons(slot: SlotRow): Line {
  const fewer: Line = slot.total > 1 ? [{ text: FEWER, sgr: DIM }] : [];
  return [...fewer, { text: MORE, sgr: DIM }];
}

function slotHits(slot: SlotRow, at: number): Hit[] {
  let from = at;
  return slotButtons(slot).map((span) => {
    const to = from + textWidth(span.text);
    const hit: Hit = {
      row: 0,
      from,
      to,
      command: {
        command: "slots",
        agent: slot.agent,
        total: span.text === FEWER ? slot.total - 1 : slot.total + 1,
      },
    };
    from = to;
    return hit;
  });
}

export const LOADING = "loading";

function stateLine(pane: Pane, nowMs: number): string {
  if (pane.slot.pending) {
    return LOADING;
  }
  const state =
    pane.slot.state === "DISABLED"
      ? "idle"
      : pane.slot.state.toLowerCase().replace("_", " ");
  if (!pane.sinceMs) {
    return state;
  }
  const since = elapsed(nowMs - pane.sinceMs);
  return state === "busy" ? since : `${state} ${since}`;
}

export function detailLine(pane: Pane): string {
  const { slot, task } = pane;
  if (slot.pending) {
    return "waiting for the server";
  }
  if (slot.state === "UNREACHABLE") {
    return "provider not answering";
  }
  if (slot.state === "OFF_SCHEDULE") {
    return "outside its schedule";
  }
  if (!slot.task_id) {
    return "no task";
  }

  const parts = [`task ${slot.task_id}`];
  if (slot.role) {
    parts.push(slot.role);
  }
  if (task) {
    parts.push(task.state);
  }
  if (slot.pid) {
    parts.push(`pid ${slot.pid}`);
  }
  if (slot.retry) {
    parts.push(
      `retry ${slot.retry.attempt} at ${clock(Date.parse(slot.retry.at))}`,
    );
  }
  return parts.join(" ");
}

export function activityLine(pane: Pane): string {
  if (pane.check) {
    return `check ${pane.check.index}: ${oneLine(pane.check.command)}`;
  }
  return describeActivity(pane.slot.activity);
}

export function statsLine(pane: Pane, rate?: number): string {
  const parts: string[] = [];
  if (rate) {
    parts.push(`${thousands(Math.round(rate * 10) / 10)} tok/s`);
  }
  const compactions =
    pane.slot.compactions > 0 ? ` x${pane.slot.compactions}` : "";
  if (pane.slot.context_percent) {
    parts.push(`ctx ${Math.round(pane.slot.context_percent)}%${compactions}`);
  }
  if (pane.slot.cost) {
    parts.push(`$${pane.slot.cost.toFixed(2)}`);
  }
  return parts.join(" ");
}

export function header(
  pane: Pane,
  width: number,
  nowMs: number,
  rate?: number,
): { lines: Line[]; hits: Hit[] } {
  const enabled = toggle(pane.slot.enabled, "");
  const slots = slotButtons(pane.slot);
  const label = ` ${slotLabel(pane.slot)} `;
  const right = stateLine(pane, nowMs);
  const unreachable = pane.slot.state === "UNREACHABLE";
  const room =
    width - spanWidth(enabled) - spanWidth(slots) - textWidth(right) - 1;
  const left = clip(
    [
      ...clip([{ text: ` ${identity(pane.slot)}` }], room - textWidth(label)),
      { text: label },
    ],
    room,
  );
  const gap = Math.max(
    1,
    width -
      spanWidth(enabled) -
      spanWidth(left) -
      spanWidth(slots) -
      textWidth(right),
  );
  const button = abortButton(pane);
  const buttonWidth = spanWidth(button);
  const activityRow = (() => {
    if (pane.check) {
      const text = [{ text: activityLine(pane), sgr: DIM }];
      const room = width - buttonWidth;
      const clipped = clip(text, room);
      if (buttonWidth === 0) {
        return clipped;
      }
      return [
        ...clipped,
        { text: " ".repeat(width - spanWidth(clipped) - buttonWidth) },
        ...button,
      ];
    }
    const suffix = elapsedSuffix(pane.slot.activity);
    const suffixWidth = textWidth(suffix);
    const label = [{ text: describeLabel(pane.slot.activity), sgr: DIM }];
    const labelRoom = width - buttonWidth - suffixWidth;
    const clippedLabel = clip(label, Math.max(0, labelRoom));
    const suffixSpan: Line = suffix === "" ? [] : [{ text: suffix, sgr: DIM }];
    const joined: Line = [...clippedLabel, ...suffixSpan];
    if (buttonWidth === 0) {
      return joined;
    }
    const gap = width - spanWidth(joined) - buttonWidth;
    return [
      ...joined,
      ...(gap > 0 ? [{ text: " ".repeat(gap) }] : []),
      ...button,
    ];
  })();
  const hits: Hit[] = [
    {
      row: 0,
      from: 0,
      to: spanWidth(enabled),
      command: {
        command: "agent",
        agent: pane.slot.agent,
        enabled: !pane.slot.enabled,
      },
    },
    ...slotHits(pane.slot, spanWidth(enabled) + spanWidth(left)),
  ];
  if (buttonWidth > 0) {
    hits.push({
      row: 2,
      from: width - buttonWidth,
      to: width,
      command: { command: "slot_abort", slot: pane.slot.name },
    });
  }

  return {
    lines: [
      clip(
        [
          ...enabled,
          ...left,
          ...slots,
          { text: " ".repeat(gap) },
          { text: right, sgr: unreachable ? RED : undefined },
        ],
        width,
      ),
      clip([{ text: detailLine(pane), sgr: unreachable ? RED : DIM }], width),
      activityRow,
      clip([{ text: statsLine(pane, rate), sgr: DIM }], width),
    ],
    hits,
  };
}

export function entryLines(entry: Entry, width: number): Line[] {
  const prefix = `${clock(entry.timestampMs)} ${entry.label}: `;
  const prefixWidth = textWidth(prefix);
  const sgr = entry.error ? RED : DIM;
  const room = width - prefixWidth;

  if (room < 8) {
    const head: Line = [{ text: prefix.trimEnd(), sgr }];
    const rest = wrap(entry.text, width, width);
    return [
      clip(head, width),
      ...rest.map((line) => clip([{ text: line }], width)),
    ];
  }

  return wrap(entry.text, room, width).map((line, index) =>
    clip(
      index === 0 ? [{ text: prefix, sgr }, { text: line }] : [{ text: line }],
      width,
    ),
  );
}

export class PaneLines {
  private width = 0;
  private folded = 0;
  private lines: Line[] = [];

  update(entries: Entry[], width: number): Line[] {
    if (width !== this.width || entries.length < this.folded) {
      this.width = width;
      this.folded = 0;
      this.lines = [];
    }

    const settled = Math.max(0, entries.length - 1);
    for (const entry of entries.slice(this.folded, settled)) {
      if (entry.label !== "usage") {
        this.lines.push(...entryLines(entry, width));
      }
    }
    this.folded = settled;

    const last = entries[entries.length - 1];
    if (!last || last.label === "usage") {
      return this.lines;
    }
    return [...this.lines, ...entryLines(last, width)];
  }
}

export interface Scroll {
  bases?: number[];
  offsets: number[];
}

export function bodyHeight(rows: number): number {
  return rows - QUEUE_LINES - HEADER_LINES - 1;
}

export function topOf(total: number, height: number): number {
  return Math.max(0, total - height);
}

export function baseOf(lines: number, height: number, frozen?: number): number {
  const bottom = topOf(lines, height);
  return Math.min(frozen ?? bottom, bottom);
}

export function body(
  lines: Line[],
  height: number,
  base: number,
  offset: number,
): Line[] {
  const start = Math.max(0, base - offset);
  return lines.slice(start, start + height);
}

export function hideButton(): Line {
  return [{ text: HIDE, sgr: REVERSE }];
}

export function hideRegion(from: number, to: number, rows: number): Region {
  const button = spanWidth(hideButton());
  const left = from + Math.max(0, Math.floor((to - from - button) / 2));
  return {
    row:
      QUEUE_LINES + HEADER_LINES + 1 + Math.floor((bodyHeight(rows) - 1) / 2),
    from: left,
    to: left + button,
  };
}

export function newsButton(): Line {
  return [{ text: NEWS, sgr: REVERSE }];
}

export function newsRegion(columns: number, rows: number): Region {
  const width = spanWidth(newsButton());
  const from = Math.max(0, Math.floor((columns - width) / 2));
  return { row: rows - 2, from, to: Math.min(columns, from + width) };
}

export function overlay(line: Line, insert: Line, at: Region): Line {
  return [
    ...pad(take(line, at.from), at.from),
    ...insert,
    ...drop(line, at.to),
  ];
}

export function paneWidth(columns: number, count: number): number {
  return Math.floor((columns - (count - 1)) / count);
}

export interface Cell {
  pane: Pane;
  rate?: number;
  lines: (width: number) => Line[];
}

export interface Layout {
  columns: number;
  rows: number;
  nowMs: number;
  scroll: Scroll;
}

export interface Frame {
  lines: string[];
  bases: number[];
  hits: Hit[];
  news?: Region;
}

export function centred(
  text: string[],
  columns: number,
  rows: number,
): string[] {
  const top = Math.max(0, Math.floor((rows - text.length) / 2));
  const out: string[] = [];
  for (let row = 0; row < rows; row++) {
    const line = text[row - top];
    if (!line) {
      out.push(renderLine(pad([], columns)));
      continue;
    }
    const left = Math.max(0, Math.floor((columns - textWidth(line)) / 2));
    out.push(
      renderLine(
        pad([{ text: `${" ".repeat(left)}${line}`, sgr: DIM }], columns),
      ),
    );
  }
  return out;
}

export function emptyPool(
  queue: Line,
  layout: Layout,
  agentsFile: string,
): Frame {
  const { columns, rows } = layout;
  return {
    lines: [
      renderLine(pad(queue, columns)),
      renderLine([{ text: "─".repeat(columns), sgr: DIM }]),
      ...centred(
        ["the pool has no agents", `add one to ${agentsFile}`],
        columns,
        rows - QUEUE_LINES,
      ),
    ],
    bases: [],
    hits: [],
  };
}

export function errorFrame(message: string, layout: Layout): Frame {
  const { columns, rows } = layout;
  return {
    lines: centred(
      [
        "the console cannot draw",
        ...wrap(message, Math.max(1, columns - 4), Math.max(1, columns - 4)),
      ],
      columns,
      rows,
    ),
    bases: [],
    hits: [],
  };
}

export function screen(
  cells: Cell[],
  queue: Line,
  layout: Layout,
  hidden = 0,
): Frame {
  if (cells.length === 0) {
    throw new Error("console: the slots view is empty");
  }

  const { columns, rows, nowMs, scroll } = layout;
  const strip = hidden === 0 ? 0 : COLLAPSED_WIDTH + 1;
  const width = paneWidth(columns - strip, cells.length);
  if (width < MIN_PANE_WIDTH) {
    const needed = MIN_PANE_WIDTH * cells.length + cells.length - 1 + strip;
    throw new Error(
      `console: ${cells.length} panes need ${needed} columns, terminal has ${columns}`,
    );
  }

  const height = bodyHeight(rows);
  const bases: number[] = [];
  const hits: Hit[] = [];
  let unread = false;
  const rendered = cells.map(({ pane, rate, lines }, index) => {
    const paneLines = lines(width);
    const base = baseOf(paneLines.length, height, scroll.bases?.[index]);
    bases.push(base);
    unread = unread || topOf(paneLines.length, height) > base;
    const from = index * (width + 1);
    const drawn = header(pane, width, nowMs, rate);
    hits.push(
      ...drawn.hits.map((hit) => ({
        ...hit,
        row: hit.row + QUEUE_LINES,
        from: hit.from + from,
        to: hit.to + from,
      })),
    );
    return [
      ...drawn.lines,
      [{ text: "─".repeat(width), sgr: DIM }],
      ...body(paneLines, height, base, scroll.offsets[index] ?? 0),
    ];
  });

  const off = cells.flatMap((cell, index) =>
    cell.pane.slot.enabled ? [] : [index],
  );
  const hide =
    off.length === 0 || off.length === cells.length
      ? undefined
      : hideRegion(
          (off[0] ?? 0) * (width + 1),
          (off[off.length - 1] ?? 0) * (width + 1) + width,
          rows,
        );
  if (hide) {
    hits.push({ ...hide, command: { command: "hide_disabled" } });
  }

  const rule: Line = [];
  rendered.forEach((_, index) => {
    if (index > 0) {
      rule.push({ text: "┬", sgr: DIM });
    }
    rule.push({ text: "─".repeat(width), sgr: DIM });
  });
  const drawn = cells.length === 0 ? 0 : cells.length * (width + 1) - 1;
  const slack = columns - strip - drawn;
  if (strip > 0) {
    rule.push({ text: "─".repeat(slack), sgr: DIM });
    rule.push({ text: "┬", sgr: DIM });
    rule.push({ text: "─".repeat(COLLAPSED_WIDTH), sgr: DIM });
  }

  const showAt =
    QUEUE_LINES + Math.floor((rows - QUEUE_LINES - SHOW.length) / 2);
  if (strip > 0) {
    SHOW.forEach((_, index) => {
      hits.push({
        row: showAt + index,
        from: columns - COLLAPSED_WIDTH,
        to: columns,
        command: { command: "show_disabled" },
      });
    });
  }

  const news = unread ? newsRegion(columns, rows) : undefined;
  const out: string[] = [
    renderLine(pad(queue, columns)),
    renderLine(pad(rule, columns)),
  ];
  for (let row = 0; row < rows - QUEUE_LINES; row++) {
    const separator: Span = {
      text: row === HEADER_LINES ? "┼" : "│",
      sgr: DIM,
    };
    const line: Line = [];
    rendered.forEach((lines, index) => {
      if (index > 0) {
        line.push(separator);
      }
      line.push(...pad(lines[row] ?? [], width));
    });
    if (strip > 0) {
      line.push({ text: " ".repeat(slack) });
      line.push({ text: row === HEADER_LINES ? "┤" : "│", sgr: DIM });
      const label = SHOW[row + QUEUE_LINES - showAt];
      line.push(
        ...pad(!label ? [] : [{ text: label, sgr: REVERSE }], COLLAPSED_WIDTH),
      );
    }
    const withHide =
      hide && hide.row === row + QUEUE_LINES
        ? overlay(line, hideButton(), hide)
        : line;
    out.push(
      renderLine(
        news && row + QUEUE_LINES === news.row
          ? overlay(withHide, newsButton(), news)
          : withHide,
      ),
    );
  }

  return { lines: out, bases, hits, news };
}

function freeze(scroll: Scroll, bottoms: number[]): number[] {
  const bases = scroll.bases ?? bottoms;
  scroll.bases = bases;
  return bases;
}

export function scrollBack(
  scroll: Scroll,
  bottoms: number[],
  count: number,
): void {
  const bases = freeze(scroll, bottoms);
  scroll.offsets = bases.map((base, index) =>
    Math.min((scroll.offsets[index] ?? 0) + count, base),
  );
}

export function scrollForward(scroll: Scroll, count: number): void {
  if (!scroll.bases) {
    return;
  }
  scroll.offsets = scroll.offsets.map((offset) => Math.max(0, offset - count));
  if (scroll.offsets.every((offset) => offset === 0)) {
    scrollBottom(scroll);
  }
}

export function scrollTop(scroll: Scroll, bottoms: number[]): void {
  scroll.offsets = [...freeze(scroll, bottoms)];
}

export function scrollBottom(scroll: Scroll): void {
  scroll.bases = undefined;
  scroll.offsets = [];
}

export function halfPage(rows: number): number {
  return Math.max(1, Math.floor((rows - QUEUE_LINES - HEADER_LINES) / 2));
}
