import fs from "node:fs";
import { parse } from "../domain/schema.ts";
import { TransitionEntry, type Transitions } from "../app/ports/transitions.ts";

export const TRANSITION_LOG_LINES = 1000;

export type { TransitionEntry };

export class TransitionLog implements Transitions {
  private readonly filePath: string;
  private readonly cap: number;
  private lines: string[];
  private seq: number;

  constructor(filePath: string, cap = TRANSITION_LOG_LINES) {
    this.filePath = filePath;
    this.cap = cap;
    this.lines = readLines(filePath).slice(-cap);
    const last = this.lines[this.lines.length - 1];
    this.seq = last === undefined ? 0 : entryOf(last, filePath).seq;
  }

  get cursor(): number {
    return this.seq;
  }

  append(entry: Omit<TransitionEntry, "seq" | "at">): TransitionEntry {
    const line: TransitionEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      ...entry,
    };
    const text = JSON.stringify(line);
    this.lines.push(text);

    if (this.lines.length > this.cap) {
      this.lines = this.lines.slice(-this.cap);
      fs.writeFileSync(this.filePath, `${this.lines.join("\n")}\n`, "utf-8");
    } else {
      fs.appendFileSync(this.filePath, `${text}\n`, "utf-8");
    }

    return line;
  }

  read(): TransitionEntry[] {
    return readLines(this.filePath).map((line) => entryOf(line, this.filePath));
  }
}

function entryOf(line: string, filePath: string): TransitionEntry {
  return parse(TransitionEntry, JSON.parse(line), "transition", filePath);
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}
