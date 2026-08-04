# Testing

```bash
bun test          # the suite
bun run typecheck # tsc --noEmit
```

- nothing in the suite calls a model
- everything that would is replaced by a fake `pi` that speaks the same rpc protocol
- so the tests exercise the real server against a scripted agent

## The fake pi

`fixture.ts` writes a `pi`-compatible bun script and points the server at it with `piCommand`.

- it parses the same flags the real one gets (`--session-dir`, `--name`)
- it reads JSONL commands on stdin and emits the same events: `agent_start`, `tool_execution_*`, `agent_end`, `agent_settled`
- a `busy_ms` step is a `bash` call that has not returned yet, so `abort_bash` has something to kill: the fake ends the tool call as an error and finishes the turn from there, the way a real agent reacts to its command dying
- it writes a real session `.jsonl`, so the transcript reader and `get_session_stats` have something true to read

What it does is declared, not coded. A `Plan` maps task id → claimed state → a list of `Step`s, one per dispatch of that state:

| Field                                               | What the fake agent does                                     |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `design` / `todos` / `notes`                        | append that section to `ASSIGNMENT.md`                       |
| `submit`, `findings`, `delegations`                 | call the state's `submit` result tool with those arguments   |
| `blocked`                                           | call `blocked` with that message                             |
| `raw_final_message`                                 | answer in prose and call nothing — the `missing-result` path |
| `commit` / `write`                                  | commit a file, or write one and leave it dirty               |
| `clean`                                             | delete paths from the worktree                               |
| `tamper: {from, to}`                                | rewrite part of the assignment above its own section         |
| `stop_reason`                                       | settle with `length`, `error`, `aborted`                     |
| `loop: n`                                           | emit the same tool call `n` times                            |
| `compact: reason`                                   | act on the worktree, then emit `compaction_start`            |
| `busy_ms`, `start_delay_ms`, `new_session_delay_ms` | take time, so timing paths are reachable                     |
| `die`                                               | exit without settling — the `BUSY → IDLE` edge               |
| `break_git`                                         | corrupt the workspace so a git operation fails               |

- every issue in [the issues table](settle.md#issues) has a step that produces it
- a test asserts on the graph, on `held_reason` or on the fragment the agent was prompted with, rather than on server internals

## The jigs

| File                  | What it stands up                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temp.ts`             | a `test()` wrapper that gives each test its own temp directories and removes them on success, keeping them on failure so a failure can be inspected |
| `orchestrator-jig.ts` | a real git repo with one commit, and `commitIn` to add more                                                                                         |
| `graph-jig.ts`        | a task directory seeded with `next-task-id`, plus `baseMeta` and `bodyOf` for document-level tests                                                  |
| `fixture.ts`          | the whole world: repo, task directory, agents file, runtime root, fake `pi`, and the `Plan` it runs                                                 |
| `server-jig.ts`       | `serverFor(fixture)`, `editTaskFile`, and the two ways to advance time — `settle(server, ticks)` and `until(server, predicate)`                     |

- `settle` and `until` both tick and drain, because a tick starts work the next tick observes; a test that ticked once and asserted would be asserting on a half-applied transition
- `deadPid()` spawns and reaps a real process, which is the only honest way to get a pid that is certainly gone

## The layers

| Suite                                                    | What it holds fixed                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `task.test.ts`, `states.test.ts`, `machine.test.ts`      | the document and the state tables, with no server                                    |
| `transitions.test.ts`                                    | every legal and illegal transition, against a task directory alone                   |
| `scheduler.test.ts`, `agents.test.ts`, `prompts.test.ts` | ranking, pool loading, prompt resolution and overrides                               |
| `rpc.test.ts`, `assignment.test.ts`, `runtime.test.ts`   | the pi protocol, the append-only rule, paths and view writing                        |
| `server-*.test.ts`                                       | the whole server against the fake pi: dispatch, settle, checks, views, recovery      |
| `console.test.ts`                                        | wrapping, wide characters, hit targets, tailing — all pure functions over fake views |
| `mcp.test.ts`                                            | the tool surface over a real stdio client, in a subprocess                           |

`console.test.ts` is the largest of them because the console is the most-formatted code in the repo: grapheme segmentation, east-asian widths, clipping and the scroll anchor are all exact-output tests, which is what lets the drawing code stay free of defensive checks.

## The schema jig

```bash
bun orchestrator/tools-jig.ts --provider <provider> --model <model> [--trials N] [--states ...]
```

This one **does** call a model — it measures how reliably a model ends with the right result tool.

- for each state and each scenario — submit, blocked, and the reviewer variants — it spawns a `pi` session loaded with the state's real extension (`result-tools-<tools>.ts`) and the real `prompts/<STATE>.md`
- it sends a trivial assignment and checks which result tool the last call was
- the report is a per-scenario pass rate with the failure modes (wrong tool, no call) and the calls that failed
- the exit code is non-zero when any scenario passes nothing

- it is the tool for iterating on the wording of the result contract in the prompts: run it against a provider, read where it fails, tighten the prompt, run it again
- a model that scores badly here is a model to restrict with [`roles`](agents.md#which-roles-an-agent-may-take), not one to work around in the server
