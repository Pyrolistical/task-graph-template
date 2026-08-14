import type { Awaitable } from "../../kernel/domain/awaitable.ts";
import type { FragmentVars } from "../domain/fragment.ts";
import type { IssueName } from "../domain/issues.ts";
import type { ClaimState } from "../../vocabulary/state-machine.ts";

export interface Prompts {
  fragment(name: string, vars?: FragmentVars): string;
  issue(name: IssueName, state: ClaimState, vars?: FragmentVars): string;
  reload(): Awaitable<string[]>;
  cachedFiles(): string[];
}
