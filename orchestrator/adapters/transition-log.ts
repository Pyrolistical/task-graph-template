import fs from "node:fs/promises";
import { parse } from "../domain/schema.ts";
import { TransitionEntry, type Transitions } from "../app/ports/transitions.ts";
import { Appendable } from "./appendable.ts";

export const TRANSITION_LOG_LINES = 1000;

export type { TransitionEntry };

export class TransitionLog implements Transitions {
  private readonly file: Appendable;
  private lines: string[] = [];
  private seq = 0;

  private constructor(
    private readonly filePath: string,
    private readonly cap: number,
  ) {
    this.file = new Appendable(filePath);
  }

  static async open(
    filePath: string,
    cap = TRANSITION_LOG_LINES,
  ): Promise<TransitionLog> {
    const log = new TransitionLog(filePath, cap);
    await log.file.use(async (handle) => {
      log.lines = (await readLines(handle)).slice(-cap);
      const last = log.lines[log.lines.length - 1];
      log.seq = last === undefined ? 0 : entryOf(last, filePath).seq;
    });
    return log;
  }

  get cursor(): number {
    return this.seq;
  }

  append(entry: Omit<TransitionEntry, "seq" | "at">): Promise<TransitionEntry> {
    return this.file.use(async (handle) => {
      const line: TransitionEntry = {
        seq: ++this.seq,
        at: new Date().toISOString(),
        ...entry,
      };
      const text = JSON.stringify(line);
      this.lines.push(text);

      if (this.lines.length > this.cap) {
        this.lines = this.lines.slice(-this.cap);
        await handle.truncate(0);
        await handle.appendFile(`${this.lines.join("\n")}\n`, "utf-8");
      } else {
        await handle.appendFile(`${text}\n`, "utf-8");
      }

      return line;
    });
  }

  read(): Promise<TransitionEntry[]> {
    return this.file.use(async (handle) =>
      (await readLines(handle)).map((line) => entryOf(line, this.filePath)),
    );
  }

  close(): Promise<void> {
    return this.file.close();
  }
}

function entryOf(line: string, filePath: string): TransitionEntry {
  return parse(TransitionEntry, JSON.parse(line), "transition", filePath);
}

async function readLines(handle: fs.FileHandle): Promise<string[]> {
  const { size } = await handle.stat();
  const contents = Buffer.alloc(size);
  if (size > 0) {
    await handle.read(contents, 0, size, 0);
  }
  return contents
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}
