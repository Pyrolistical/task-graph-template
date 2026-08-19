# 9 · `slot_abort` stops a command, not a turn

Today the console's `[abort]` ends the turn, because pi's `abort_bash` only aborts commands the rpc itself started and an agent's own `bash` call is not one of them. An inline run owns its `bash` child, so the button can finally mean what its label says: kill the command, hand the agent the fact, let the turn carry on with the context that produced it.

This is a change to **what an operator's button does** and it retires an issue with a retry budget attached, so it lands on its own, after everything else, and never bundled with a plan that makes it work.

**Needs first:** [plan 7](07-the-inline-run.md).

## The two sizes

| Abort           | Raised by                                         | Does                                                                                   |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **the turn**    | shutdown, a detected loop, a settle that must end | cancel the request, kill the running tool, mark it settled                             |
| **the command** | the console's `slot_abort`                        | kill the `bash` child, return the operator's wording as that tool's result, keep going |

The turn-sized abort is exactly today's meaning and [settle](../settle.md) needs no change for it.

## What the command-sized abort does

- kills the `bash` child through the running tool's signal
- returns `the operator aborted this command` as **that tool call's result** — the wording [plan 5](05-the-inline-tools.md) already ships
- the loop continues: results appended, next request sent, same transcript
- **no settle, no `aborted` issue, no re-prompt of a dead command.** The turn keeps its context, which is the whole point: the agent reads that its command was stopped and decides what to do next
- the slot stays `BUSY` throughout. There is no state to enter or leave

## What it retires

[Agents](../agents.md#aborting-a-stuck-command) currently says: the pool remembers which command it killed, the settle reads that abort as the [`aborted` issue](../settle.md#issues), the same session is re-prompted with the command that died, and three aborts in one dispatch hold the task. For an inline slot **all four go**:

- the pool no longer records the killed command for the settler
- no `aborted` issue is raised
- nothing is re-prompted, because nothing ended
- the three-abort budget does not apply, because there is no dispatch-level event to count

A pi slot keeps every one of them, unchanged, for as long as `type: "pi"` exists. This is a branch on type in the pool, and it is the only place the two behave differently in front of an operator — say so in the docs rather than hiding it.

## Still refused

`slot_abort` is still refused unless that run is **inside a `bash` call**: `bash` is the only tool that runs long enough to be stuck, and a runaway command is the only thing worth reaching into a live turn for. Anything worse is `looping` or a held state. That rule does not change and neither does the console's `[abort]` being drawn only on an abortable activity.

## The change

| File                               | Layer    | Change                                                                        |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `agents/app/pool.ts`               | app      | `slot_abort` on an inline run aborts the tool, not the turn                   |
| `agents/ports/agents.ts`           | ports    | `abortCommand(): boolean` beside `abort()` — false when no command is running |
| `agents/adapters/pi-process.ts`    | adapters | `abortCommand()` falls through to `abort()`, today's behaviour                |
| `agents/adapters/inline-run.ts`    | adapters | kills the tool's sandbox and returns the wording                              |
| `docs/agents.md`, `docs/settle.md` | doc      | the two sizes, and which type gets which                                      |

Adding a second method to the port rather than a flag on `abort()` keeps the shutdown path — the one that must always end the turn — impossible to call by accident.

## Tests

- aborting an inline run mid-`bash` kills the child, and the next request carries a tool result with the operator wording
- that run does **not** settle, raises no `aborted` issue, and the task's state is unchanged after the tick
- the slot is still `BUSY` and its pane still draws the transcript
- aborting a pi run mid-`bash` still ends the turn and still produces the `aborted` issue, with its budget
- `slot_abort` on a run not inside a `bash` call is refused by name, on both types
- three command aborts on one inline dispatch hold nothing

## Done when

`bun test` and `bun run bdd` green, the pi behaviours byte-identical, and `docs/agents.md` says plainly which type does which.

## Not this plan

Removing the `aborted` issue or its budget. They stay for pi, and they leave when pi does.
