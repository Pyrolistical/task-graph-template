import { type ConsoleView, type Pane, header, toggle } from "./panes.ts";
import type { Hit, Region } from "../domain/hits.ts";
import {
  type Scroll,
  HEADER_LINES,
  QUEUE_LINES,
  baseOf,
  body,
  bodyHeight,
  topOf,
} from "./scroll.ts";
import {
  type Line,
  type Span,
  DIM,
  REVERSE,
  clip,
  drop,
  pad,
  renderLine,
  spanWidth,
  take,
  textWidth,
  wrap,
} from "../domain/text.ts";
import { rankLabel } from "../../views/queue.ts";

export const MIN_PANE_WIDTH = 24;

export const NEWS = " New messages ↓ ";
export const HIDE = " hide disabled ";
export const SHOW = ["  show  ", "disabled", " agents "];
export const COLLAPSED_WIDTH = 8;

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
