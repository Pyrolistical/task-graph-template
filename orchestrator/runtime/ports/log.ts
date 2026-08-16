import type { Awaitable } from "../../kernel/domain/awaitable.ts";

export type Log = (line: string) => Awaitable<void>;
