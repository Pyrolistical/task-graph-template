import type { AgentRow } from "../domain/agents.ts";
import {
  abortable,
  describeActivity,
  describeLabel,
  elapsed,
  elapsedSuffix,
} from "../domain/activity.ts";
import type { RunningCheck } from "../domain/checks.ts";
import type { Command } from "../domain/command.ts";
import type { TaskRow } from "../domain/graph.ts";
import type { Entry } from "../domain/session.ts";
import type { TaskId } from "../domain/task.ts";
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
import { type Candidate, rankLabel } from "./scheduler.ts";

export const QUEUE_LINES = 2;
export const HEADER_LINES = 4;
export const MIN_PANE_WIDTH = 24;

export const SWITCH_ON = "[─●]";
export const SWITCH_OFF = "[●─]";
export const NEWS = " New messages ↓ ";
export const HIDE = " hide disabled ";
export const SHOW = ["  show  ", "disabled", " agents "];
export const COLLAPSED_WIDTH = 8;

export type Local = { command: "hide_disabled" } | { command: "show_disabled" };

export interface View {
  agentsFile: string;
  agents: AgentRow[];
  tasks: TaskRow[];
  checks: RunningCheck[];
  queue: Candidate[];
  scheduling: boolean;
}

export interface Pane {
  agent: AgentRow;
  task: TaskRow | null;
  check: RunningCheck | null;
  sinceMs: number | null;
}

export function panes(view: View): Pane[] {
  const tasks = new Map<TaskId, TaskRow>(
    view.tasks.map((row) => [row.id, row]),
  );
  const checks = new Map<TaskId, RunningCheck>();
  for (const check of view.checks) {
    if (!checks.has(check.task_id)) {
      checks.set(check.task_id, check);
    }
  }

  return view.agents
    .map((agent) => ({
      agent,
      task: agent.task_id === null ? null : (tasks.get(agent.task_id) ?? null),
      check:
        agent.task_id === null ? null : (checks.get(agent.task_id) ?? null),
      sinceMs: agent.started_at === null ? null : Date.parse(agent.started_at),
    }))
    .sort((one, two) => Number(two.agent.enabled) - Number(one.agent.enabled));
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
  if (!abortable(pane.agent.activity)) {
    return [];
  }
  return [{ text: "[abort]", sgr: RED }];
}

export function queueHeader(
  view: View,
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

function identity(agent: AgentRow): string {
  return [
    agent.type,
    `${agent.provider}/${agent.model}`,
    `slot ${agent.slot}`,
  ].join(" ");
}

function stateLine(pane: Pane, nowMs: number): string {
  const state =
    pane.agent.state === "DISABLED" ? "idle" : pane.agent.state.toLowerCase();
  if (pane.sinceMs === null) {
    return state;
  }
  const since = elapsed(nowMs - pane.sinceMs);
  return state === "busy" ? since : `${state} ${since}`;
}

export function detailLine(pane: Pane): string {
  const { agent, task } = pane;
  if (agent.task_id === null) {
    return "no task";
  }

  const parts = [`task ${agent.task_id}`];
  if (agent.role !== null) {
    parts.push(agent.role);
  }
  if (task !== null) {
    parts.push(task.state);
  }
  if (agent.pid !== null) {
    parts.push(`pid ${agent.pid}`);
  }
  if (agent.retry !== null) {
    parts.push(
      `retry ${agent.retry.attempt} at ${clock(Date.parse(agent.retry.at))}`,
    );
  }
  return parts.join(" ");
}

export function activityLine(pane: Pane): string {
  if (pane.check !== null) {
    return `check ${pane.check.index}: ${oneLine(pane.check.command)}`;
  }
  return describeActivity(pane.agent.activity);
}

export function statsLine(pane: Pane, rate: number | null): string {
  const parts: string[] = [];
  if (rate !== null) {
    parts.push(`${thousands(Math.round(rate * 10) / 10)} tok/s`);
  }
  const compactions =
    pane.agent.compactions > 0 ? ` x${pane.agent.compactions}` : "";
  if (pane.agent.context_percent !== null) {
    parts.push(`ctx ${Math.round(pane.agent.context_percent)}%${compactions}`);
  }
  return parts.join(" ");
}

export function header(
  pane: Pane,
  rate: number | null,
  width: number,
  nowMs: number,
): Line[] {
  const enabled = toggle(pane.agent.enabled, "");
  const right = stateLine(pane, nowMs);
  const room = width - spanWidth(enabled) - textWidth(right) - 1;
  const left = clip([{ text: ` ${identity(pane.agent)}` }], room);
  const gap = Math.max(
    1,
    width - spanWidth(enabled) - spanWidth(left) - textWidth(right),
  );
  const button = abortButton(pane);
  const buttonWidth = spanWidth(button);
  const activityRow = (() => {
    if (pane.check !== null) {
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
    const suffix = elapsedSuffix(pane.agent.activity);
    const suffixWidth = textWidth(suffix);
    const label = [{ text: describeLabel(pane.agent.activity), sgr: DIM }];
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
  return [
    clip(
      [...enabled, ...left, { text: " ".repeat(gap) }, { text: right }],
      width,
    ),
    clip([{ text: detailLine(pane), sgr: DIM }], width),
    activityRow,
    clip([{ text: statsLine(pane, rate), sgr: DIM }], width),
  ];
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
    for (let index = this.folded; index < settled; index++) {
      const entry = entries[index]!;
      if (entry.label !== "usage") {
        this.lines.push(...entryLines(entry, width));
      }
    }
    this.folded = settled;

    const last = entries[entries.length - 1];
    if (last === undefined || last.label === "usage") {
      return this.lines;
    }
    return [...this.lines, ...entryLines(last, width)];
  }
}

export interface Scroll {
  bases: number[] | null;
  offsets: number[];
}

export function bodyHeight(rows: number): number {
  return rows - QUEUE_LINES - HEADER_LINES - 1;
}

export function topOf(total: number, height: number): number {
  return Math.max(0, total - height);
}

export function baseOf(
  lines: number,
  height: number,
  frozen: number | undefined,
): number {
  const bottom = topOf(lines, height);
  return frozen === undefined ? bottom : Math.min(frozen, bottom);
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

export function hideRegion(from: number, width: number, rows: number): Region {
  const button = spanWidth(hideButton());
  const left = from + Math.max(0, Math.floor((width - button) / 2));
  return {
    row: QUEUE_LINES + HEADER_LINES + Math.floor(bodyHeight(rows) / 2),
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
  rate: number | null;
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
  news: Region | null;
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
    if (line === undefined) {
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
    news: null,
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
    news: null,
  };
}

export function screen(
  cells: Cell[],
  queue: Line,
  layout: Layout,
  hidden = 0,
): Frame {
  if (cells.length === 0 && hidden === 0) {
    throw new Error("console: the agents view is empty");
  }

  const { columns, rows, nowMs, scroll } = layout;
  const strip = hidden === 0 ? 0 : COLLAPSED_WIDTH + 1;
  const width =
    cells.length === 0 ? 0 : paneWidth(columns - strip, cells.length);
  if (cells.length > 0 && width < MIN_PANE_WIDTH) {
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
    hits.push({
      row: QUEUE_LINES,
      from,
      to: from + spanWidth(toggle(pane.agent.enabled, "")),
      command: {
        command: "agent",
        agent: pane.agent.agent,
        enabled: !pane.agent.enabled,
      },
    });
    if (!pane.agent.enabled) {
      const at = hideRegion(from, width, rows);
      hits.push({ ...at, command: { command: "hide_disabled" } });
    }
    const button = abortButton(pane);
    if (button.length > 0) {
      const buttonWidth = spanWidth(button);
      hits.push({
        row: QUEUE_LINES + 2,
        from: from + width - buttonWidth,
        to: from + width,
        command: {
          command: "agent_abort",
          "agent-name-slot": pane.agent.name,
        },
      });
    }
    return [
      ...header(pane, rate, width, nowMs),
      [{ text: "─".repeat(width), sgr: DIM }],
      ...body(paneLines, height, base, scroll.offsets[index] ?? 0),
    ];
  });

  const rule: Line = [];
  rendered.forEach((_, index) => {
    if (index > 0) {
      rule.push({ text: "┬", sgr: DIM });
    }
    rule.push({ text: "─".repeat(width), sgr: DIM });
  });
  if (strip > 0) {
    if (rendered.length > 0) {
      rule.push({ text: "┬", sgr: DIM });
    }
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

  const news = unread ? newsRegion(columns, rows) : null;
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
      if (rendered.length > 0) {
        line.push({ text: row === HEADER_LINES ? "┤" : "│", sgr: DIM });
      }
      const label = SHOW[row + QUEUE_LINES - showAt];
      line.push(
        ...pad(
          label === undefined ? [] : [{ text: label, sgr: REVERSE }],
          COLLAPSED_WIDTH,
        ),
      );
    }
    const hides = hits.filter(
      (hit) =>
        hit.command.command === "hide_disabled" &&
        hit.row === row + QUEUE_LINES,
    );
    const withHides = hides.reduce(
      (drawn, at) => overlay(drawn, hideButton(), at),
      line,
    );
    out.push(
      renderLine(
        news !== null && row + QUEUE_LINES === news.row
          ? overlay(withHides, newsButton(), news)
          : withHides,
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
  if (scroll.bases === null) {
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
  scroll.bases = null;
  scroll.offsets = [];
}

export function halfPage(rows: number): number {
  return Math.max(1, Math.floor((rows - QUEUE_LINES - HEADER_LINES) / 2));
}
