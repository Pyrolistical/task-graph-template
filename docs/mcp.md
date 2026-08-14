# The MCP surface

One stdio server calling the application in process. There is no CLI path into the graph, because a single writer is what keeps the lock meaningful and the transition log complete.

Tools, beyond what their names say ([who may call what](authority.md)):

- `task_create` returns a path; authoring is then editing that file — checks and dependencies are frontmatter, not tools
- `task_submit` is the close: from `MANAGER_REVIEW` only, landing the branch first ([Integration](workspace.md#integration))
- `task_submit_designing` / `task_submit_planning` / `task_submit_working` take a task out of `NEW`/`BLOCKED_*` into that phase — one tool per entry, because "skip the design" is a judgement and an argument would hide it
- `task_write_body` exists for rewriting a body the manager does **not** hold
- `disable_scheduler` / `disable_agent` are one verb at two scopes — the whole pool, or one model on one provider that is misbehaving; running work still settles, and both return what is draining
- `slot_abort` is the one place a slot is the unit; it ends the turn it interrupts and prompts the session with the command it killed ([why](agents.md#aborting-a-stuck-command))
- `reload_prompts` re-reads prompts cached at startup and returns each resolved absolute path, which is how a broken or deleted override is seen

Resources: the five [views](runtime-directory.md#the-views) served as they sit on disk, plus `paths`, `workspace_path` for file watchers, and `error`.

Each tool is one call on the module that owns the state — the graph, the lander, the pool, the dispatcher — followed by a view write, so what the manager reads next is what its call just did. There is no application interface in between restating those verbs ([Structure](architecture.md#structure)).

## When the server cannot start

A startup crash would be a crash loop — the client restarts it, it reads the same broken config, it dies again. So it does not die: a failure while wiring or starting is caught and kept, the process still serves the tool surface, and every tool and other resource returns that message instead of the connection dropping. `error` is where the manager reads it, and where later failures (a tick, publishing views) show up — a running server that hits one refuses its tools and views the same way until [a tick comes round cleanly](server.md#when-a-tick-fails). If serving `error` is itself what crashes, the process dies with the reason in `server.log`.

## The manager owns what it holds

A document is the manager's to edit with ordinary file writes wherever the manager owns the state: `NEW`, a held task before `resume`/`abort`, a `MANAGER_REVIEW` task before `submit`. Safe because ownership follows the state — no agent is dispatched to those states and the server applies no transitions there, so there is no second writer to race.

## The manager loop

Idle → work the [inbox](scheduler.md#the-manager-inbox) head: `MANAGER_REVIEW` → submit/abort/feedback; a held state → resume or abort; `NEW` or an empty inbox → author, then one of the `submit_*` entries. That order is the inbox's.
