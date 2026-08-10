import type { Awaitable } from "../../domain/awaitable.ts";
import type { Command } from "../../domain/command.ts";

export interface CommandChannel {
  take(): Awaitable<Command | null>;
  watch(
    apply: (command: Command) => Awaitable<void>,
    onError: (err: unknown) => Awaitable<void>,
  ): { close(): void };
}
