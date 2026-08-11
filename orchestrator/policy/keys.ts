import type { Command } from "../domain/command.ts";
import { groupOf } from "../domain/pattern.ts";
import type { Hit, Local, Region } from "./console.ts";

export function keys(chunk: string): string[] {
  const found: string[] = [];
  let at = 0;

  while (at < chunk.length) {
    const rest = chunk.slice(at);
    const sequence =
      rest.match(/^\x1b\[<\d+;\d+;\d+[mM]/) ??
      rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    const key = sequence?.[0] ?? rest.slice(0, 1);
    found.push(key);
    at += key.length;
  }

  return found;
}

export interface Mouse {
  button: number;
  column: number;
  row: number;
  pressed: boolean;
}

export function mouse(key: string): Mouse | undefined {
  const match = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
  if (!match) {
    return undefined;
  }
  return {
    button: parseInt(groupOf(match, 1), 10),
    column: parseInt(groupOf(match, 2), 10) - 1,
    row: parseInt(groupOf(match, 3), 10) - 1,
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

export function hitAt(hits: Hit[], event: Mouse): Command | Local | undefined {
  const hit = hits.find((candidate) => within(candidate, event));
  return hit?.command;
}
