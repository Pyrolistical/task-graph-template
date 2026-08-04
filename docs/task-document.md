# The task document

One markdown file per task, in the task directory, outside the repo — the file **is** the graph, with no database and no index.

```text
~/task-graph/<key>/
├── agents.json          # the pool
├── next-task-id         # the id allocator
├── template.md          # optional; overrides orchestrator/template.md
├── .tasks.lock          # held only while a mutation is in flight
├── prompts/             # optional per-project prompt overrides
├── 000042.md            # an active task
└── closed/
    └── 000007.md        # a task that reached CLOSED
```

- `<key>` is derived from the repo path, so one machine can drive several projects
- the directory is outside every worktree, which is what makes it unreadable to an agent — see [The task graph is not in the worktree](assignment.md#the-task-graph-is-not-in-the-worktree)
- the manager may point the server at any directory; the first positional argument to `mcp.ts` is that path

## The shape of a document

YAML frontmatter, then a markdown body:

```markdown
---
id: "000042"
title: "Parse frontmatter with Bun.YAML"
state: WORK
state_entered: 2026-07-29T01:58:02.004Z
depends_on:
  - "000007"
claimed_by: "pi-anthropic-claude-sonnet-4-5-1"
claimed_pid: 91733
held_reason: null
workspace:
  branch: "task/000042"
  worktree: "/tmp/task-graph-server/-home-model-task-graph-template/000042/worktree"
  agent: "pi-anthropic-claude-sonnet-4-5-1"
  session: "/tmp/…/session/worker/019fac03….jsonl"
checks:
  - "bun test"
  - "bun run typecheck"
---

# Purpose

## Acceptance Criteria
```

- the body is the assignment: what an agent is given, verbatim, and what an accepted assignment replaces
- `orchestrator/template.md` is the seed — the frontmatter with every field empty, plus the two headings a manager fills in
- a `template.md` in the task directory overrides it, so a project can change what a new task looks like without touching the checkout

## The frontmatter schema

Declared once in zod as a **strict** object, so an unknown key is an error rather than a field silently ignored.

| Field           | Type                           | Notes                                                                  |
| --------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `id`            | six-digit string               | quoted, always; `000042` unquoted is the number 42                     |
| `title`         | non-empty string               | —                                                                      |
| `state`         | one of the thirteen + `CLOSED` | the error message lists every legal value                              |
| `state_entered` | timestamp or null              | parsed with `Date.parse`, not just shape-checked                       |
| `depends_on`    | array of task ids              | `BLOCKED` clears when the last one closes                              |
| `claimed_by`    | agent name or null             | `type-provider-model-slot`, or `manager`                               |
| `claimed_pid`   | integer or null                | what the reaper checks for liveness                                    |
| `held_reason`   | string or null                 | the agent's `blocked` message, verbatim                                |
| `workspace`     | object or null                 | `branch`, `worktree`, `agent`, `session` — strict, all four or nothing |
| `checks`        | array of commands              | run in order, in the workspace, by the server                          |

Two invariants beyond the field types:

- `claimed_by` and `claimed_pid` must both be set or both be null — a claim with no pid cannot be released, and a pid with no name cannot be attributed
- `workspace.session` is the `WORK` session: only a claim into `WORK` writes it, because [`WORK` is the only state a resume targets](sessions.md#why-rpc-mode)

Errors name the path and the value:

- `SchemaError` renders every zod issue as `field.path: message`
- the source — the file, or `template.md` — is in the message
- a task that fails to parse is not skipped or defaulted; it throws, because a graph with one unreadable node is not a graph you can schedule against

## Serialization is hand-written, not `YAML.stringify`

Reading uses `Bun.YAML.parse`. Writing does not use a YAML emitter:

- `FIELD_ORDER` comes from the schema's own key order, so every document has its fields in the same order and a diff between two states of a task is the fields that changed
- ids are **always** quoted (`ID_FIELDS`), because `000042` is a number to YAML and `42` is not a task id
- free text is always quoted (`QUOTED_TEXT_FIELDS`: `title`, `held_reason`, and the four workspace paths), because a colon in a title is otherwise a mapping
- anything else is quoted only if it needs to be — empty, padded, `null`/`true`/`yes`/`off`, numeric-looking, or carrying YAML punctuation
- empty lists render as `[]` on one line rather than as an empty block, so the common case stays one line
- `rebuildDocument(meta, body)` is `---\n<meta>\n---<body>` — the body keeps its own leading newline, so a rewritten frontmatter never reflows the prose under it

- the point is diff quality
- the graph is edited by a server, by a manager, and by hand in an editor
- a serializer that reorders keys or re-wraps strings makes all three unreadable to each other

## Ids and the lock

`next-task-id` is a single integer in a file:

- `createTask` reads it, formats `id` to six digits, writes `<id>.md` with `wx` (fail if it exists), then increments the file
- `wx` is the real guard: even if the counter were wrong, two tasks can never share a document
- the whole sequence runs under the lock

`.tasks.lock` is the graph's one writer:

- taken with `open(…, "wx")`, holding the owner's pid as its contents
- retried 200 times at 10ms, then a hard error naming the path and suggesting removal if it is stale
- released in a `finally`, so a throwing mutation does not wedge the graph
- every mutation goes through it: `createTask`, `writeTaskBody`, `applyTransition`, and the transition-log append that rides along inside it — which is what makes the log's ordering the graph's ordering

## Closing

- a task that reaches `CLOSED` is written into `closed/` and unlinked from the active directory
- `findTaskFile` looks in the active directory first, then `closed/`, so an id stays resolvable forever
- the active directory therefore lists exactly the open graph, which is what makes "read the directory" a cheap way to load it

## Cycles

- `detectCycles` is a DFS over `depends_on`, returning every node that participates in a cycle
- it runs on `task_submit`, before a task can leave `NEW` or `BLOCKED`
- the error names the dependencies the cycle runs through, because "it could never unblock" is only actionable if you know which edge to cut
- dependencies pointing at ids that do not exist are ignored by the walk rather than treated as edges — a missing task cannot block anything

## Liveness

`isProcessAlive(pid)` backs the reaper and the reattach at startup:

- `kill(pid, 0)` answers whether the pid exists
- it is not enough on its own: a `pi` process the server spawned and never reaped is a zombie, and a zombie answers "alive"
- so the check also reads `/proc/<pid>/stat` and rejects state `Z`
- without that, a crashed agent's claim would never be released and its task would sit in `WORK` forever
