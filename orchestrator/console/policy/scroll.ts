import type { Line } from "../domain/text.ts";

export const QUEUE_LINES = 2;
export const HEADER_LINES = 4;

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
