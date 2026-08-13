# Agents

`agents.json` declares the pool: a model on a provider, how many slots, whether it runs, whether its provider is asked if it is up first, what it may write outside its worktree, which roles it may take.

```json
{
  "agents": [
    {
      "type": "pi",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "slots": 3
    },
    {
      "type": "pi",
      "provider": "llama.cpp-rocm",
      "model": "rocm",
      "slots": 1,
      "roles": ["worker"],
      "enabled": false,
      "healthCheck": true,
      "wattage": 300,
      "costPerKwh": 0.19,
      "write": ["~/.cache", "~/.cargo"]
    }
  ]
}
```

- read from the [task directory](task-document.md), never the orchestrator checkout, so one orchestrator drives several projects with different pools
- slot names are derived, `type-provider-model-index`, and land in `claimed_by`, so a claim says which model on which provider holds the task
- rejected **on load**, not at spawn: a config that would fail on the tenth dispatch should fail on startup
- an empty pool still loads, so tasks can be authored and queued; [starting the scheduler is refused](scheduler.md#dispatch-order)

## roles

Defaults to all four; the only knob on what a slot may be handed. The task's state decides the role needed and a slot lacking it is skipped, so a pool can say the cheap local model only works and the expensive one only reviews. Restricting does not promise capacity: a worker-only pool leaves planners and reviewers waiting, visible as queued work beside idle slots.

## write

The only knob on the [sandbox](sandbox.md). Declaring it **replaces** the default `["~/.cache"]`: rust needs `["~/.cache", "~/.cargo", "~/.rustup"]`, nothing-but-the-worktree is `[]`. `~` is the server user's home, relative paths resolve against the launch directory, nonexistent paths are dropped because `bwrap` cannot overlay what is not there, and resolution happens at spawn so a cache created after startup is picked up.

## wattage and costPerKwh

What a session on this agent costs when the provider prices nothing. Both default to zero, and zero is the honest answer for a hosted model: pi already reports what the tokens cost, and a meter on top would bill the same work twice.

- a local model bills no tokens, so `wattage` × how long the session ran × `costPerKwh` is the whole cost of running it; declare the box's draw under load and what the wall socket charges
- used only where pi reports nothing: a session pi prices is taken at its word, since that price already spans every turn the session took
- the same number the console draws is the one written to [`costs`](task-document.md#what-a-task-cost), so what a slot showed while it ran is what the task ends up carrying

## healthCheck

For the local inference server that is not always running. Off, the slot is dispatched and the outage is discovered by the agent failing. On, the provider is asked before the slot leaves the free list; a provider that does not answer has its slots pulled for that tick and reads `UNREACHABLE`, so the console says why the queue is not moving instead of showing capacity that takes nothing.

- base url and api come from pi's own `ModelRuntime`, opened at startup over the same `models.json` agents are spawned against — no second copy of the endpoint
- the request is that api's model list, authenticated with the credential pi would stream with; an api with no model list is refused by name rather than guessed at
- down = anything but 2xx, a refused connection, or 5s of silence
- one request per provider per scheduling tick, not per slot, and only for otherwise-free enabled slots
- gates dispatch only: a hosted provider wants this off, since a hosted outage is the backoff's job

## enabled

A property of the agent, not a slot: there is no case where slot 2 should be dispatchable while slot 1 is not. False in the file starts it parked; `disable_agent`/`enable_agent` and the console toggle at runtime, keyed by `type-provider-model`, and are never written back to the file — the file is the declared pool, and a restart is when you want it back.

Disabling never interrupts work: a slot mid-task keeps it, settles it, runs its checks, and is not offered again. `enabled` goes false on every row at once while `state` still reads `BUSY`, becoming `DISABLED` on release, because draining and already-idle are different situations.

## Aborting one tool call

`slot_abort` targets one slot by full name — the only case where a slot, not an agent, is the unit. Refused unless that process is inside a `bash` call: `bash` is the only tool that runs long enough to be stuck, and it kills the command, not the turn. The tool result comes back as an error and **the agent reacts** — a failed tool call is something it already knows how to read, and ending the turn would throw away the context that produced it. Session, claim and slot are untouched. Anything worse is `looping` or a held state.

## Compaction

`compaction_start` means context overflowed: the agent loses the middle of its transcript and continues from a summary. Every role but `worker` has its worktree reset to the dispatched commit first — those roles change nothing, so anything present is a scribble the `untouched` guard would only catch a whole turn later. Then the dispatch fragment is re-sent as a steering message, joining the turn in flight; it is one line pointing at `../ASSIGNMENT.md`, the one part of the assignment compaction cannot eat.

## The agent state machine

```text
IDLE → SPAWNING → BUSY ⇄ WAITING → SETTLED → IDLE
IDLE ⇄ DISABLED (its agent)   IDLE ⇄ UNREACHABLE (its provider)
BUSY → ABORTING → SETTLED (shutdown)   BUSY → IDLE (process died unsettled)
SETTLED → BUSY (correct, nudge, resume in situ)
```

- `UNREACHABLE` = `IDLE` + failed health check: holds nothing, still enabled, not offered. `WAITING` is the same shortage from the other side — a slot already holding a task that cannot reach its provider
- a `WAITING` slot is **not free**: outage backpressure must show as reduced capacity, not a queue of dispatches into a wall
- `DISABLED` is entered only from `IDLE`, which makes disabling safe at any moment
- `BUSY → IDLE` is `pi` dying without settling (OOM, segfault): the stream fails when stdout closes, the worker stops rather than prompting a corpse, the slot is released, the reaper releases the claim next tick

## When the provider is down

`pi` retries inside a turn itself. The server handles it giving up (`stopReason: error`) and a local server not answering:

| Condition                        | Server                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| connection refused, timeout, 5xx | re-`prompt` the same session after 1s, 2s, 4s … capped at 64s |
| `503` with a model-loading body  | re-`prompt` every 5s, indefinitely, counting no attempt       |
| any success                      | backoff resets                                                |

Refused is a broken provider and every retry costs something, so exponential decay recovering within a minute of it returning; 503-while-loading is a working provider (a large model on a cold box takes minutes to map weights), so wait. Neither exhausts: the failure is not the task's fault, and dropping the assignment would lose a live worktree and session over something that resolves itself. The slot sits in `WAITING` with the reason and next retry in its view row, so halved capacity is visible.

Nothing bounds retries of a task and nothing needs to: a bouncing task shows as repeated `fail`/`feedback` on one id in the transition log, and a review rejected twice holds.
