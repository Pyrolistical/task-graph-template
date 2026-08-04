#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import type { TaskId } from "./task.ts";
import type { AgentRow } from "./agents.ts";
import {
  type Activity,
  abortable,
  describeActivity,
  describeLabel,
  elapsed,
  elapsedSuffix,
} from "./activity.ts";
import type { RunningCheck } from "./checks.ts";
import type { TaskRow } from "./graph.ts";
import type { Candidate, Rank } from "./scheduler.ts";
import { type Command, writeCommand } from "./command.ts";
import { type Sample, push, tokensPerSecond } from "./rates.ts";
import { Runtime } from "./runtime.ts";

export const TICK_MS = 1000;
export const FRAME_MS = 16;
export const QUEUE_LINES = 2;
export const HEADER_LINES = 4;
export const MIN_PANE_WIDTH = 24;

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const ALT_SCREEN_OFF = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

export const DIM = "2";
export const RED = "31";
export const GREEN = "32";
export const ELLIPSIS = "…";
export const REVERSE = "7";
export const SWITCH_ON = "[─●]";
export const SWITCH_OFF = "[●─]";
export const NEWS = " New messages ↓ ";

export interface Span {
  text: string;
  sgr?: string;
}

export type Line = Span[];

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const WIDE = /\p{Emoji_Presentation}|\uFE0F/u;

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b16f],
  [0x20000, 0x3fffd],
];

export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const part of SEGMENTER.segment(text)) {
    out.push(part.segment);
  }
  return out;
}

export function charWidth(grapheme: string): number {
  if (WIDE.test(grapheme)) {
    return 2;
  }
  const code = grapheme.codePointAt(0) ?? 0;
  for (const [low, high] of WIDE_RANGES) {
    if (code >= low && code <= high) {
      return 2;
    }
  }
  return 1;
}

function charsWidth(chars: string[]): number {
  let width = 0;
  for (const char of chars) {
    width += charWidth(char);
  }
  return width;
}

export function textWidth(text: string): number {
  return charsWidth(graphemes(text));
}

function fit(chars: string[], width: number): number {
  let used = 0;
  let count = 0;
  for (const char of chars) {
    const next = used + charWidth(char);
    if (next > width) {
      break;
    }
    used = next;
    count += 1;
  }
  return count;
}

export function spanWidth(spans: Line): number {
  let width = 0;
  for (const span of spans) {
    width += textWidth(span.text);
  }
  return width;
}

export function clip(spans: Line, width: number): Line {
  if (width <= 0) {
    return [];
  }
  const out: Line = [];
  let used = 0;
  for (const span of spans) {
    const chars = graphemes(span.text);
    const spanned = charsWidth(chars);
    if (used + spanned <= width) {
      out.push(span);
      used += spanned;
      continue;
    }
    const room = width - used - 1;
    const kept = chars.slice(0, fit(chars, room));
    if (kept.length > 0) {
      out.push({ text: kept.join(""), sgr: span.sgr });
    }
    out.push({ text: ELLIPSIS, sgr: span.sgr });
    return out;
  }
  return out;
}

export function take(spans: Line, width: number): Line {
  const out: Line = [];
  let used = 0;
  for (const span of spans) {
    if (used >= width) {
      break;
    }
    const chars = graphemes(span.text);
    const spanned = charsWidth(chars);
    if (used + spanned <= width) {
      out.push(span);
      used += spanned;
      continue;
    }
    const kept = chars.slice(0, fit(chars, width - used));
    const room = width - used - charsWidth(kept);
    out.push({ text: kept.join("") + " ".repeat(room), sgr: span.sgr });
    used = width;
  }
  return out;
}

export function drop(spans: Line, width: number): Line {
  const out: Line = [];
  let used = 0;
  for (const span of spans) {
    if (used >= width) {
      out.push(span);
      continue;
    }
    const chars = graphemes(span.text);
    const spanned = charsWidth(chars);
    if (used + spanned <= width) {
      used += spanned;
      continue;
    }
    const count = fit(chars, width - used);
    const head = charsWidth(chars.slice(0, count));
    let rest = chars.slice(count);
    let room = "";
    if (used + head < width && rest.length > 0) {
      room = " ".repeat(used + head + charWidth(rest[0]!) - width);
      rest = rest.slice(1);
    }
    out.push({ text: room + rest.join(""), sgr: span.sgr });
    used += spanned;
  }
  return out;
}

export function pad(spans: Line, width: number): Line {
  const clipped = clip(spans, width);
  const room = width - spanWidth(clipped);
  if (room <= 0) {
    return clipped;
  }
  return [...clipped, { text: " ".repeat(room) }];
}

export function renderLine(spans: Line): string {
  let out = "";
  for (const span of spans) {
    out += span.sgr ? `\x1b[${span.sgr}m${span.text}\x1b[0m` : span.text;
  }
  return out;
}

export function wrap(text: string, first: number, rest: number): string[] {
  const lines: string[] = [];
  let width = first;
  let current = "";

  const flush = () => {
    lines.push(current);
    current = "";
    width = rest;
  };

  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    let chars = graphemes(word);
    const wordWidth = charsWidth(chars);
    if (current === "" && wordWidth <= width) {
      current = word;
      continue;
    }
    if (current !== "" && textWidth(current) + 1 + wordWidth <= width) {
      current = `${current} ${word}`;
      continue;
    }
    if (current !== "") {
      flush();
    }
    while (charsWidth(chars) > width) {
      const count = Math.max(1, fit(chars, width));
      lines.push(chars.slice(0, count).join(""));
      chars = chars.slice(count);
      width = rest;
    }
    current = chars.join("");
  }

  if (current !== "" || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

export interface Entry {
  timestampMs: number;
  label: string;
  text: string;
  error: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

function entry(
  timestampMs: number,
  label: string,
  text: string,
  error = false,
): Entry {
  return { timestampMs, label, text, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stamp(record: Record<string, unknown>): number {
  const value = record.timestamp;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return 0;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return "";
}

function countLines(text: string): number {
  return text.replace(/\n+$/, "").split("\n").length;
}

const TOOL_ARG_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "url",
] as const;

function toolArg(args: unknown): string {
  if (!isObject(args)) {
    return String(args ?? "");
  }
  for (const key of TOOL_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      return oneLine(value);
    }
  }
  return oneLine(JSON.stringify(args));
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .filter((part) => isObject(part) && part.type === "text")
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("")
    .trim();
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function messageEntries(record: Record<string, unknown>): {
  entries: Entry[];
  usage: Usage | null;
} {
  const message = record.message;
  if (!isObject(message)) {
    return { entries: [], usage: null };
  }

  const at = stamp(record);
  const role = message.role;

  if (role === "user") {
    const text = contentText(message.content);
    return {
      entries: text === "" ? [] : [entry(at, "user", text)],
      usage: null,
    };
  }

  if (role === "toolResult") {
    const text = contentText(message.content);
    if (message.isError) {
      return {
        entries: [entry(at, "error", firstLine(text), true)],
        usage: null,
      };
    }
    const lines = countLines(text);
    return {
      entries: [
        entry(at, "result", lines > 1 ? `${lines} lines` : firstLine(text)),
      ],
      usage: null,
    };
  }

  if (role !== "assistant") {
    return { entries: [], usage: null };
  }

  const entries: Entry[] = [];
  const content = Array.isArray(message.content) ? message.content : [];

  for (const part of content) {
    if (!isObject(part)) {
      continue;
    }
    if (part.type === "thinking") {
      const text = String(part.thinking ?? "").trim();
      if (text !== "") {
        entries.push(entry(at, "thinking", text));
      }
    } else if (part.type === "text") {
      const text = String(part.text ?? "").trim();
      if (text !== "") {
        entries.push(entry(at, "text", text));
      }
    } else if (part.type === "toolCall") {
      entries.push(
        entry(at, String(part.name ?? "tool"), toolArg(part.arguments)),
      );
    }
  }

  const usage = message.usage;
  if (!isObject(usage)) {
    return { entries, usage: null };
  }

  return {
    entries,
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
    },
  };
}

export function recordEntries(record: Record<string, unknown>): {
  entries: Entry[];
  usage: Usage | null;
} {
  const at = stamp(record);
  switch (record.type) {
    case "session": {
      return {
        entries: [entry(at, "session", `cwd ${record.cwd ?? "?"}`)],
        usage: null,
      };
    }
    case "model_change": {
      return {
        entries: [entry(at, "model", `${record.provider}/${record.modelId}`)],
        usage: null,
      };
    }
    case "thinking_level_change": {
      return {
        entries: [entry(at, "model", `thinking ${record.thinkingLevel}`)],
        usage: null,
      };
    }
    case "message": {
      return messageEntries(record);
    }
    default: {
      return { entries: [], usage: null };
    }
  }
}

function append(
  entries: Entry[],
  result: { entries: Entry[]; usage: Usage | null },
): void {
  for (const next of result.entries) {
    const last = entries[entries.length - 1];
    if (
      next.label === "model" &&
      next.text.startsWith("thinking ") &&
      last !== undefined &&
      last.label === "model"
    ) {
      last.text = `${last.text} ${next.text}`;
      continue;
    }
    entries.push(next);
  }
}

const READ_CHUNK = 1 << 20;

export class SessionTail {
  readonly path: string;
  readonly entries: Entry[] = [];
  readonly samples: Sample[] = [];

  private offset = 0;
  private ino = 0;
  private pending = "";
  private decoder = new TextDecoder();

  constructor(filePath: string) {
    this.path = filePath;
  }

  read(): Entry[] {
    if (!fs.existsSync(this.path)) {
      return this.entries;
    }

    const stats = fs.statSync(this.path);
    if (stats.ino !== this.ino || stats.size < this.offset) {
      this.ino = stats.ino;
      this.offset = 0;
      this.pending = "";
      this.decoder = new TextDecoder();
      this.entries.length = 0;
      this.samples.length = 0;
    }
    if (this.offset === stats.size) {
      return this.entries;
    }

    const handle = fs.openSync(this.path, "r");
    try {
      while (this.offset < stats.size) {
        const buffer = Buffer.allocUnsafe(
          Math.min(READ_CHUNK, stats.size - this.offset),
        );
        const read = fs.readSync(handle, buffer, 0, buffer.length, this.offset);
        if (read === 0) {
          break;
        }
        this.offset += read;
        const text =
          this.pending +
          this.decoder.decode(buffer.subarray(0, read), { stream: true });
        const lines = text.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") {
            continue;
          }
          const record = JSON.parse(line) as Record<string, unknown>;
          const result = recordEntries(record);
          append(this.entries, result);
          if (result.usage !== null) {
            push(this.samples, {
              timestampMs: stamp(record),
              tokens: result.usage.output,
            });
          }
        }
      }
    } finally {
      fs.closeSync(handle);
    }

    return this.entries;
  }
}

export class Sessions {
  private readonly tails = new Map<string, SessionTail>();
  private readonly wrapped = new Map<string, PaneLines>();

  entries(sessionPath: string | null): Entry[] {
    if (sessionPath === null) {
      return [];
    }
    return this.tail(sessionPath).read();
  }

  lines(sessionPath: string | null, width: number): Line[] {
    if (sessionPath === null) {
      return [];
    }
    const existing = this.wrapped.get(sessionPath);
    if (existing !== undefined) {
      return existing.update(this.tail(sessionPath).entries, width);
    }
    const cache: PaneLines = new PaneLines();
    this.wrapped.set(sessionPath, cache);
    return cache.update(this.tail(sessionPath).entries, width);
  }

  rate(sessionPath: string | null, nowMs: number): number | null {
    if (sessionPath === null) {
      return null;
    }
    const tail = this.tails.get(sessionPath);
    if (tail === undefined) {
      return null;
    }
    return tokensPerSecond(tail.samples, nowMs);
  }

  keep(sessionPaths: Set<string>): void {
    for (const sessionPath of this.tails.keys()) {
      if (!sessionPaths.has(sessionPath)) {
        this.tails.delete(sessionPath);
        this.wrapped.delete(sessionPath);
      }
    }
  }

  private tail(sessionPath: string): SessionTail {
    const existing = this.tails.get(sessionPath);
    if (existing !== undefined) {
      return existing;
    }
    const tail: SessionTail = new SessionTail(sessionPath);
    this.tails.set(sessionPath, tail);
    return tail;
  }
}

export interface View {
  agents: AgentRow[];
  tasks: TaskRow[];
  checks: RunningCheck[];
  queue: Candidate[];
  scheduling: boolean;
}

function readEnvelope(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function rowsOf<T>(
  envelope: Record<string, unknown>,
  filePath: string,
  key: string,
): T[] {
  const rows = envelope[key];
  if (!Array.isArray(rows)) {
    throw new Error(`${filePath} has no "${key}" array`);
  }
  return rows as T[];
}

function readRows<T>(filePath: string, key: string): T[] {
  return rowsOf<T>(readEnvelope(filePath), filePath, key);
}

export function readView(runtime: Runtime): View {
  if (!fs.existsSync(runtime.agentsView)) {
    throw new Error(`console: no server state at ${runtime.root}`);
  }

  const queue = readEnvelope(runtime.queueView);
  if (typeof queue.scheduling !== "boolean") {
    throw new Error(`${runtime.queueView} has no "scheduling" flag`);
  }

  return {
    agents: readRows<AgentRow>(runtime.agentsView, "agents"),
    tasks: readRows<TaskRow>(runtime.tasksView, "tasks"),
    checks: readRows<RunningCheck>(runtime.checksView, "checks"),
    queue: rowsOf<Candidate>(queue, runtime.queueView, "queue"),
    scheduling: queue.scheduling,
  };
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

  return view.agents.map((agent) => ({
    agent,
    task: agent.task_id === null ? null : (tasks.get(agent.task_id) ?? null),
    check: agent.task_id === null ? null : (checks.get(agent.task_id) ?? null),
    sinceMs: agent.started_at === null ? null : Date.parse(agent.started_at),
  }));
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
  command: Command;
}

export function toggle(on: boolean, label: string, readOnly: boolean): Line {
  const suffix = label === "" ? "" : ` ${label}`;
  return [
    {
      text: readOnly
        ? `${label === "" ? "" : `${label} `}${on ? "enabled" : "disabled"}`
        : `${on ? SWITCH_ON : SWITCH_OFF}${suffix}`,
      sgr: on ? GREEN : DIM,
    },
  ];
}

export function abortButton(pane: Pane, readOnly: boolean): Line {
  if (readOnly || !abortable(pane.agent.activity)) {
    return [];
  }
  return [{ text: "[abort]", sgr: RED }];
}

export const RANK_LABELS: Record<Rank, string> = {
  resume: "resume",
  WORK_REVIEW: "WORK_REVIEW",
  WORK_STARTED: "WORK",
  WORK_FRESH: "WORK",
  PLAN_REVIEW: "PLAN_REVIEW",
  PLAN_STARTED: "PLAN",
  PLAN_FRESH: "PLAN",
  DESIGN_REVIEW: "DESIGN_REVIEW",
  DESIGN_STARTED: "DESIGN",
  DESIGN_FRESH: "DESIGN",
};

export function queueHeader(
  view: View,
  columns: number,
  readOnly: boolean,
): { line: Line; hits: Hit[] } {
  const scheduler = toggle(view.scheduling, "scheduler", readOnly);
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
      { text: ` ${RANK_LABELS[candidate.rank]}`, sgr: DIM },
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
    hits: readOnly
      ? []
      : [
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
  if (agent.retry_at !== undefined) {
    parts.push(
      `retry ${agent.attempt} at ${clock(Date.parse(agent.retry_at))}`,
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
  readOnly: boolean,
): Line[] {
  const enabled = toggle(pane.agent.enabled, "", readOnly);
  const right = stateLine(pane, nowMs);
  const room = width - spanWidth(enabled) - textWidth(right) - 1;
  const left = clip([{ text: ` ${identity(pane.agent)}` }], room);
  const gap = Math.max(
    1,
    width - spanWidth(enabled) - spanWidth(left) - textWidth(right),
  );
  const button = abortButton(pane, readOnly);
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
  readOnly: boolean;
}

export interface Frame {
  lines: string[];
  bases: number[];
  hits: Hit[];
  news: Region | null;
}

export function screen(cells: Cell[], queue: Line, layout: Layout): Frame {
  if (cells.length === 0) {
    throw new Error("console: the agents view is empty");
  }

  const { columns, rows, nowMs, scroll, readOnly } = layout;
  const width = paneWidth(columns, cells.length);
  if (width < MIN_PANE_WIDTH) {
    const needed = MIN_PANE_WIDTH * cells.length + cells.length - 1;
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
    if (!readOnly) {
      const from = index * (width + 1);
      hits.push({
        row: QUEUE_LINES,
        from,
        to: from + spanWidth(toggle(pane.agent.enabled, "", readOnly)),
        command: {
          command: "agent",
          agent: pane.agent.agent,
          enabled: !pane.agent.enabled,
        },
      });
      const button = abortButton(pane, readOnly);
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
    }
    return [
      ...header(pane, rate, width, nowMs, readOnly),
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
    out.push(
      renderLine(
        news !== null && row + QUEUE_LINES === news.row
          ? overlay(line, newsButton(), news)
          : line,
      ),
    );
  }

  return { lines: out, bases, hits, news };
}

export function frame(
  runtime: Runtime,
  sessions: Sessions,
  layout: Layout,
): Frame {
  const view = readView(runtime);
  const cells = panes(view).map((pane) => {
    const session = pane.agent.session;
    sessions.entries(session);
    return {
      pane,
      rate: sessions.rate(session, layout.nowMs),
      lines: (width: number) => sessions.lines(session, width),
    };
  });

  sessions.keep(
    new Set(
      cells
        .map(({ pane }) => pane.agent.session)
        .filter((session): session is string => session !== null),
    ),
  );

  const queue = queueHeader(view, layout.columns, layout.readOnly);
  const rendered = screen(cells, queue.line, layout);
  return { ...rendered, hits: [...queue.hits, ...rendered.hits] };
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

function halfPage(rows: number): number {
  return Math.max(1, Math.floor((rows - QUEUE_LINES - HEADER_LINES) / 2));
}

export function keys(chunk: string): string[] {
  const found: string[] = [];
  let at = 0;

  while (at < chunk.length) {
    const rest = chunk.slice(at);
    const sequence =
      rest.match(/^\x1b\[<\d+;\d+;\d+[mM]/) ??
      rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    if (sequence === null) {
      found.push(rest[0]!);
      at += 1;
      continue;
    }
    found.push(sequence[0]);
    at += sequence[0].length;
  }

  return found;
}

export interface Mouse {
  button: number;
  column: number;
  row: number;
  pressed: boolean;
}

export function mouse(key: string): Mouse | null {
  const match = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
  if (match === null) {
    return null;
  }
  return {
    button: parseInt(match[1]!, 10),
    column: parseInt(match[2]!, 10) - 1,
    row: parseInt(match[3]!, 10) - 1,
    pressed: match[4] === "M",
  };
}

export function within(region: Region, event: Mouse): boolean {
  return (
    region.row === event.row &&
    event.column >= region.from &&
    event.column < region.to
  );
}

export function hitAt(hits: Hit[], event: Mouse): Command | null {
  const hit = hits.find((candidate) => within(candidate, event));
  return hit === undefined ? null : hit.command;
}

export async function main(repo: string, readOnly: boolean): Promise<void> {
  const runtime: Runtime = new Runtime(repo);
  if (!fs.existsSync(runtime.agentsView)) {
    throw new Error(`console: no server state at ${runtime.root}`);
  }
  if (!process.stdout.isTTY) {
    throw new Error("console: stdout is not a tty");
  }

  const sessions: Sessions = new Sessions();
  const scroll: Scroll = { bases: null, offsets: [] };
  let hits: Hit[] = [];
  let bottoms: number[] = [];
  let news: Region | null = null;
  let scheduled = false;

  const restore = () => {
    clearInterval(timer);
    process.stdout.write(ALT_SCREEN_OFF);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };

  const draw = () => {
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    let result: Frame;
    try {
      result = frame(runtime, sessions, {
        columns,
        rows,
        nowMs: Date.now(),
        scroll,
        readOnly,
      });
    } catch (err) {
      restore();
      throw err;
    }
    bottoms = result.bases;
    hits = result.hits;
    news = result.news;
    process.stdout.write(
      `\x1b[H${result.lines.map((line) => `${line}\x1b[K`).join("\r\n")}`,
    );
  };

  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      draw();
    }, FRAME_MS);
  };

  const quit = () => {
    restore();
    process.exit(0);
  };

  process.stdout.write(ALT_SCREEN_ON);
  const timer = setInterval(draw, TICK_MS);
  process.stdout.on("resize", draw);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      const page = halfPage(process.stdout.rows ?? 24);
      const back = (count: number) => scrollBack(scroll, bottoms, count);
      const forward = (count: number) => scrollForward(scroll, count);

      let moved = false;
      for (const key of keys(data.toString())) {
        if (key === "q" || key === "\x03") {
          quit();
          return;
        }
        switch (key) {
          case "j":
          case "\x1b[B": {
            forward(1);
            break;
          }
          case "k":
          case "\x1b[A": {
            back(1);
            break;
          }
          case "\x1b[6~":
          case "\x06":
          case "\x04":
          case " ": {
            forward(page);
            break;
          }
          case "\x1b[5~":
          case "\x02":
          case "\x15": {
            back(page);
            break;
          }
          case "g":
          case "\x1b[H": {
            scrollTop(scroll, bottoms);
            break;
          }
          case "G":
          case "\x1b[F": {
            scrollBottom(scroll);
            break;
          }
          default: {
            const event = mouse(key);
            if (event === null) {
              continue;
            }
            if (event.button === 64) {
              back(3);
            } else if (event.button === 65) {
              forward(3);
            } else if (event.button === 0 && event.pressed) {
              if (news !== null && within(news, event)) {
                scrollBottom(scroll);
                break;
              }
              const command = hitAt(hits, event);
              if (command === null) {
                continue;
              }
              writeCommand(runtime, command);
            } else {
              continue;
            }
          }
        }
        moved = true;
      }

      if (moved) {
        schedule();
      }
    });
  }

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  draw();
}

if (import.meta.main) {
  await main(path.resolve(process.argv[2] ?? process.cwd()), false);
}
