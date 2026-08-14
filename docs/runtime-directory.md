# The runtime directory

Everything the server knows lives under `/tmp/task-graph-server/<repo>/`, where `<repo>` is the manager's checkout path with `/` → `-`, so two managers on two clones never collide and the directory name says which clone it is.

```text
server.log · transitions.jsonl · inbox.json · slots.json · checks.json
tasks.json · queue.json · console-command · lock
000042/
  ASSIGNMENT.md · history/ASSIGNMENT.<n>.md · findings.json
  review-failure-count · messages/WORK.md · check-<index>.log
  worktree/ · session/<role>/<uuid>.jsonl
```

`ASSIGNMENT.md` sits **beside** the worktree, not inside it: a file at the tree root shows as untracked in every `git status` and eventually gets committed. Outside the tree it cannot be, with no `.gitignore` bookkeeping.

Everything here is disposable — a reboot clears `/tmp`, so at startup any task whose worktree is gone is recloned from its branch, which is in the repo because the server fetches it out of the workspace whenever an agent finishes. Uncommitted work does not survive, one more reason the agent contract is "commit as you go".

## One server at a time

The client spawns `mcp.ts`, so a second `claude` in the same checkout spawns a second server. `lock` holds the owning pid: a second server refuses to start and serves that as `error` rather than dispatching alongside the first. The lock is cleared on exit and taken over when the pid in it is dead, so a killed server leaves nothing to clean up. Readers never take it.

## The views

Five snapshots, one per question a reader asks: `inbox` (what waits on a person), `slots` (can anything be dispatched now), `checks` (what the check runner is running), `tasks` (the graph flattened, last 100 to change state, closed included), `queue` (what the dispatcher would hand out next, `candidates()` written down rather than re-derived).

- each written to a temp file and renamed, so a reader always sees a whole document and can watch mtimes instead of polling
- all five carry the same `seq` — the transition cursor at write time — so a view and a graph delta line up
- an idle slot is a row with no task, never a missing row: the pool is fixed at load and the view shows all of it
- `enabled` is the agent's toggle, not the slot's, so a draining agent reads `enabled: false` while its slot still reads `BUSY`
- `tokens` and `context_percent` are the session totals pi reports, polled per tick off the running process; `cost` is what that session has spent — pi's price, or the [meter](agents.md#wattage-and-costperkwh) when the provider charges nothing, and zero when neither does, which the console draws as nothing
- a queued task is one waiting on a slot; everything else is waiting on a person, a check or an agent, and lives in `inbox.json` or `tasks.json`
- `blocking` is the transitive dependent count: the scheduler's tiebreak, the inbox's tiebreak, and the manager's reason to review one branch before another

Row shapes are zod schemas in [`views/`](../orchestrator/views/), the contract the two processes share; slot states are the [agent state machine](agents.md#the-agent-state-machine).

## The transition log

One line per successful transition, appended by the one writer as it applies. Three things for one: the cursor the views stamp, a cheap delta for the manager, and the history a reviewer wants when a task arrives having been sent back four times.

It is a server file, not a graph file — ephemeral, and no part of the graph's correctness depends on it. Last 1000 lines kept while `seq` keeps counting, so a manager holding an older cursor finds fewer entries than expected, which is the correct answer: read `tasks.json`, not a delta. `server.log` is capped at 100 MB, trimmed to whole lines. Nothing under `/tmp` is worth losing a machine to, and only the tail is read.

## Retention

On every applied transition: a task that reached `CLOSED` loses its worktree, branch and whole runtime directory at that moment — it is terminal, so sessions, rotated assignments and check logs would only linger. Otherwise the task moves to the front of a 100-long recent list, and anything falling off it that is no longer active loses its directory too. That second sweep covers a task that left the active set with no closing transition; an active task never loses its directory that way.
