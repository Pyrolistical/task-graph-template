# 4 · the `Models` port

One port, one method, two adapters. Everything the inline loop knows about a provider is this interface; everything a provider knows about the loop is a request and a stream of parts.

**Needs first:** [plan 1](01-inline-agent-entry.md), for `api`, `baseUrl`, `apiKeyEnv`, `model`, `contextWindow` and the token prices to exist on a `Slot`.

## The port

`agents/ports/models.ts`:

```ts
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
}

export interface Models {
  send(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`ModelEvent` is the whole vocabulary the loop reacts to, and is deliberately smaller than either wire format:

| Event                              | Carries                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `{ kind: "text", text }`           | a delta of assistant prose                                    |
| `{ kind: "thinking", text }`       | a delta of reasoning, where the api has one                   |
| `{ kind: "tool", id, name, args }` | one complete tool call, emitted only once its arguments parse |
| `{ kind: "usage", input, output }` | token counts, at least once per response                      |
| `{ kind: "end", stopReason }`      | one of the five [`StopReason`](03-turn-state.md) names        |

A tool call is buffered until whole. Both apis stream arguments as JSON fragments and a half-parsed argument bag is not something a tool may be handed; the adapter accumulates and parses, and a bag that never parses ends the response with `stopReason: "error"` and a message naming the tool.

`Message` and `ToolDefinition` live in [`agents/domain/transcript.ts`](06-transcript-and-sessions.md); if that plan has not landed, define them there anyway and let it adopt them.

## The adapters

`agents/adapters/anthropic-messages.ts` and `agents/adapters/openai-completions.ts`, each constructed from a `Slot`'s endpoint fields plus the api key read from `apiKeyEnv` **at construction**, never from the environment mid-turn.

Shared between them, in `agents/domain/sse.ts`: a chunked-`fetch`-body to server-sent-events reader — decode, split on blank lines, yield `data:` payloads, drop `[DONE]`. It is the only thing the two have in common and it is pure, so it is tested without a socket.

Per adapter, and this is the whole of the difference:

|                  | `anthropic-messages`                    | `openai-completions`                       |
| ---------------- | --------------------------------------- | ------------------------------------------ |
| path             | `/v1/messages`                          | `/chat/completions`                        |
| auth             | `x-api-key` + `anthropic-version`       | `Authorization: Bearer`                    |
| system           | its own top-level field                 | a `system` message                         |
| tools            | `input_schema`                          | `function.parameters`                      |
| tool call deltas | `input_json_delta` on a `content_block` | `tool_calls[].function.arguments`          |
| usage            | `message_start` and `message_delta`     | a final `usage` chunk, `stream_options` on |
| stop             | `end_turn`/`max_tokens`/`tool_use`      | `stop`/`length`/`tool_calls`               |

Both map their stop names onto the existing five, because [settle](../settle.md) reads them: `toolUse` when the response ended on tool calls, `length` on a token cap, `stop` otherwise, `error` for anything that arrives broken, and `aborted` only from the signal.

`baseUrl` is joined with exactly one slash however it was written, the same normalisation [`probe()`](../../orchestrator/agents/domain/health.ts) already does.

## Aborting

The signal is passed to `fetch` and the iteration ends. An aborted request yields `{ kind: "end", stopReason: "aborted" }` and throws nothing: the loop's job is to record a turn that ended, not to catch a `DOMException`. Anything else thrown out of the transport propagates and is the retry's problem.

## Retrying

Inside the adapter, wrapping the request and nothing else — a retry after a response has begun streaming would duplicate text.

- a connection refused, a timeout, or a 5xx: retry after 1s, 2s, 4s, three attempts, then yield `stopReason: "error"` with the last failure as the message. The loop raises the same retry events pi did, so the console's `retrying` row is unchanged
- a 429 with `retry-after`: honour the header, counting as one of the three
- a 4xx that is not 429: no retry, `stopReason: "error"`, message from the body. A bad key or a wrong model name is not a transient thing
- the signal cancels a pending backoff at once

The server's own [backoff](../agents.md#when-the-provider-is-down) is untouched and takes over from `stopReason: "error"`, exactly as it does for pi. Two scopes, one policy each.

## Health

`unhealthy()` for an inline slot is `probe(slot.baseUrl, slot.api, key)` and the same 5s timeout the pi path uses — the existing function, a different source for its two arguments. No new code beyond passing them.

## The change

| File                                    | Layer    | Is                                     |
| --------------------------------------- | -------- | -------------------------------------- |
| `agents/ports/models.ts`                | ports    | `Models`, `ModelRequest`, `ModelEvent` |
| `agents/domain/sse.ts`                  | domain   | bytes → events, pure                   |
| `agents/domain/sse.test.ts`             | domain   | split frames, multi-byte, `[DONE]`     |
| `agents/adapters/anthropic-messages.ts` | adapters | `implements Models`                    |
| `agents/adapters/openai-completions.ts` | adapters | `implements Models`                    |
| `agents/adapters/*.test.ts`             | adapters | over a stubbed `fetch`                 |

## Tests

`sse.test.ts`, pure: an event split across two chunks; a multi-byte character split across two chunks; `[DONE]` dropped; a comment line ignored.

Each adapter's suite, over an injected `fetch` returning a scripted body — no socket, no key, no network:

- text deltas arrive in order and concatenate
- a tool call split across four argument deltas is emitted once, whole, with parsed arguments
- arguments that never parse end the response with `stopReason: "error"` naming the tool
- usage is reported with both counts
- each of that api's stop names maps to the right `StopReason`
- an abort mid-stream yields `stopReason: "aborted"` and throws nothing
- 500, 500, then 200 yields the successful response; three 500s yield `stopReason: "error"`
- a 401 yields `stopReason: "error"` on the first try, with no second request made
- a 429 with `retry-after: 2` waits that long
- the request body carries the system prompt where that api puts it, and the tools in that api's shape

## Done when

Both adapters pass their suites, `bun run typecheck` is green, and no test in the repo opens a socket.

## Not this plan

The loop, the tools, the transcript on disk, wiring anything into `compose.ts`. This plan ships a port and two adapters nothing calls yet.
