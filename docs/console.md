# The console

A terminal UI over the [views](runtime-directory.md#the-views), one pane per slot, with the agent's live transcript scrolling in each.

```bash
bun orchestrator/main/console.ts [repo]   # interactive
bun orchestrator/main/monitor.ts [repo]   # read-only
```

- `repo` defaults to the current directory, and only names which runtime directory to read
- it is a **reader**: it holds no state the server needs, opens no rpc channel, and can be started, killed and restarted while agents run
- everything it draws comes from four JSON files and the session `.jsonl` the server points it at
- `monitor.ts` is the same program with `readOnly` true — same layout, no switches, no buttons

The console is laid out the same way the server is:

| Where               | What it holds                                                      |
| ------------------- | ------------------------------------------------------------------ |
| `domain/text.ts`    | graphemes, east-asian widths, spans, clipping, wrapping            |
| `domain/session.ts` | one session record in, transcript entries and a usage sample out   |
| `policy/console.ts` | panes, headers, the frame, the scroll anchor and the click targets |
| `policy/keys.ts`    | a chunk of stdin in, keys and mouse events out                     |
| `adapters/tui.ts`   | tailing the session files, reading the views, and the tty itself   |

## Layout

```text
[─●] scheduler │ 000042 WORK 000057 WORK_REVIEW        2 queued
──────────────────────┬───────────────────────┬──────────────────────
[─●] pi anthropic/cl… │ [─●] pi anthropic/cl… │ [●─] pi llama.cpp-r…
task 000042 worker W…│ task 000057 reviewer … │ no task
tool: bash — bun test │ thinking (12s)        │
3.4k tok/s ctx 30%    │ 1.1k tok/s ctx 8% x2  │
──────────────────────┼───────────────────────┼──────────────────────
01:58:02 bash: bun te…│ 02:09:44 read: src/a… │
01:58:09 result: 41 l…│ 02:09:51 thinking: t… │
```

- one queue line at the top: the scheduler switch, the head of the queue with each task's rank, and the total
- four header lines per pane: identity and state, task detail, current activity, token rate and context — `xN` after the context percentage counts how many times this agent has compacted on its current task
- then the transcript, scrolling
- panes divide the terminal evenly; below `MIN_PANE_WIDTH` (24 columns each) the console refuses to draw and says how many columns it needs, rather than rendering something unreadable

Each pane joins three sources by slot:

- its row from `agents.json` — name, model, state, activity, session path, context percent
- the task row from `tasks.json`, if it holds one — so the pane can show the task's state, not just the agent's
- the check row from `checks.json` for the same task, if one is running — a check displaces the activity line, because a task in `CHECK` has no agent doing anything

## The transcript

Each pane tails the agent's session `.jsonl` directly.

- `SessionTail` reads forward from a byte offset in 1 MB chunks, keeps the partial trailing line, and decodes with a streaming `TextDecoder` so a multi-byte character split across a chunk boundary is not corrupted
- if the inode changes or the file shrinks, the tail resets — a new session at the same path is a new file, not an append
- records are folded to one `Entry` each: `user`, `text`, `thinking`, a tool call by name with its most interesting argument (`command`, `path`, `file_path`, `pattern`, `url`), `result` (or a line count when it is multi-line), and `error` in red
- consecutive `model` entries merge, so a model change and its thinking-level change read as one line

Two caches keep a 1s redraw cheap:

- `PaneLines` wraps only the entries it has not wrapped before, and re-wraps only the last one, since that is the only entry that can still grow. A width change or a shrunken entry list drops the cache.
- `Sessions` keeps one tail and one wrap cache per session path, and `keep()` drops the ones no pane points at any more, so a finished task's transcript is not held forever

`tok/s` is computed from the transcript rather than read from a view:

- each assistant message with `usage` contributes a sample of its output tokens
- the last 10 samples are kept, and the rate is their sum over the span they cover
- it is the number that says whether a local model is actually producing, which `context_percent` alone does not

## Scrolling

- every key moves every pane by the same amount, counted back from the bottom rather than forward from the top, so panes of different lengths move together instead of the longest one moving first
- follow is the default (`bases` is `null`): every pane sticks to its own bottom and new lines appear
- the first backwards movement freezes each pane's bottom into `bases`, so lines arriving in a busy pane no longer slide what you are reading; the `offsets` are measured from those frozen rows
- one `offset` per pane, each saturating at that pane's own top: a pane that runs out of history stops at its first line while the others keep going, and it moves again on the first step forward rather than sitting still until the others have caught up — a single shared offset would bank that overshoot as dead travel
- follow returns only when every pane is back at `offset` 0, which clears `bases`
- while scrolled back, a pane whose bottom has moved past its frozen base has unread lines: a floating `New messages ↓` button is overlaid on the row one up from the bottom, centred, and clicking it returns every pane to the bottom and to follow
- the overlay is spliced at the span level with `take()` and `drop()`, so a wide grapheme cut by either edge becomes spaces and the columns stay aligned

| Keys                           | Action       |
| ------------------------------ | ------------ |
| `j` / `↓`                      | forward one  |
| `k` / `↑`                      | back one     |
| `space` / `PgDn` / `^F` / `^D` | forward half |
| `PgUp` / `^B` / `^U`           | back half    |
| `g` / `Home`                   | to the top   |
| `G` / `End`                    | follow again |
| `q` / `^C`                     | quit         |
| wheel up / down                | three lines  |

- input is parsed by `keys()`, which splits a raw chunk into whole escape sequences rather than characters, so one paste or one fast scroll does not desynchronise the parser
- redraws are coalesced: a tick every 1s, and input schedules at most one frame per 16ms
- the alternate screen is entered on start and restored on `q`, `SIGINT`, `SIGTERM`, and on any error thrown while drawing — a crash must not leave the terminal in raw mode with the cursor hidden

## Clicking

SGR mouse reporting is on, and the console registers click targets as it renders:

| Target                            | Command                              |
| --------------------------------- | ------------------------------------ |
| the scheduler switch, queue line  | `{command: "scheduler", enabled}`    |
| a pane's switch, header line      | `{command: "agent", agent, enabled}` |
| a pane's `[abort]`, activity line | `{command: "agent_abort", …}`        |

- `New messages ↓` is the one target that is not a command: it is handled in the console, ahead of the hit list, and only moves the scroll
- hit targets are recomputed every frame from the same layout that drew them, so a resize cannot leave a stale target behind
- `[abort]` only appears when that agent is inside a `bash` tool call; the server refuses the command otherwise
- it kills the command, not the turn — the agent sees a failed tool call and carries on, and the slot stays where it is
- the agent switch names the **agent** (`type-provider-model`) and toggles every slot of it; abort names the **slot** (with its trailing number), because it kills one command in one process
- `monitor.ts` renders switches as the words `enabled` / `disabled` and registers no targets at all

## The command channel

The console does not talk to the server — it writes a file.

- one JSON object into `console-command` in the runtime root, written atomically
- the server watches the directory, reads and deletes it, and applies it — see [The server](server.md#the-console-command-channel)
- if the file already exists, the write is skipped and returns false: the previous command has not been picked up yet, and queueing switch flips would be worse than dropping one
- the same three commands are available over MCP, so the console adds no authority — it is a second hand on controls the manager already has
