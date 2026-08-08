import type { Command } from "../../domain/command.ts";

export interface CommandChannel {
  take(): Command | null;
  watch(apply: (command: Command) => void): { close(): void };
}
