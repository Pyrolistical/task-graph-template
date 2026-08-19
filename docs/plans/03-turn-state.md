# 3 · `TurnState`, out of the JSONL parser

`agents/domain/protocol.ts` holds two things wearing one coat: the rules of a turn — what `starting` clears, what a tool call does to `activity`, what counts as looping, when `settled()` resolves — and the parsing of pi's JSONL. The inline loop needs the first and none of the second. Split them, with pi still the only caller.

**Needs first:** nothing. This is a refactor with no behaviour change, and it lands green on its own.

## The split

```text
agents/domain/turn.ts       TurnState      the state machine, no transport
agents/domain/protocol.ts   PiStream       the JSONL, feeding a TurnState
```

`TurnState` owns `StreamState` and every mutation of it, as methods named for what happened rather than for the record that carried the news:

| Method                                              | Does                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `starting()`                                        | clears `settled`, `stopReason`, `errorMessage`, `looping` and the repeat counter; `activity` becomes `thinking`                   |
| `toolStarted(name, args)`                           | `activity = toolCall(...)`, counts the repeat, raises `onResult` for a [result tool](../../orchestrator/agents/domain/results.ts) |
| `toolEnded()`                                       | `activity` back to `thinking`                                                                                                     |
| `compacting(reason)`                                | `activity = compacting`, raises `onCompaction`                                                                                    |
| `retrying(attempt, max)`                            | `retrying = true`, `activity` the retry row                                                                                       |
| `retried()`                                         | `retrying = false`                                                                                                                |
| `assistantMessage(usage, stopReason, errorMessage)` | raises `onUsage` for an output count, records the stop reason                                                                     |
| `settle()`                                          | `settled = true`, `activity = none`, resolves every `settled()` waiter                                                            |
| `fail(reason)`                                      | records `failure` and releases every waiter                                                                                       |
| `settled()`                                         | resolves now if settled, otherwise on the next `settle()` or `fail()`                                                             |
| `state`                                             | the `StreamState` everything reads                                                                                                |

`LOOP_LIMIT`, the repeat signature and `toolTarget` move with it. `STOP_REASONS`, `StopReason` and `StreamState` move to `turn.ts` and are re-exported from `protocol.ts` for one commit or updated at every import — pick the second, there are few.

`PiStream` keeps `JsonlSplitter`, every zod envelope, `expect`/`reject` and the request/response map, holds a `TurnState`, and its `apply()` becomes a switch that translates one record into one call above. `feed()` still returns the records it parsed.

## Rules

- `turn.ts` imports `views/activity.ts`, `kernel/domain/rates.ts`, `kernel/domain/awaitable.ts` and `agents/domain/results.ts`, and **nothing that names a wire**: no zod envelope, no `PiRecord`, no line splitting. `architecture.test.ts` already fails on a layer violation; this rule is on top of it and belongs in a test of its own
- `state` stays one mutable object handed out by reference, because the pool publishes views straight off it. Do not make it a copy on read
- the failure path is unchanged: `fail()` releases settle waiters _and_ rejects pending requests, and only `PiStream` knows the second half exists
- no behaviour changes. Every existing assertion in `protocol.test.ts` passes untouched or moves verbatim into `turn.test.ts`

## The change

| File                            | Layer  | Change                                                        |
| ------------------------------- | ------ | ------------------------------------------------------------- |
| `agents/domain/turn.ts`         | domain | new: `TurnState`, `StreamState`, `STOP_REASONS`, `LOOP_LIMIT` |
| `agents/domain/turn.test.ts`    | domain | new: the state machine driven directly                        |
| `agents/domain/protocol.ts`     | domain | `PiStream` delegates; envelopes and splitter stay             |
| every importer of `StreamState` | —      | import from `turn.ts`                                         |
| `docs/import-graph.md`          | doc    | regenerate                                                    |

## Tests

`turn.test.ts` drives the machine with no JSON anywhere:

- `starting()` clears a stop reason and an error message from the turn before
- ten identical tool calls set `looping` to that call's target; nine do not; a different call in between resets the count
- a tool call sets the activity, a tool end returns it to thinking
- an assistant message with an output count raises exactly one usage sample
- a result tool raises `onResult` once, with the tool's name and its arguments
- `settled()` resolves on `settle()`, and resolves immediately when called after it
- `fail()` releases a pending `settled()` waiter

`protocol.test.ts` keeps its JSONL cases: a split record across two chunks, a `\r\n` line, an unparseable line skipped, a response matched to its id.

## Done when

`bun test`, `bun run typecheck` and `bun run bdd` are green with no behaviour test edited, and `turn.ts` names no transport.

## Not this plan

Anything calling `TurnState` other than `PiStream`. The inline loop is [plan 7](07-the-inline-run.md).
