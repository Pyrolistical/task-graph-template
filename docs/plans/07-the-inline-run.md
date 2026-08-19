# 7 · the run, the router, and `compose.ts`

The plan that makes `type: "inline"` actually take a task. Everything before it shipped a piece nothing called; this one assembles them behind `agents/ports/agents.ts` and changes not one word above that port.

**Needs first:** plans [1](01-inline-agent-entry.md), [3](03-turn-state.md), [4](04-the-models-port.md), [5](05-the-inline-tools.md) and [6](06-transcript-and-sessions.md).

## The loop

```text
prompt(message)
  └─ turn.starting()
     └─ iterate:
        compact if over the threshold
        models.send(request) ── usage ─▶ turn.assistantMessage
        ├─ no tool calls            → turn.settle(), done
        └─ tool calls
           turn.toolStarted(name, args)
           execute                        result tools raise onResult
           turn.toolEnded()
           append results, repeat         terminate ⇒ turn.settle(), done
```

Turn end is a value the loop produces rather than an event it waits for, so `stream.settled()` resolves where the loop returns. `stopReason` keeps the five names it has, because [settle](../settle.md) reads them.

`InlineRun implements AgentProcess`, and the table in [the design](../inline-agent.md#what-does-not-move) is its specification:

- **`pid`** the server's own, `process.pid`
- **`alive`** the run is not finished
- **`stream`** `{ state, settled() }` off the `TurnState`
- **`newSession`** create the file with its header, return the path
- **`switchSession`** read it into the transcript
- **`prompt`** append a user message and start the loop; **`steer`** append one and let the loop pick it up at the top of its next iteration. Nothing joins a request already in flight — pi's `steer` is the same thing with a hop in it
- **`abort`** cancel the request signal, kill the running tool's sandbox, settle with `aborted`
- **`stats`** counters the loop already keeps: tokens summed, cost from `costPerMtok*` when the row carries them, `contextPercent` as tokens over the row's `contextWindow`
- **`close`** end the run cleanly; **`kill`** abandon it and kill whatever `bash` child it holds

### `kill()` must never reach `process.kill`

`Pool.stopSlot` kills when `alive(pid)` answers true, and an inline run reports the server's pid, so the naive path stops the server. `kill()` on an `InlineRun` aborts the run and its `bash` child and returns. **Pin it with a test that stops an inline run mid-`bash` and asserts the server is still ticking**, because this is the one place the process metaphor leaks and a regression here is fatal rather than wrong.

### reattach is refused by type

A restarting server reattaches to slots whose `claimed_pid` is alive. An inline row is skipped **on its type**, whatever `alive(pid)` says: a recycled pid must never read as a turn still running inside a process that is gone. The claim is then reaped and the task re-queued — the existing path, which is why nothing else needs to change.

## Compaction

At the top of each iteration, over a threshold on `contextWindow`: keep the first user message and the last few exchanges, summarise the middle with the same model, raise `onCompaction`. `agents/policy/compaction.ts` decides _when_ and _what survives_ and is pure; the run does the summarising call.

The settler already turns `onCompaction` into a worktree reset for every role but `worker` and a re-steer of the dispatch fragment ([Agents](../agents.md#compaction)). That stays exactly as written.

## The router

`agents/adapters/agents-by-type.ts implements Agents`, holding one `Agents` per type and dispatching `spawn`, `unhealthy` and `hasSession` on `slot.type`. `slots()` returns the whole pool once, from the parsed file, not from either half.

A type with no implementation behind it is impossible by now — [plan 1](01-inline-agent-entry.md) made `type` an enum — but the router asserts it anyway, because the alternative is a silent `undefined` at dispatch.

`compose.ts` is the only module holding both halves, which is the shape [the slices](../architecture.md) already require. It builds `PiAgents` as it does today, builds `InlineAgents` from the pool's inline rows, and hands the router to the app. The `ModelRuntime` import stays for pi and is not used by anything inline.

## The change

| File                                | Layer    | Is                                               |
| ----------------------------------- | -------- | ------------------------------------------------ |
| `agents/adapters/inline-run.ts`     | adapters | `implements AgentProcess` — the loop             |
| `agents/adapters/inline-agents.ts`  | adapters | `implements Agents`                              |
| `agents/adapters/agents-by-type.ts` | adapters | routes on `slot.type`                            |
| `agents/policy/compaction.ts`       | policy   | when to compact, what survives                   |
| `agents/policy/compaction.test.ts`  | policy   | the thresholds                                   |
| `agents/app/pool.ts`                | app      | reattach skips inline rows by type               |
| `main/compose.ts`                   | main     | both halves, one router                          |
| `docs/agents.md`, `docs/server.md`  | doc      | the pool holds two types; inline does not detach |

## Tests

`agents/adapters/inline-run.test.ts`, against a scripted `Models` and real temp directories — no network:

- a response with no tool calls settles the turn with `stopReason: "stop"`
- a response with one tool call executes it, appends the result and asks again
- a `submit` call raises `onResult` once with its arguments and settles the turn
- ten identical tool calls set `looping`, through the same `TurnState` pi uses
- usage from every response accumulates; `stats()` reports tokens, cost and a context percent over the row's window
- a row with no `costPerMtok*` reports no cost, and the meter prices it
- `abort()` mid-request settles with `aborted` and throws nothing
- `abort()` mid-`bash` kills the child and settles
- **`kill()` mid-`bash` leaves this process alive** and the run finished
- `steer()` before the next iteration reaches the model; `steer()` during a request reaches the one after
- crossing the compaction threshold raises `onCompaction` once and keeps the first user message

`agents/adapters/agents-by-type.test.ts`: each call reaches the half matching the slot's type; a pi session is `hasSession` false for an inline slot and true for a pi one.

`agents/app/pool.test.ts`: a detached inline row is not reattached even when its recorded pid is alive.

## Done when

A pool with one inline row dispatches a task, drives it to `submit`, settles it, runs its checks and lands it — the whole pipeline, against a scripted `Models`. `bun test`, `bun run typecheck` and `bun run bdd` green. Nothing above `agents/ports/agents.ts` was edited except `compose.ts`.

## Not this plan

Running the behaviour suite against both types — [plan 8](08-inline-in-the-suite.md). Changing what the console's `[abort]` means — [plan 9](09-aborting-one-command.md).
