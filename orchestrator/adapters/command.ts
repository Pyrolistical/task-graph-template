import fs from "node:fs";
import type { CommandChannel } from "../app/ports/command-channel.ts";
import { type Command, Command as CommandSchema } from "../domain/command.ts";

export type { Command };
import { type Runtime, writeAtomic } from "./runtime.ts";

export function writeCommand(
  runtime: { consoleCommand: string },
  command: Command,
): boolean {
  if (fs.existsSync(runtime.consoleCommand)) {
    return false;
  }
  writeAtomic(runtime.consoleCommand, `${JSON.stringify(command, null, 2)}\n`);
  return true;
}

function parseCommand(raw: string): Command | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CommandSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function takeCommand(runtime: {
  consoleCommand: string;
}): Command | null {
  if (!fs.existsSync(runtime.consoleCommand)) {
    return null;
  }
  const raw = fs.readFileSync(runtime.consoleCommand, "utf-8");
  fs.rmSync(runtime.consoleCommand);
  return parseCommand(raw);
}

export function watchCommands(
  runtime: { root: string; consoleCommand: string },
  apply: (command: Command) => void,
): fs.FSWatcher {
  const watcher = fs.watch(runtime.root, () => {
    const command = takeCommand(runtime);
    if (command !== null) {
      apply(command);
    }
  });
  watcher.unref();
  return watcher;
}

export class CommandFile implements CommandChannel {
  constructor(private readonly runtime: Runtime) {}

  take(): Command | null {
    return takeCommand(this.runtime);
  }

  watch(apply: (command: Command) => void): { close(): void } {
    return watchCommands(this.runtime, apply);
  }
}
