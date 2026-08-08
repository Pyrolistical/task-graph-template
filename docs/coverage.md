# Coverage

Measured with `bun test --coverage`.

|                     |                                            |
| ------------------- | ------------------------------------------ |
| tests               | 646 across 29 files, 1277 `expect()` calls |
| wall clock          | 103s                                       |
| lines               | 97.99%                                     |
| functions           | 97.21%                                     |
| `bun run typecheck` | clean                                      |

The number is high and mostly honest. What follows is where it is not.

## What the number does not see

`main/mcp.test.ts` drives the server as a **subprocess** over a real stdio
client. Nothing that subprocess executes is instrumented, so `mcp.ts` and
`console.ts` do not appear in the report at all, and the lines `app/server.ts`
exposes only to the manager — `feedback` (133) and `reloadPrompts` (145-149) —
are reported uncovered despite having tests.

The report also credits a line that ran once with a value it never took. Most of
what is left below is branches, not statements.

## What is held down hard

- `domain/state-machine.test.ts` — every edge, and every edge it refuses
- `policy/settle.test.ts` — all six `Intent` kinds, one table, no subprocess
- the console's own logic — 68 + 24 + 19 + 10 exact-output tests across
  `policy/console`, `domain/text`, `adapters/tui` and `policy/keys`
- `adapters/prompts.test.ts` asserts **every issue has a prompt for every state
  that raises it**, that every state's `submit` schema carries exactly the fields
  its stage produces, and that every result tool ends the turn it is called in
- six `main/server-*.test.ts` suites drive the wired server against the fake `pi`
- `architecture.test.ts` and `bdd.test.ts` guard the layering and the test style,
  and [`docs/bdd.md`](bdd.md) is generated from the suite itself

## The gaps, worst first

### 1. The console's input loop — `adapters/tui.ts:240-389`, 0%

150 lines, one function, never entered. Everything it composes is tested and
nothing that composes them is:

- which key runs which scroll action — `j`/`k`, arrows, page keys, `g`/`G`
- wheel buttons 64 and 65, and a click that lands on the new-marker versus a hit
  region versus nothing
- `writeCommand` on a click — the only path from the TUI back to the server
- `q`/`^C`/SIGINT/SIGTERM → `restore()`, and the alt-screen teardown
- `draw()` throwing → restore the terminal, then rethrow
- resize, and the `schedule()` coalescing

`policy/console.ts:halfPage` is never called by a test either; `main()` is its
only caller.

This is the one gap that cannot be written in the suite's own style: driving
`main()` needs a pty, injected bytes, and assertions on escape sequences. The
dispatch is a pure function wearing a `switch` — moved into `policy/` as
key → intent, every bullet above becomes a one-`When` table test in a layer that
needs no fixture. The refactor is what makes the test writable.

### 2. `app/settle-agent.ts:185-217` — `backOff()`

`policy/settle.ts` decides `back-off` and that decision is tested. What it does
is not:

- a 503 that mentions load waits `MODEL_LOADING_MS` and does **not** count an
  attempt; any other provider error doubles the backoff toward `BACKOFF_CAP_MS`
- the process dying during the sleep releases the slot instead of prompting
- waking re-prompts with the nudge and re-watches

It sleeps on the wall clock, which is why it has no test: the `When` is fine, but
the `Then` cannot be observed without a second `When` for the wait to elapse.
`rates.ts` takes `nowMs` as a defaulted parameter and needs no port; `backOff`
sleeps, and the sleep is the behaviour. It needs a seam before it needs a test.

This is the path that runs exactly when a provider is degraded, so the cost of it
being wrong is a wedged pool at the worst possible moment.

### 3. Lock contention — `adapters/task-store.ts:152-161`

The server ticks while the manager writes, so the collision is ordinary
operation. Neither the `EEXIST` retry loop nor the "could not acquire after Ns"
give-up is exercised.

Both resist the style for the same reason: the retry needs a second actor that
holds the lock and then releases it, and the give-up costs a real 2s of blocking
`Bun.sleepSync` (200 × 10ms). Making `LOCK_RETRIES` and `LOCK_RETRY_MS`
injectable is what makes them testable.

### 4. Failure paths never taken

Individually small; together they are the failure story.

| Where                                                  | Never taken                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `adapters/claim.ts:55,92`                              | claiming or releasing a task id with no file                                          |
| `adapters/transition-store.ts:70`                      | a task file whose frontmatter id disagrees with its name                              |
| `adapters/findings.ts:27`                              | `findings.json` holding something that is not a count                                 |
| `domain/task.ts:104`                                   | frontmatter that parses to a scalar rather than a mapping                             |
| `domain/template.ts:44,58,64`                          | a template closing the wrong section, a section var that is not a list, an empty list |
| `domain/state-machine.ts:325,333`                      | `hold` from a state with no phase, `resume` on a task that is not held                |
| `main/compose.ts:108-110`                              | no cgroup limits — the warning                                                        |
| `task-store.ts:176`, `command.ts:22`, `compose.ts:273` | three bare `catch` swallows                                                           |

Most of these fire only on on-disk state a person reached by hand-editing, so a
break shows up as a worse error message rather than a wrong outcome. The
exception is `task-store.ts:176`: a dead pid that reads as alive is a claim the
reaper never reaps, and a task wedged in a claimed state forever.

### 5. Nothing guards the reach of the suite

There is no `bunfig.toml` and no coverage threshold. `architecture.test.ts`
guards the shape of the code and `bdd.test.ts` guards the shape of the tests;
coverage can fall without anything failing.

## Not gaps

- `testing/ports.ts` at 42.9% functions is the fakes having more surface than the
  `app/` suites drive, which is what a fake is for
- `testing/tools-jig.ts` calls a real model and is deliberately outside the
  suite. The consequence is real and worth naming: how reliably a model ends on
  the right result tool is measured by hand, never in CI

## What to do, in order

1. Extract the console's key and mouse dispatch into `policy/` as a pure function
   over an intent, and table-test it. Largest gap, and the refactor is what makes
   it expressible at all.
2. Give `backOff` a delay seam, then test the 503, the doubling, the cap and the
   death-during-sleep.
3. Make the lock's retry constants injectable and test contention.
4. Set a coverage threshold in `bunfig.toml` so none of this drifts back.
