# The dictionary

One thing, one name — in code, docs, views and prompts. Two words for one thing means one is wrong.

## Graph

| Term          | Is                                                      |
| ------------- | ------------------------------------------------------- |
| task          | one unit of work, `NEW` → `CLOSED`                      |
| task document | the markdown file a task lives in                       |
| frontmatter   | its typed head — the whole machine-readable task        |
| body          | prose under the frontmatter; also the assignment        |
| state         | the document field saying where a task sits             |
| stage         | a row of the stage table (`STAGE_OF`), keyed by state   |
| phase         | design, plan or work — what a task can be held from     |
| role          | designer, planner, worker, reviewer                     |
| transition    | an edge of the state machine                            |
| claim         | which slot holds a task, and its pid                    |
| dependency    | a task that must close before this one leaves `BLOCKED` |
| blocking      | transitive count of tasks waiting on this one           |
| findings      | what a review sends back, verbatim                      |
| held reason   | why a task was parked, for the manager                  |
| check         | one declared shell command the server runs              |

## Pipeline

| Term            | Is                                                           |
| --------------- | ------------------------------------------------------------ |
| agent           | one `agents.json` entry: a model on a provider               |
| slot            | one concurrent seat of an agent, `type-provider-model-index` |
| pool            | every slot, idle included                                    |
| runner          | the pool's live state for one slot                           |
| run             | a runner that has a process, task and checkout               |
| process         | the `pi` subprocess and its rpc channel                      |
| session         | the pi session file, one per task and role                   |
| assignment      | `ASSIGNMENT.md`                                              |
| prompt fragment | one file under `prompts/`, rendered with vars                |
| template        | `template.md`, what a new task document is created from      |
| workspace       | a task's branch, worktree, slot and session                  |
| worktree        | the per-task clone on disk                                   |
| branch          | `task/<id>`, the only place agent commits land               |
| base            | the branch a worktree is cut from and lands onto             |
| checkout        | what a runner was handed                                     |
| message queue   | what the next agent on a task is told at dispatch            |
| dispatch        | clone, write, claim, spawn, prompt                           |
| candidate       | a dispatchable task with its rank                            |
| settle          | reading what a finished turn meant, and acting on it         |
| issue           | a named way a turn was wrong, with a retry budget            |
| guard           | what a stage requires of its worktree                        |
| harvest         | fetching a worktree's branch back into the repo              |
| land            | rebase, recheck, fast-forward onto the base                  |

An **agent** is configured, a **slot** is dispatched to, a **runner** is that slot now.

## Surfaces

| Term              | Is                                                             |
| ----------------- | -------------------------------------------------------------- |
| manager           | the Claude Code session that owns the server and judges        |
| server            | the process owning the graph, the pool and the checks          |
| console           | the read-only TUI over the views                               |
| view              | one of five JSON snapshots: slots, checks, tasks, inbox, queue |
| inbox             | what waits on the manager, in rank order                       |
| queue             | what the scheduler would dispatch next                         |
| transition log    | one line per applied transition, carrying the view cursor      |
| runtime directory | `/tmp/task-graph-server/<repo>/`                               |
| task directory    | `~/task-graph/<key>/` — documents, pool, overrides             |
| command channel   | the one file the console writes back on                        |
| port              | what the application needs, one file in `app/ports/`           |
| adapter           | the one implementation of a port that touches the world        |

## Rejected synonyms

journal → transition log · worker (pool member) → runner · agent (seat) → slot · a task's own inbox → message queue · prompt queue → message queue · stage as a value → state · clone (directory) → worktree · session (a process) → process · template (a prompt file) → fragment.

## Identifiers

- `PascalCase` types, `camelCase` values, `SCREAMING_SNAKE` module constants
- `snake_case` **only** for serialized fields — frontmatter, view rows, transition log, paths report
- ports are plural capability nouns (`Tasks`); adapters are named for what they are (`TaskDocuments`) and declare `implements`
- app modules are one noun per file: `dispatcher.ts` holds `Dispatcher`
- `xOf(y)` derives, `isX`/`hasX` predicates, `requireX` throws, `XRow` is a view projection
- anything off disk or wire is one zod schema plus its inferred type of the same name, parsed and never asserted
- no `as`: `memberOf` narrows, `tableOf` keys, `requireX` throws; the two unprovable assertions live in [`domain/lookup.ts`](../orchestrator/domain/lookup.ts)
