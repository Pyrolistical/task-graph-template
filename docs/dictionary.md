# The dictionary

Every noun the orchestrator uses, once. One thing has one name — in the code, in
the documents, in the views and in this directory. Two words for one thing means
one of them is wrong.

## The graph

| Term          | What it names                                                                       | Carried by                             |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| task          | one unit of work with an id, from `NEW` to `CLOSED`                                 | `TaskId`, `TaskMeta`                   |
| task document | the markdown file the task lives in: frontmatter, then body                         | `<id>.md` in the task directory        |
| frontmatter   | the typed fields at the head of the document — the whole machine-readable task      | `TaskMeta`, `FIELD_ORDER`              |
| body          | the prose under the frontmatter: purpose, criteria, design, todos                   | `body`                                 |
| state         | where a task sits, one of the thirteen                                              | `TaskState`, `state`                   |
| stage         | a row of the stage table: a state plus the role, guard, section and tools behind it | `Stage`, `STAGES`, `STAGE_OF`          |
| phase         | design, plan or work — the three a task can be held from                            | `Phase`, `HELD_OF`                     |
| role          | designer, planner, worker or reviewer: what a stage needs an agent to be            | `Role`, `ALL_ROLES`                    |
| transition    | a named move between states: submit, pass, fail, hold, resume, feedback, abort      | `TransitionName`, `decide`             |
| claim         | the field saying which slot is holding a task, and its pid                          | `claimed_by`, `claimed_pid`, `Claim…`  |
| dependency    | a task that must close before this one leaves `BLOCKED`                             | `depends_on`                           |
| blocking      | the transitive count of tasks waiting on this one                                   | `blocking`, `blockingCounts`           |
| findings      | what a review sends back, verbatim                                                  | `findings`, `findings.json`, `Reviews` |
| held reason   | why a task was parked, for the manager to read                                      | `held_reason`                          |
| check         | one declared shell command the server runs in the worktree                          | `checks`, `RunningCheck`               |

- a **stage** is the table row; a **state** is what is written in the document.
  A field holding `"WORK"` is a state, whatever it is derived from.

## The pipeline

| Term            | What it names                                                                         | Carried by                    |
| --------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| agent           | one entry in `agents.json`: a model on a provider, with roles and a write list        | `AgentEntry`, `agentName`     |
| slot            | one concurrent seat of an agent, named `type-provider-model-index`                    | `Slot`, `slotName`, `SlotRow` |
| pool            | every slot the server has, idle ones included                                         | `Pool`                        |
| runner          | the pool's live state for one slot: its process, task, role, issues and backoff       | `Runner`                      |
| run             | a runner that actually has a process, a task and a checkout                           | `Run`, `runOf`                |
| process         | the `pi` subprocess behind a runner, and the rpc channel to it                        | `AgentProcess`, `PiProcess`   |
| session         | the pi session file a turn is recorded in, one per task and role                      | `session`                     |
| assignment      | `ASSIGNMENT.md` — the whole of what an agent is told, and where it answers            | `Assignments`                 |
| prompt fragment | one file under `prompts/`, rendered with vars into a thing an agent is sent           | `Prompts.fragment`, `render`  |
| template        | `template.md` — the document a new task is created from                               | `templatePath`                |
| workspace       | what a task keeps its work in: branch, worktree, slot and session                     | `Workspace`                   |
| worktree        | the per-task clone of the repo on disk                                                | `worktree`                    |
| branch          | `task/<id>`, the only thing an agent's commits land on                                | `branchName`                  |
| base            | the branch a worktree is cut from and lands back onto                                 | `base`                        |
| checkout        | what a runner was handed: branch, worktree, head, and the assignment as dispatched    | `Checkout`                    |
| message queue   | what the next agent on a task is told at dispatch — a failing check, and nothing else | `Messages`, `messages/`       |
| dispatch        | handing one candidate to one slot: clone, write, claim, spawn, prompt                 | `Dispatcher`, `Dispatch`      |
| candidate       | a task the scheduler could dispatch, with its rank                                    | `Candidate`, `candidates`     |
| rank            | the scheduler's order over candidates                                                 | `Rank`, `RANKS`               |
| settle          | reading what an agent's finished turn meant, and acting on it                         | `Settler`, `decideSettle`     |
| issue           | a named way an agent's turn was wrong, with a retry budget                            | `IssueName`, `ISSUES`         |
| guard           | what a stage requires of its worktree: untouched, committed, or nothing               | `Guard`, `worktreeIssue`      |
| harvest         | fetching a worktree's branch back into the repo                                       | `harvest`                     |
| land            | rebasing, re-checking and fast-forwarding a task's branch onto the base               | `Lander`                      |

- an **agent** is configured, a **slot** is dispatched to, a **runner** is what
  the pool remembers about that slot right now. `claimed_by`, `workspace.slot`
  and `prefer_slot` all hold a slot name.

## The surfaces

| Term              | What it names                                                               | Carried by                     |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------ |
| manager           | the Claude Code session that owns the server and makes the judgements       | `Manager`                      |
| server            | the process that owns the graph, the pool and the checks                    | `Server`                       |
| console           | the read-only TUI over the views                                            | `ConsoleView`, `tui.ts`        |
| view              | one of the five JSON snapshots: slots, checks, tasks, inbox, queue          | `Views`, `ViewName`            |
| inbox             | what is waiting on the manager, in rank order                               | `InboxRow`, `inbox.json`       |
| queue             | what the scheduler would dispatch next                                      | `Candidate`, `queue.json`      |
| transition log    | one line per applied transition, with the cursor the views stamp            | `Transitions`, `TransitionLog` |
| runtime directory | `/tmp/task-graph-server/<repo>/` — everything the server knows, on disk     | `Runtime`, `Paths`             |
| task directory    | `~/task-graph/<key>/` — the task documents, `agents.json` and the overrides | `tasksDir`                     |
| command channel   | the one file the console writes back on                                     | `CommandChannel`, `Command`    |
| port              | what the application needs, one file per port in `app/ports/`               | `Tasks`, `Workspaces`, …       |
| adapter           | the one implementation of a port that touches the outside world             | `TaskDocuments`, `git.ts`, …   |

## Words that are not used

| Not this                    | This           | Why                                                                            |
| --------------------------- | -------------- | ------------------------------------------------------------------------------ |
| journal                     | transition log | one log, one name; the port is `Transitions`                                   |
| worker (a member of a pool) | runner         | `worker` is a role, and a runner can be any of the four                        |
| agent (a seat in the pool)  | slot           | an agent is the `agents.json` entry; its seats are slots                       |
| inbox (a task's own)        | message queue  | the inbox is the manager's, and only the manager's                             |
| prompt queue                | message queue  | it carries messages; prompts are the fragments an agent is dispatched with     |
| stage (a value like `WORK`) | state          | a stage is a table row, a state is a document field                            |
| clone (the directory)       | worktree       | `git clone` is how one is made, not what it is called afterwards               |
| session (a pi process)      | process        | a session is the file; the process is `AgentProcess`                           |
| template (a prompt file)    | fragment       | the template is the one a task is created from; `fragment.ts` renders the rest |

## How identifiers are spelled

- `PascalCase` types, `camelCase` values, `SCREAMING_SNAKE` module constants
- `snake_case` **only** for fields that are serialized — task frontmatter, view
  rows, the transition log, the paths report. A field that never leaves memory
  is `camelCase`, in the same object as its serialized neighbours if it must be
- ports are plural nouns for the capability (`Tasks`, `Messages`, `Reviews`);
  adapters are named for the thing they actually are (`TaskDocuments`,
  `TransitionLog`, `CheckRunner`), and each declares `implements` on its port
- application modules are nouns, one per file, and the file is the noun in
  kebab-case: `dispatcher.ts` holds `Dispatcher`, `settler.ts` holds `Settler`
- `xOf(y)` derives an `x` from a `y` (`agentOf`, `tailOf`, `runOf`, `varsOf`)
- `isX` and `hasX` are predicates; `requireX` throws instead of returning null
- `XRow` is a projection that exists only to be published in a view
