import type { Command } from "../../runtime/domain/command.ts";

export type Local = { command: "hide_disabled" } | { command: "show_disabled" };

export interface Region {
  row: number;
  from: number;
  to: number;
}

export interface Hit extends Region {
  command: Command | Local;
}
