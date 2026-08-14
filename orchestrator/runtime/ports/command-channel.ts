import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { Command } from "../domain/command.ts";

export interface CommandChannel {
  take(): Awaitable<Command | undefined>;
  watch(
    apply: (command: Command) => Awaitable<void>,
    onError: (err: unknown) => Awaitable<void>,
  ): { close(): void };
}
