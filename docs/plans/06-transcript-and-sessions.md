# 6 · the transcript, and the session it is written to

What a turn holds in memory, what it leaves on disk, and the one rule that keeps a pi session from being handed to an inline slot.

**Needs first:** nothing. The domain and the file format stand alone; the scheduler change is small and lands with them.

## The transcript

`agents/domain/transcript.ts`, pure:

```text
Message   = { role: "user" | "assistant", content: Part[] }
Part      = { kind: "text", text }
          | { kind: "thinking", text }
          | { kind: "toolCall", id, name, args }
          | { kind: "toolResult", id, ok, content }
```

A `Transcript` is a list of `Message` plus the operations the loop needs: append a user message, append the assistant message a response produced, append the results of a batch of tool calls, and read the whole thing back as the request's `messages`. It holds no I/O and no clock.

A tool result is a message of its own in the `user` role, carrying one `toolResult` part per call in the batch, in call order. Both apis want that shape and the loop should not be the thing that knows it.

## The session file

One JSONL per task and role in `sessionDir`, the path `newSession` returns and `workspace.session` records, exactly where a pi session goes and named the same way.

- **the first record is a header**: `{ "kind": "session", "agent": "inline", "id": "sonnet", "model": "…", "started_at": "…" }`. A session belongs to the agent type that wrote it, and the header is how anything asks
- **one record per message** after it, in the shape the console's [session reader](../console.md#the-transcript) already folds: a role, its parts, and a timestamp
- appended and flushed as each message completes, never rewritten. The console tails this file by byte offset, so a rewrite would reset every reader
- `switchSession` reads it back into a `Transcript`; a record that does not parse ends the read with an error naming the line, because half a transcript resumed silently is worse than a dispatch that rolls back

The console must fold an inline record into the same `Entry` a pi record folds into. Check `console/domain/session.ts` against the shape above and adjust whichever end is cheaper — but the console must not learn a second format, and if it needs a branch, that branch is one function.

## Whose session is it

`hasSession(path)` today is "does the file exist". It becomes "does the file exist **and** does its header name an agent this `Agents` can read". Then:

- an inline `Agents` answers false for a pi session and vice versa
- a [resume candidate](../sessions.md) carries the type its session belongs to, the way it already carries a role, and `pickSlot` filters on it alongside `roles`
- a candidate whose session no slot of that type can take is dispatched **fresh**, not held: the phase rules in [Sessions](../sessions.md) decide what resumes, and a missing session is a case they already handle

Skip the pairing and the failure is not silent but it is ugly: `switchSession` throws, the dispatch is logged and rolled back, and the task goes round again into whichever slot wins next. Do the pairing.

Everything [Sessions](../sessions.md) says about which turns resume and which start fresh is a rule about phases, not about pi, and holds unchanged.

## The change

| File                               | Layer    | Is                                                   |
| ---------------------------------- | -------- | ---------------------------------------------------- |
| `agents/domain/transcript.ts`      | domain   | `Message`, `Part`, `Transcript`, the record schema   |
| `agents/domain/transcript.test.ts` | domain   | the operations                                       |
| `agents/adapters/session-file.ts`  | adapters | append, read back, the header                        |
| `agents/policy/scheduler.ts`       | policy   | candidates carry a session type; `pickSlot` filters  |
| `agents/ports/agents.ts`           | ports    | `hasSession` unchanged in shape, stronger in meaning |
| `console/domain/session.ts`        | domain   | fold an inline record, if it does not already        |
| `docs/sessions.md`                 | doc      | a session belongs to a type                          |

## Tests

`transcript.test.ts`: appending a user message; an assistant message with text and two tool calls; a batch of results appended in call order as one message; round-tripping to records and back.

`agents/adapters/session-file.test.ts`, real temp directory: a new session writes a header first; three messages append three records; reading it back yields an equal transcript; a truncated last line fails the read with the line number; a file whose header names `pi` is refused by an inline reader.

`scheduler.test.ts`: a resume candidate whose session is a pi session is not offered to an inline slot; the same candidate is offered to a pi slot; with no slot of its type free it waits rather than being dispatched into the wrong one; a fresh candidate is offered to either.

`console/domain/session.test.ts`: an inline record folds to the same `Entry` as the pi record for the same message.

## Done when

`bun test` and `bun run typecheck` are green, `bun run bdd` regenerated, and a pi session written by the fake `pi` still reads back through `hasSession` as before.

## Not this plan

Writing to the session from a live turn — that is the loop, [plan 7](07-the-inline-run.md). This plan ships the format and the reader, and pi keeps using neither.
