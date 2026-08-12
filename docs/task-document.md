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

Frontmatter is one **strict** zod object ([`domain/task.ts`](../orchestrator/domain/task.ts)) so an unknown key errors rather than being ignored; the body under it is the assignment, verbatim, and an accepted assignment replaces it. Errors name path and value; a task that fails to parse throws rather than being skipped, because a graph with one unreadable node cannot be scheduled against.

Past the types:

- `id` is a quoted six-digit string — `000042` unquoted is the number 42
- `claimed_by` and `claimed_pid` are both set or both null: a claim with no pid cannot be released, a pid with no name cannot be attributed
- `workspace.session` is the `WORK` session only ([why](sessions.md#roles-never-share-a-session))

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
- `detectCycles` runs on `task_submit` before a task leaves `NEW`/`BLOCKED` and names the edges; a dependency on a nonexistent id is not an edge, so a missing task blocks nothing
- `isProcessAlive` is `kill(pid, 0)` plus rejecting state `Z` in `/proc/<pid>/stat`, because an unreaped `pi` zombie answers "alive" and would leave a claim forever
