import type { Command } from "../domain/command.ts";
import type { Hit, Local, Region } from "./console.ts";

export function keys(chunk: string): string[] {
  const found: string[] = [];
  let at = 0;

  while (at < chunk.length) {
    const rest = chunk.slice(at);
    const sequence =
      rest.match(/^\x1b\[<\d+;\d+;\d+[mM]/) ??
      rest.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    if (sequence === null) {
      found.push(rest[0]);
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
    button: parseInt(match[1], 10),
    column: parseInt(match[2], 10) - 1,
    row: parseInt(match[3], 10) - 1,
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

export function hitAt(hits: Hit[], event: Mouse): Command | Local | null {
  const hit = hits.find((candidate) => within(candidate, event));
  return hit === undefined ? null : hit.command;
}
