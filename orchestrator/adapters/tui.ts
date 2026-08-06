import fs from "node:fs";
import type { AgentRow } from "../domain/agents.ts";
import type { RunningCheck } from "../domain/checks.ts";
import type { TaskRow } from "../domain/graph.ts";
import { type Sample, push, tokensPerSecond } from "../domain/rates.ts";
import {
  type Entry,
  appendEntries,
  recordEntries,
  stamp,
} from "../domain/session.ts";
import type { Line } from "../domain/text.ts";
import {
  type Frame,
  type Hit,
  type Layout,
  type Region,
  type Scroll,
  type View,
  PaneLines,
  halfPage,
  panes,
  queueHeader,
  screen,
  scrollBack,
  scrollBottom,
  scrollForward,
  scrollTop,
} from "../policy/console.ts";
import { hitAt, keys, mouse, within } from "../policy/keys.ts";
import type { Candidate } from "../policy/scheduler.ts";
import { writeCommand } from "./command.ts";
import { Runtime } from "./runtime.ts";

export const TICK_MS = 1000;
export const FRAME_MS = 16;

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const ALT_SCREEN_OFF = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

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
          appendEntries(this.entries, result);
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
