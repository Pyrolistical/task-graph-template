# 2 · `inline` in place of the pid

A busy pane's task line ends with the agent's pid. For an inline run that number is the console's own server: the same four columns on every inline pane, naming nothing an operator can act on. Draw the word `inline` there instead.

```text
task 000042 worker WORK pid 4242      pi
task 000042 worker WORK inline        inline
```

**Needs first:** [plan 1](01-inline-agent-entry.md), for `type: "inline"` to exist in a pool at all. Nothing else — the pid still reaches the view, still reaches the claim, and is still what the reaper tests.

## The rule

In `taskLine()` in `console/policy/panes.ts`, where the row is `pid ${slot.pid}`:

- the segment is drawn exactly when `slot.pid` is set, as now — a `SPAWNING` slot has no pid and no segment, on either type
- `type === "inline"` draws the literal `inline`; anything else draws `pid <n>`
- nothing else on the line moves: order, separators and the `retry` segment after it are untouched

The pid stays in `slots.json`. It is what the reaper asks about, what a restarted server reads, and what `claimed_pid` records; this plan changes one string in one drawing function and no fact anywhere.

## The change

| File                           | Layer  | Change                    |
| ------------------------------ | ------ | ------------------------- |
| `console/policy/panes.ts`      | policy | the branch above          |
| `console/policy/panes.test.ts` | policy | the behaviours below      |
| `docs/console.md`              | doc    | one bullet under the pane |

The console doc gains a bullet beside the existing pane lines: a pi pane names the pid of the process running the turn; an inline pane says `inline`, because the turn is happening in the server drawing the pane and there is no child to reach for.

## Tests

`console/policy/panes.test.ts`, exact-output as the rest of that suite is:

- a busy inline slot's task line reads `task 000042 worker WORK inline`
- a busy pi slot's task line is unchanged and still carries its number
- an inline slot with no pid yet draws neither `inline` nor a pid
- an inline slot in `retry` draws `inline` and the retry segment, in that order

## Done when

The pane suite is green, the exact-output tests for pi panes needed no edit, and `bun run bdd` is regenerated if a behaviour test's name changed.

## Not this plan

The pane header — `inline sonnet` in place of `pi anthropic/claude-sonnet-4-5` — is [plan 1](01-inline-agent-entry.md), because it follows from naming rather than from the pid.
