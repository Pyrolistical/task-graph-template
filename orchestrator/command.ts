import fs from "node:fs";
import { z } from "zod";
import { type Runtime, writeAtomic } from "./runtime.ts";

const Command = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("scheduler"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    command: z.literal("agent"),
    agent: z.string().min(1),
    enabled: z.boolean(),
  }),
]);

export type Command = z.infer<typeof Command>;

export function writeCommand(runtime: Runtime, command: Command): boolean {
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
  const result = Command.safeParse(value);
  return result.success ? result.data : null;
}

export function takeCommand(runtime: Runtime): Command | null {
  if (!fs.existsSync(runtime.consoleCommand)) {
    return null;
  }
  const raw = fs.readFileSync(runtime.consoleCommand, "utf-8");
  fs.rmSync(runtime.consoleCommand);
  return parseCommand(raw);
}

export function watchCommands(
  runtime: Runtime,
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
