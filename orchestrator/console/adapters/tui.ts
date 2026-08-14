import fs from "node:fs/promises";
import { z } from "zod";
import type { ViewName } from "../../runtime/ports/publisher.ts";
import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import { SlotsView } from "../../views/slots.ts";
import { ChecksView } from "../../views/checks.ts";
import { hasCode, messageOf } from "../../kernel/domain/errors.ts";
import { TasksView } from "../../views/tasks.ts";
import { parse } from "../../kernel/domain/schema.ts";
import {
  type Sample,
  push,
  tokensPerSecond,
} from "../../kernel/domain/rates.ts";
import {
  type Entry,
  SessionRecord,
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
  type ConsoleView,
  PaneLines,
  emptyPool,
  errorFrame,
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
import { Toggles } from "../policy/toggles.ts";
import { QueueView } from "../../views/queue.ts";
import { type Command, writeCommand } from "../../runtime/adapters/command.ts";
import { ExclusiveLock } from "../../kernel/domain/exclusive-lock.ts";
import { Paced } from "../../kernel/adapters/paced.ts";
import { exists } from "../../kernel/adapters/files.ts";
import { Runtime } from "../../runtime/adapters/runtime.ts";

export const TICK_MS = 1000;

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
  private readonly reading = new ExclusiveLock<fs.FileHandle | undefined>(
    undefined,
  );

  constructor(filePath: string) {
    this.path = filePath;
  }

  close(): Promise<void> {
    return this.reading.acquire(async ([handle, set]) => {
      if (handle) {
        await handle.close();
        set(undefined);
      }
    });
  }

  read(): Promise<Entry[]> {
    return this.reading.acquire(async ([handle, set]) => {
      let current = handle;
      const stats = await fs.stat(this.path).catch((err: unknown) => {
        if (!hasCode(err, "ENOENT")) {
          throw err;
        }
      });

      if (current && stats?.ino !== this.ino) {
        await current.close();
        current = undefined;
        set(undefined);
      }
      if (!stats) {
        return this.entries;
      }
      if (stats.ino !== this.ino || stats.size < this.offset) {
        this.rewind(stats.ino);
      }
      if (this.offset === stats.size) {
        return this.entries;
      }

      current ??= await fs.open(this.path, "r");
      set(current);

      while (this.offset < stats.size) {
        const buffer = Buffer.allocUnsafe(
          Math.min(READ_CHUNK, stats.size - this.offset),
        );
        const { bytesRead } = await current.read(
          buffer,
          0,
          buffer.length,
          this.offset,
        );
        if (bytesRead === 0) {
          break;
        }
        this.offset += bytesRead;
        const text =
          this.pending +
          this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        const lines = text.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") {
            continue;
          }
          const record = parse(
            SessionRecord,
            JSON.parse(line),
            "session record",
            this.path,
          );
          const result = recordEntries(record);
          appendEntries(this.entries, result);
          if (result.usage) {
            push(this.samples, {
              timestampMs: stamp(record),
              tokens: result.usage.output,
            });
          }
        }
      }
      return this.entries;
    });
  }

  private rewind(ino: number): void {
    this.ino = ino;
    this.offset = 0;
    this.pending = "";
    this.decoder = new TextDecoder();
    this.entries.length = 0;
    this.samples.length = 0;
  }
}

export class Sessions {
  private readonly tails = new Map<string, SessionTail>();
  private readonly wrapped = new Map<string, PaneLines>();

  entries(sessionPath?: string): Awaitable<Entry[]> {
    if (!sessionPath) {
      return [];
    }
    return this.tail(sessionPath).read();
  }

  lines(width: number, sessionPath?: string): Line[] {
    if (!sessionPath) {
      return [];
    }
    const existing = this.wrapped.get(sessionPath);
    if (existing) {
      return existing.update(this.tail(sessionPath).entries, width);
    }
    const cache: PaneLines = new PaneLines();
    this.wrapped.set(sessionPath, cache);
    return cache.update(this.tail(sessionPath).entries, width);
  }

  rate(nowMs: number, sessionPath?: string): number | undefined {
    if (!sessionPath) {
      return undefined;
    }
    const tail = this.tails.get(sessionPath);
    if (!tail) {
      return undefined;
    }
    return tokensPerSecond(tail.samples, nowMs);
  }

  async keep(sessionPaths: Set<string>): Promise<void> {
    for (const [sessionPath, tail] of [...this.tails]) {
      if (!sessionPaths.has(sessionPath)) {
        this.tails.delete(sessionPath);
        this.wrapped.delete(sessionPath);
        await tail.close();
      }
    }
  }

  private tail(sessionPath: string): SessionTail {
    const existing = this.tails.get(sessionPath);
    if (existing) {
      return existing;
    }
    const tail: SessionTail = new SessionTail(sessionPath);
    this.tails.set(sessionPath, tail);
    return tail;
  }
}

async function readEnvelope<T>(
  schema: z.ZodType<T>,
  filePath: string,
  what: ViewName,
): Promise<T> {
  return parse(
    schema,
    JSON.parse(await fs.readFile(filePath, "utf-8")),
    `${what} view`,
    filePath,
  );
}

export async function readView(runtime: Runtime): Promise<ConsoleView> {
  if (!(await exists(runtime.slotsView))) {
    throw new Error(`console: no server state at ${runtime.root}`);
  }

  const slots = await readEnvelope(SlotsView, runtime.slotsView, "slots");
  const queue = await readEnvelope(QueueView, runtime.queueView, "queue");

  return {
    agentsFile: slots.agents_file,
    slots: slots.slots,
    tasks: (await readEnvelope(TasksView, runtime.tasksView, "tasks")).tasks,
    checks: (await readEnvelope(ChecksView, runtime.checksView, "checks"))
      .checks,
    queue: queue.queue,
    scheduling: queue.scheduling,
  };
}

export async function frame(
  runtime: Runtime,
  sessions: Sessions,
  toggles: Toggles,
  layout: Layout,
  collapsed = false,
): Promise<Frame> {
  const view = toggles.apply(await readView(runtime));
  const all = panes(view);
  const running = all.filter((pane) => pane.slot.enabled);
  const shown = collapsed && running.length > 0 ? running : all;
  const cells = await Promise.all(
    shown.map(async (pane) => {
      const session = pane.slot.session;
      await sessions.entries(session);
      return {
        pane,
        rate: sessions.rate(layout.nowMs, session),
        lines: (width: number) => sessions.lines(width, session),
      };
    }),
  );

  await sessions.keep(
    new Set(
      all
        .map((pane) => pane.slot.session)
        .filter((session): session is string => Boolean(session)),
    ),
  );

  const queue = queueHeader(view, layout.columns);
  const hidden = all.length - shown.length;
  const rendered =
    all.length === 0
      ? emptyPool(queue.line, layout, view.agentsFile)
      : screen(cells, queue.line, layout, hidden);
  return { ...rendered, hits: [...queue.hits, ...rendered.hits] };
}

export async function frameOrError(
  runtime: Runtime,
  sessions: Sessions,
  toggles: Toggles,
  layout: Layout,
  collapsed = false,
): Promise<Frame> {
  try {
    return await frame(runtime, sessions, toggles, layout, collapsed);
  } catch (err) {
    return errorFrame(messageOf(err), layout);
  }
}

export async function main(repo: string): Promise<void> {
  const runtime: Runtime = await Runtime.open(repo);
  if (!(await exists(runtime.slotsView))) {
    throw new Error(`console: no server state at ${runtime.root}`);
  }
  if (!process.stdout.isTTY) {
    throw new Error("console: stdout is not a tty");
  }

  const sessions: Sessions = new Sessions();
  const toggles: Toggles = new Toggles();
  const scroll: Scroll = { bases: undefined, offsets: [] };
  let hits: Hit[] = [];
  let bottoms: number[] = [];
  let news: Region | undefined = undefined;
  let collapsed = false;
  const outbox: Command[] = [];
  const paced: Paced = new Paced(TICK_MS);
  const schedule = () => {
    paced.schedule();
  };

  const restore = () => {
    paced.stop();
    process.stdout.write(ALT_SCREEN_OFF);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };

  const draw = async () => {
    const columns = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const layout: Layout = { columns, rows, nowMs: Date.now(), scroll };
    const result: Frame = await frameOrError(
      runtime,
      sessions,
      toggles,
      layout,
      collapsed,
    );
    bottoms = result.bases;
    hits = result.hits;
    news = result.news;
    process.stdout.write(
      `\x1b[H${result.lines.map((line) => `${line}\x1b[K`).join("\r\n")}`,
    );
  };

  const quit = () => {
    restore();
    process.exit(0);
  };

  process.stdout.write(ALT_SCREEN_ON);
  process.stdout.on("resize", schedule);

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
            if (!event) {
              continue;
            }
            if (event.button === 64) {
              back(3);
            } else if (event.button === 65) {
              forward(3);
            } else if (event.button === 0 && event.pressed) {
              if (news && within(news, event)) {
                scrollBottom(scroll);
                break;
              }
              const command = hitAt(hits, event);
              if (!command) {
                continue;
              }
              if (command.command === "hide_disabled") {
                collapsed = true;
                scroll.bases = undefined;
                break;
              }
              if (command.command === "show_disabled") {
                collapsed = false;
                scroll.bases = undefined;
                break;
              }
              toggles.push(command);
              outbox.push(command);
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

  try {
    await paced.run(async () => {
      for (const command of outbox.splice(0)) {
        await writeCommand(runtime, command);
      }
      await draw();
    });
  } finally {
    restore();
  }
}
