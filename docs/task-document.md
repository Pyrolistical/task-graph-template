# The task document

One markdown file per task, outside the repo. The file **is** the graph — no database, no index.

```text
~/task-graph/<key>/       # <key> from the repo path, so one machine drives several projects
├── agents.json           # the pool
├── next-task-id          # the id allocator
├── template.md           # optional; overrides orchestrator/template.md
├── .tasks.lock           # pid of the server that owns the graph
├── prompts/              # optional per-project prompt overrides
├── 000042.md
└── closed/000007.md
```

Outside every worktree, which is what makes it unreadable to an agent ([why](assignment.md#the-graph-is-not-in-the-worktree)). The first positional argument to `mcp.ts` overrides the directory.

Frontmatter is one **strict** zod object ([`vocabulary/task.ts`](../orchestrator/vocabulary/task.ts)) so an unknown key errors rather than being ignored; the body under it is the assignment, verbatim, and an accepted assignment replaces it. Errors name path and value; a task that fails to parse throws rather than being skipped, because a graph with one unreadable node cannot be scheduled against.

Past the types:

- `id` is a quoted six-digit string — `000042` unquoted is the number 42
- `claimed_by` and `claimed_pid` are both set or both null: a claim with no pid cannot be released, a pid with no name cannot be attributed
- `workspace.session` is the `WORK` session only ([why](sessions.md#roles-never-share-a-session))
- `costs` is what the task has spent, one `{state, slot, seconds, cost}` per session, in the order the sessions ran

## What a task cost

The server appends to `costs` when a slot lets a session go, so the ledger reads as the phases ran and a task carries its own bill — no view to join, no log to replay, and it survives into `closed/`.

- only the six states an agent runs are in it; `CHECK` and `MANAGER_REVIEW` cost nothing because nothing is prompted in them
- one entry is one **session**, not one turn: a resumed `WORK` session ([when](sessions.md#resume-only-within-the-same-submit-cycle)) updates the entry it already has, because pi prices a session file whole. A rejection starts a fresh session, so it is a second `WORK` entry
- `slot` is the [slot name](agents.md) the session ran on, so the bill names the model on the provider that earned it and not just the phase; a resume that lands on [another slot](scheduler.md#which-free-slot) takes over the entry, since the cost it carries is now the whole session's
- `seconds` is wall clock the session held its slot, rounded to the second, and a resume adds to what the entry already held. It is summed where a reported price is not, because a provider prices the whole session file while the clock only ever runs while a slot is held — the two agree only when nothing was resumed
- a zero is kept rather than dropped: a model that prices nothing and declares no [meter](agents.md#wattage-and-costperkwh) still ran, and an absent entry would read as a session that never happened
- the field is written by the server alone, so a document from before it existed loads with an empty one rather than being refused

## Serialization is hand-written

Reading uses `Bun.YAML.parse`; writing does not use an emitter, because the point is diff quality — the graph is written by the server, the manager and a human editor, and a serializer that reorders keys or rewraps strings makes all three unreadable to each other.

- `FIELD_ORDER` is the schema's key order, so a diff is the fields that changed
- ids and free text always quoted so a colon is not a mapping; anything else only when it must be
- the body keeps its own leading newline, so rewriting frontmatter never reflows prose

## Ids and the lock

`createTask` reads `next-task-id`, refuses if that document already exists — naming the counter that owes the id, since a wrong counter must never make two tasks share a file — writes the document, then advances the counter atomically.

`.tasks.lock` is the same `PidLock` as [the runtime directory's](runtime-directory.md#one-server-at-a-time), holding the pid of the process that owns the graph for its whole life. It is what makes "one writer" a fact rather than a convention, and why no mutation needs a lock of its own and the transition log's order is the graph's order.

## Closing, cycles, liveness

- `CLOSED` tasks move to `closed/`, so an id resolves forever and the active directory lists exactly the open graph
- `detectCycles` runs on every `task_submit_*` before a task leaves `NEW`/`BLOCKED_*` and names the edges; a dependency on a nonexistent id is not an edge, so a missing task blocks nothing
- `isProcessAlive` is `kill(pid, 0)` plus rejecting state `Z` in `/proc/<pid>/stat`, because an unreaped `pi` zombie answers "alive" and would leave a claim forever
