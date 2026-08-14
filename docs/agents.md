# Agents

`agents.json` declares the pool: a model on a provider, how many slots, whether it runs, when it may run, whether its provider is asked if it is up first, what it may write outside its worktree, which roles it may take.

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
      "schedule": [{ "start": "22:30", "end": "06:15" }],
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

## slots

How many tasks the agent runs at once, defaulting to one. Each is a row of its own in `slots.json`, numbered from one, and the number is part of the slot's name.

### changing the count while the server runs

`set_agent_slots` and the console's `[-]` `[+]` set a count for as long as the server lives; like `enabled` it is never written back to the file, so a restart is what puts the declared pool back. The count is the unit, not "add one": a command that lands twice leaves the same pool as a command that lands once.

- growing takes the free numbers below the count, so a gap left by a dropped slot is filled before the numbers climb; a slot added this way is idle, dispatchable and priced exactly like one the file declared
- shrinking takes idle slots first, highest number first. With none idle nothing is interrupted: the count is what changed, and the first slot to go idle is the one that leaves
- a slot still running above the count reads as `slot 3 / 2` until it settles, because a pane that is drawing a live transcript must not disappear on a click
- one slot is the floor. An agent with no slots is one that should be [disabled](#enabled), which drains rather than deletes and can be undone

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
- down = anything but 2xx, a refused connection, 5s of silence, an api with no model list, or a `provider`/`model` pair pi does not know — every one of them is a reason held back and logged once, never an exception out of the tick
- the reason is what the log line carries: `provider cuda failed its health check: pi knows no model "qwen" on provider "cuda"; its slots are held back`, so a typo in the file reads as a typo and not as an outage
- one request per provider per scheduling tick, not per slot, and only for otherwise-free enabled slots
- gates dispatch only: a hosted provider wants this off, since a hosted outage is the backoff's job

## enabled

A property of the agent, not a slot: there is no case where slot 2 should be dispatchable while slot 1 is not. False in the file starts it parked; `disable_agent`/`enable_agent` and the console toggle at runtime, keyed by `type-provider-model`, and are never written back to the file — the file is the declared pool, and a restart is when you want it back.

Disabling never interrupts work: a slot mid-task keeps it, settles it, runs its checks, and is not offered again. `enabled` goes false on every row at once while `state` still reads `BUSY`, becoming `DISABLED` on release, because draining and already-idle are different situations.

## schedule

When an enabled agent may be dispatched, as segments of 24 hour `hh:mm` on the server's own clock. Naming none — the field omitted, or an empty list — leaves the agent dispatchable at any time; naming some closes every minute they leave out, and a slot outside all of them is not offered and reads `OFF_SCHEDULE`, so the console says why the queue is not moving rather than showing capacity that takes nothing. For the box that is cheap to run overnight and the model you would rather not have thinking while you work.

- **the minute is the unit**, both ends: `09:30–17:45` is a segment, `09:30–09:31` is the smallest one there is, and a slot is held at `09:29` against a `09:30` start. Nothing rounds to the hour
- a segment is half-open, `start` up to but not including `end`, so `06:00–09:00` and `09:00–17:00` hand over at nine without covering that minute twice
- an `end` earlier than its `start` wraps midnight: `22:00–06:00` is one segment, not two
- segments are a union and may overlap; a day with segments in it is closed unless one of them opens it
- refused **on load**: a time that is not `hh:mm`, and a segment that starts and ends at the same minute — never running is what `enabled` is for, and a whole day is what an empty schedule is for
- gates dispatch only, like the health check: a slot mid-task when its schedule closes keeps it, settles it, runs its checks, and is not offered again. `enabled` stays on throughout, because nobody threw a switch
- the clock is read at every tick and every view, and a tick is a second, so an agent starts taking work within a second of its segment opening, with nothing to restart
- `enabled` outranks it: an agent turned off inside its schedule reads `DISABLED`, not `OFF_SCHEDULE`

## Aborting a stuck command

`slot_abort` targets one slot by full name — the only case where a slot, not an agent, is the unit. Refused unless that process is inside a `bash` call: `bash` is the only tool that runs long enough to be stuck, and a runaway command is the only thing worth reaching into a live turn for. Anything worse is `looping` or a held state.

It sends `abort`, the same command a shutdown sends, and that **ends the turn**. There is no gentler command: `pi` has an `abort_bash`, but it only aborts commands the rpc itself started; an agent's own `bash` tool call runs under the turn's signal, so `abort_bash` answers success and the runaway keeps running.

The turn is what ends, not the run. The pool remembers which command it killed, so the settle reads that abort as the [`aborted` issue](settle.md#issues) rather than an abandon: the same session is prompted with the command that died and told to check what it touched and carry on. Session, claim, slot and worktree are untouched, and the agent keeps the context that produced the command. Only a shutdown's abort — nobody's command recorded — abandons the run. Three aborts in one dispatch hold the task instead: at that point the command is not the problem.

## Compaction

`compaction_start` means context overflowed: the agent loses the middle of its transcript and continues from a summary. Every role but `worker` has its worktree reset to the dispatched commit first — those roles change nothing, so anything present is a scribble the `untouched` guard would only catch a whole turn later. Then the dispatch fragment is re-sent as a steering message, joining the turn in flight; it is one line pointing at `../ASSIGNMENT.md`, the one part of the assignment compaction cannot eat.

## The agent state machine

```text
IDLE → SPAWNING → BUSY ⇄ WAITING → SETTLED → IDLE
IDLE ⇄ DISABLED (its agent)   IDLE ⇄ UNREACHABLE (its provider)
IDLE ⇄ OFF_SCHEDULE (its schedule)
BUSY → ABORTING → SETTLED (shutdown)   BUSY → IDLE (process died unsettled)
SETTLED → BUSY (correct, nudge, resume in situ)
```

- `UNREACHABLE` = `IDLE` + failed health check: holds nothing, still enabled, not offered. `WAITING` is the same shortage from the other side — a slot already holding a task that cannot reach its provider
- `OFF_SCHEDULE` = `IDLE` + the clock outside every declared segment: the same shape as `UNREACHABLE`, held by the schedule rather than the provider, and no state to enter or leave because it is read off the clock
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

The wait is a time on the slot's row, not a sleep: the tick that finds it passed re-prompts the session, so a shutdown or an abort in the middle of a 64s backoff is answered at once rather than after it. Refused is a broken provider and every retry costs something, so exponential decay recovering within a minute of it returning; 503-while-loading is a working provider (a large model on a cold box takes minutes to map weights), so wait. Neither exhausts: the failure is not the task's fault, and dropping the assignment would lose a live worktree and session over something that resolves itself. The slot sits in `WAITING` with the reason and next retry in its view row, so halved capacity is visible.

Nothing bounds retries of a task and nothing needs to: a bouncing task shows as repeated `fail`/`feedback` on one id in the transition log, and a review rejected twice holds.
