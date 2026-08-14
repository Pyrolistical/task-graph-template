# The console

`bun console.ts [repo]` — terminal UI over the [views](runtime-directory.md#the-views), one pane per slot showing that agent's live transcript. `repo` defaults to cwd and only names which runtime directory to read.

A **reader**: no state the server needs, no rpc channel, startable and killable while agents run. Everything drawn comes from the JSON views and the session `.jsonl` they point at. Its own slice, laid out the same way the server's are — text and session records in `console/domain/`, panes, frame, scroll anchor and key decoding in `console/policy/`, tailing and the tty in `console/adapters/tui.ts`. It reaches for nothing of the server's but the [wire contract](../orchestrator/views/) and the runtime directory the views sit in.

```text
[─●] scheduler │ 000042 WORK 000057 WORK_REVIEW                                                       2 queued
────────────────────────────────────┬────────────────────────────────────┬────────────────────────────────────
[─●] pi anthro… slot 1 / 2 [-][+] 1s│[─●] pi anthro… slot 2 / 2 [-][+] 5s│[●─] pi llama.cpp-r… slot 1 [+] idle
task 000042 worker WORK pid 4242    │task 000057 reviewer WORK_REVIEW pi…│no task
tool: bash — bun test (12s)  [abort]│thinking (12s)                      │
3.4k tok/s ctx 30% $1.20            │820 tok/s ctx 8% x2 $0.31           │
────────────────────────────────────┼────────────────────────────────────┼────────────────────────────────────
01:58:02 bash: bun test             │02:09:44 read: src/app.ts           │
```

- one queue line (scheduler switch, queue head with ranks, total) and four header lines per pane; `xN` counts compactions on the current task and `$` the session's cost, drawn only when the provider or the [meter](agents.md#wattage-and-costperkwh) charges
- `slot 1 / 2` is this pane of its agent's [count](agents.md#slots), `slot 1` alone when the agent runs one; the model name is what gives way as a pane narrows, since the switch, the slot and the state are what a reader is scanning for
- the number is where the pane sits among its agent's panes, not the number the pool keeps: dropping slot 1 of two leaves `slot 1 / 2` and `slot 2 / 2` side by side rather than a gap. Each agent counts from one, and the order panes are drawn in never changes under it, so a number moves only when a pane beside it comes or goes
- each pane joins three sources by slot: its `slots.json` row, the `tasks.json` row for the task it holds, and that task's `checks.json` row — a running check displaces the activity line, because a task in `CHECK` has no agent doing anything
- a slot whose provider failed its [health check](agents.md#healthcheck) reads `unreachable` with its switch still on: the agent is enabled, the provider is not there
- a slot the clock has taken outside its [schedule](agents.md#schedule) reads `off schedule`, switch on for the same reason: nobody turned it off, its next segment has not come round
- panes divide the terminal evenly; below a minimum width it refuses to draw and says how many columns it needs. With no agents there are no panes, only the pool file's path
- disabled agents collapse to the right under one `hide disabled` button — console-local state, nothing written to the server

## The transcript

Each pane tails the session `.jsonl` directly: forward from a byte offset in 1 MB chunks, keeping the partial trailing line and decoding with a streaming `TextDecoder` so a multi-byte character split across a chunk is not corrupted. A changed inode or shrunken file resets the tail, since a new session at the same path is a new file rather than an append.

Records fold to one entry each — user, text, thinking, a tool call by name with its most interesting argument, a result or its line count, errors in red — and consecutive model entries merge. Only new entries are wrapped, and only the last one re-wrapped, since it is the only one that can still grow.

`tok/s` comes from the transcript rather than a view: each assistant message with usage is an output-token sample. It says whether a local model is actually producing, which `context_percent` does not.

## Scrolling

Every key moves every pane by the same amount, counted back from the bottom, so panes of different lengths move together.

- follow is the default; the first backwards movement freezes each pane's bottom, so new lines in a busy pane no longer slide what you are reading
- one offset per pane, each saturating at its own top: a pane out of history stops while others continue and moves again on the first step forward — a shared offset would bank that overshoot as dead travel
- follow returns only when every pane is back at the bottom
- a pane with unread lines overlays `New messages ↓`, spliced at span level so a wide grapheme cut by either edge becomes spaces and columns stay aligned; clicking it returns every pane to follow
- keys are split into whole escape sequences rather than characters, so a paste or fast scroll cannot desynchronise the parser; redraws coalesce at one frame per 16ms
- a failure reading the views is drawn centred rather than thrown, and the alternate screen is restored on quit, signals, and an error thrown while drawing — a crash must not leave the terminal in raw mode with the cursor hidden

## Clicking

SGR mouse reporting; targets are recomputed every frame from the layout that drew them, so a resize cannot leave a stale one. The scheduler switch, an agent switch, `[-]` `[+]` and `[abort]` become [commands](server.md#the-console-command-channel); hiding disabled agents and the new-message marker are handled in the console.

The agent switch names the **agent** and toggles every slot of it; `[-]` and `[+]` name the agent too, and set its [slot count](agents.md#changing-the-count-while-the-server-runs) rather than asking for one more or one fewer, so a command that lands twice is the same pool as one that lands once; abort names the **slot**, because it kills the command one process is stuck in, and the turn with it; the agent is prompted straight back with what died. The same four commands exist over MCP, so the console adds no authority.

`[-]` is not drawn on an agent down to its last slot, and the count a click asks for is the one on the screen either side — so clicking `[+]` twice asks for two more, the second reading the first click's count rather than the view's.

A switch flips on the click, before the server has seen it: the clicked value is drawn over the views until one of them agrees. So does the pool: `[+]` puts a pane on the screen at once, at the number the server will give it, reading `loading` until the view carries it; `[-]` takes an idle pane off at once, the highest-numbered one, and never a pane holding a task — a click must not be what makes a live transcript disappear.

Both are drawn over the views the same way a switch is, so the screen a click produces is either confirmed or undone within two views. It takes **two** views that still disagree to reset it, because the first one is likely to have been published before the server read the command — resetting on it would flip the switch back and then forward again as the next view lands. Two disagreeing views mean the command was dropped or refused, and the switch springs back. Clicking again starts the two over.

## The command channel

The console writes one JSON object into `console-command` atomically rather than talking to the server. If the file exists the write is skipped: queueing switch flips is worse than dropping one.
