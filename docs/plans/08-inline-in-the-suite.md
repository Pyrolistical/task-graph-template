# 8 · every behaviour test against both types

`fixture.ts` writes a whole second program — a bun script parsing pi's flags, emitting pi's JSONL, writing a real session file — to say "the agent called `submit`". Against an inline slot none of that is needed: a step is a scripted response and a tool is a function. Make the [`Plan` vocabulary](../testing.md#the-fake-pi) run against either type, and the [behaviour suite](../bdd-tests.md) doubles for free.

**Needs first:** [plan 7](07-the-inline-run.md).

## The idea

The `Plan` vocabulary — append a section, call a result tool, answer in prose, commit or dirty the worktree, tamper with the assignment, settle with a `stopReason`, repeat a call, compact, take time, die without settling, corrupt the workspace — describes **what an agent does**, not how it is spawned. It already survives the change of transport; what has to change is only what a `Step` compiles into.

```text
Step ──▶ a line the fake pi prints        type: "pi"
Step ──▶ a scripted Models response       type: "inline"
```

Add a `ScriptedModels implements Models` in `testing/`, driven by the same `Plan`: it reads the task id and claimed state off the request, picks that dispatch's `Step`, and yields the events that step means. Where a pi step writes JSONL, the inline step yields `text`, `tool`, `usage` and `end`.

Each step's inline form, so nothing is left to judgement:

| Step                      | Inline form                                              |
| ------------------------- | -------------------------------------------------------- |
| append a section          | a `write`/`edit` tool call, then `end: stop`             |
| call a result tool        | a `tool` event for `submit`/`blocked` with its arguments |
| answer in prose           | `text` deltas, `end: stop`, no calls                     |
| commit / dirty / tamper   | a `bash` call doing it                                   |
| settle with a stop reason | `end` carrying that reason                               |
| repeat a call             | the same `tool` event N times, one per iteration         |
| compact                   | usage over the row's threshold, then the ordinary step   |
| take time                 | a delay before the first event                           |
| die without settling      | the iterable throws                                      |

## Running the suite twice

`server-jig.ts` gains a type: the same wiring, either a fake `pi` on the pool or an inline row with a `ScriptedModels` behind it. The behaviour tests then run over both, and `bdd.test.ts` must keep generating **one** entry per behaviour rather than two — the behaviour is the same sentence, the agent type is a parameter. Decide this before writing the loop: a doubled `docs/bdd.md` is the failure mode to avoid.

Where a behaviour is genuinely about one type — pi dying without settling, an inline `kill()` not stopping the server — it stays in that type's own suite and is not parameterised.

## `tools-jig.ts`

The exception that is **duplicated rather than shared**. It exists to call a real model and report how often the last call was the right result tool; the inline version calls one through the `Models` adapter instead of through a spawned `pi` session. Same report, same flags plus the endpoint fields, separate file. Sharing the driving code here would couple the one script that is allowed to hit the network to the one that is not.

## The fake pi

Stays, unchanged, exactly as long as `type: "pi"` does. This plan does not delete it and does not touch it.

## The change

| File                                   | Layer | Is                                      |
| -------------------------------------- | ----- | --------------------------------------- |
| `testing/scripted-models.ts`           | test  | `implements Models`, driven by a `Plan` |
| `testing/server-jig.ts`                | test  | wire either type                        |
| `bdd.test.ts`                          | test  | one entry per behaviour, both types     |
| `testing/tools-jig-inline.ts`          | test  | the schema jig over an endpoint         |
| `docs/testing.md`, `docs/bdd-tests.md` | doc   | a `Plan` runs against either type       |

## Tests

The suite is the test. What has to be asserted on top:

- a `Plan` producing a `submit` settles a task identically on both types, and the assertion is the same line
- every issue in [settle](../settle.md#issues) has a step producing it on both types
- `docs/bdd.md` has the same number of behaviours after this plan as before, and `bun run bdd` leaves the tree clean
- nothing in the parameterised suite asserts on which type ran

## Done when

`bun test` runs every behaviour twice and is green, `bun run bdd` regenerates a `docs/bdd.md` with no duplicated entries, and the fake `pi` is untouched.

## Not this plan

Removing `type: "pi"`, the fake pi, or anything in `docs/testing.md` about them.
