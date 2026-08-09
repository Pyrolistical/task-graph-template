export const DIM = "2";
export const RED = "31";
export const GREEN = "32";
export const REVERSE = "7";
export const ELLIPSIS = "…";

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
    const split = rest[0];
    let room = "";
    if (used + head < width && split !== undefined) {
      room = " ".repeat(used + head + charWidth(split) - width);
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

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
