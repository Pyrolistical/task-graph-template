import { watch } from "node:fs";
import fs from "node:fs/promises";
import type { CommandChannel } from "../app/ports/command-channel.ts";
import type { Awaitable } from "../domain/awaitable.ts";
import { Command } from "../domain/command.ts";
import { hasCode, uncaught } from "../domain/errors.ts";
import { exists, writeAtomic } from "./files.ts";
import type { Runtime } from "./runtime.ts";

export type { Command };

const SETTLE_MS = 10;

export async function writeCommand(
  runtime: { consoleCommand: string },
  command: Command,
): Promise<boolean> {
  if (await exists(runtime.consoleCommand)) {
    return false;
  }
  await writeAtomic(
    runtime.consoleCommand,
    `${JSON.stringify(command, null, 2)}\n`,
  );
  return true;
}

function parseCommand(raw: string): Command | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = Command.safeParse(value);
  return result.success ? result.data : null;
}

export async function takeCommand(runtime: {
  consoleCommand: string;
}): Promise<Command | null> {
  let raw: string;
  try {
    raw = await fs.readFile(runtime.consoleCommand, "utf-8");
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
  await fs.rm(runtime.consoleCommand);
  return parseCommand(raw);
}

export function watchCommands(
  runtime: { root: string; consoleCommand: string },
  apply: (command: Command) => Awaitable<void>,
  onError: (err: unknown) => Awaitable<void>,
): { close(): void } {
  let closed = false;

  const takeAll = async (): Promise<void> => {
    for (;;) {
      if (closed) {
        return;
      }
      const command = await takeCommand(runtime);
      if (command === null) {
        return;
      }
      await apply(command);
    }
  };

  const drain = async (): Promise<void> => {
    await takeAll();
    // WORKAROUND for https://github.com/oven-sh/bun/issues/36328
    await Bun.sleep(SETTLE_MS);
    await takeAll();
  };

  const report = (work: Promise<void>): Promise<void> =>
    work.catch((err: unknown) => onError(err)).catch(uncaught);

  let draining: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    draining = report(draining.then(drain));
  };

  const watcher = watch(runtime.root, schedule);
  watcher.on("error", (err) => {
    void report(Promise.reject(err));
  });
  watcher.unref();

  return {
    close(): void {
      closed = true;
      watcher.close();
    },
  };
}

export class CommandFile implements CommandChannel {
  constructor(private readonly runtime: Runtime) {}

  take(): Promise<Command | null> {
    return takeCommand(this.runtime);
  }

  watch(
    apply: (command: Command) => Awaitable<void>,
    onError: (err: unknown) => Awaitable<void>,
  ): { close(): void } {
    return watchCommands(this.runtime, apply, onError);
  }
}
