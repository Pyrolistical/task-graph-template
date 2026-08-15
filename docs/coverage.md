# Coverage

`bun test --coverage`. Line and function coverage sit around 98%, high and mostly honest. This is where it is not.

## What the number does not see

- **nothing starts either program the way a person does.** `main/mcp.test.ts` drives a real MCP client over an `InMemoryTransport` against a `build()` in this process, so the entry points `mcp.ts` and `console.ts` never run at all and are absent from the report, and `main/serve.ts` reads at a third: `boot` and `startTicking` are driven, the stdio serving, the signal handlers and the detach around them are not
- a line that ran once is credited with values it never took; the gaps below are mostly branches, not statements

## The gaps, worst first

**The console's input loop** (`console/adapters/tui.ts`), never entered. Everything it composes is tested; nothing that composes them is — which key runs which scroll action, wheel buttons, a click landing on the new-marker vs a hit region vs nothing, `writeCommand` on a click (the only path from the TUI back to the server), the signal and teardown paths. It is the one gap that cannot be written in the suite's style: driving `main()` needs a pty, injected bytes and assertions on escape sequences. The dispatch is a pure function wearing a `switch`; moved into `policy/` as key → intent, every bullet becomes a one-`When` table test.

**`settler.backOff()`**. `tasks/policy/settle.ts` decides `back-off` and that decision is tested; what it does is not — the model-loading wait counting no attempt, the doubling toward the cap, the process dying during the sleep, the re-prompt on waking. It sleeps on the wall clock, so the `Then` cannot be observed without a second `When` for the wait to elapse: the sleep _is_ the behaviour, so it needs a seam before it needs a test. This path runs exactly when a provider is degraded, so being wrong means a wedged pool at the worst moment.

**Failure paths never taken** — claiming a task id with no file, a frontmatter id disagreeing with its filename, `findings.json` holding something that is not a count, frontmatter parsing to a scalar, `hold` from a phaseless state, the missing-cgroup warning, three bare `catch` swallows. Most fire only on on-disk state a person reached by hand-editing, so a break is a worse error message rather than a wrong outcome. The exception is the unreadable `/proc/<pid>/stat` swallow in `kernel/adapters/processes.ts`: a dead pid reading as alive is a claim the reaper never reaps and a task wedged forever.

**Nothing guards the reach of the suite** — no `bunfig.toml`, no threshold. `architecture.test.ts` guards the shape of the code and `bdd.test.ts` the shape of the tests; coverage can fall with nothing failing.

## Not gaps

- `testing/ports.ts` sits low because the fakes have more surface than the `app/` suites drive, which is what a fake is for
- `testing/tools-jig.ts` calls a real model and is deliberately outside the suite. The consequence is real: how reliably a model ends on the right result tool is measured by hand, never in CI

## What to do, in order

1. Extract the console's key and mouse dispatch into `policy/` as key → intent, and table-test it.
2. Give `backOff` a delay seam, then test the wait, the doubling, the cap and death-during-sleep.
3. Set a coverage threshold in `bunfig.toml`.
