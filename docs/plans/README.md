# Plans

One document per change that can land on its own: a branch, a green suite, a merge. The [inline agent](../inline-agent.md) is the design they cut up; each plan states what it delivers, what it needs first, and how you know it is done.

| Plan                                                         | Needs first | Touches                                             |
| ------------------------------------------------------------ | ----------- | --------------------------------------------------- |
| [1 · the inline row](01-inline-agent-entry.md)               | —           | `agents/domain/slots.ts`, `views/slots.ts`          |
| [2 · `inline` for the pid](02-inline-not-a-pid.md)           | 1           | `console/policy/panes.ts`                           |
| [3 · `TurnState`](03-turn-state.md)                          | —           | `agents/domain/protocol.ts` → `turn.ts`             |
| [4 · the `Models` port](04-the-models-port.md)               | 1           | `agents/ports/models.ts`, two adapters              |
| [5 · the tools](05-the-inline-tools.md)                      | —           | `kernel/domain/within.ts`, `agents/adapters/tools/` |
| [6 · transcript and sessions](06-transcript-and-sessions.md) | —           | `agents/domain/transcript.ts`, the scheduler        |
| [7 · the run](07-the-inline-run.md)                          | 1, 3–6      | `agents/adapters/inline-*.ts`, `main/compose.ts`    |
| [8 · the suite](08-inline-in-the-suite.md)                   | 7           | `testing/fixture.ts`, `bdd.test.ts`                 |
| [9 · aborting one command](09-aborting-one-command.md)       | 7           | `agents/app/pool.ts`, `settle`                      |

Plans 1–6 land in any order and change no behaviour an operator sees except where they say so; 1–6 are all shippable before anything can spawn an inline slot. Plan 7 is the one that makes `type: "inline"` runnable.

## What a plan owes its implementer

- the rules, spelled out to the point of the error message, so no judgement call is left implicit
- every file it creates or edits, and the layer each sits in ([the slices](../architecture.md))
- the tests to write, named as behaviours, and where they live
- what it is explicitly **not** doing, so the next plan is not pre-empted

House rules apply throughout: no code comments, `bun test` and `bun run typecheck` green, `bun run bdd` regenerated when behaviour tests change.
