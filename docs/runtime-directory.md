# The runtime directory

Everything the server knows lives under `/tmp/task-graph-server/<repo>/`.

- `<repo>` is the absolute path of the manager's checkout with `/` replaced by `-`
- a checkout at `/home/model/task-graph-template` gets `/tmp/task-graph-server/-home-model-task-graph-template/`
- two managers on two clones of the same project never collide
- the directory name says which clone it belongs to

```text
/tmp/task-graph-server/-home-model-task-graph-template/
  server.log              # the server's own log, capped at 100 MB
  transitions.jsonl       # one line per applied transition, last 1000 kept
  inbox.json              # what is waiting on the manager, in priority order
  agents.json             # every slot, idle ones included
  checks.json             # every running check
  tasks.json              # the last 100 tasks to change state
  queue.json              # what the scheduler would dispatch next, and whether it is
  console-command         # a switch the console flipped, deleted as it is applied
  lock                    # the pid of the server that owns this directory
  000042/
    ASSIGNMENT.md         # the live assignment for this task
    history/
      ASSIGNMENT.1.md     # every superseded assignment, in order
      ASSIGNMENT.2.md
    findings.json         # the latest review's findings, until the stage resubmits
    review-failure-count  # consecutive rejections by the review the task is in;
                          # the second one holds it, cleared when a review passes
    queue/
      WORK.md             # failing checks waiting for the next WORK dispatch
    worktree/             # clone of the repo, branch task/000042
    session/
      worker/019fac03-fee6-7444-89f7-e643e848eba4.jsonl
      reviewer/019fb1d4-2a0c-7c19-9e11-77c0a5b1e332.jsonl
    agent-rpc.jsonl       # pi's rpc stream, appended across every process
    check-1.log           # stdout + stderr of checks[1]
```

`ASSIGNMENT.md` sits **beside** the workspace, not inside it:

- a file at the tree root shows up as untracked in every `git status` the agent runs, and eventually gets committed
- outside the tree it cannot be
- the diff stays clean without a `.gitignore` entry in the project or per-task `info/exclude` bookkeeping

## One server at a time

The client spawns `mcp.ts`, so a second `claude` in the same checkout spawns a second server against this directory. `lock` is what stops them: the server creates it exclusively at startup and writes its pid.

- a second server refuses to start, naming the pid that holds the directory, and serves that as its `error` resource rather than dispatching alongside the first
- the lock is cleared when the manager exits, and taken over when the pid in it is dead — a server killed outright leaves a lock nothing has to clean up
- the console never takes it: it is a reader, and any number of them can watch the directory at once

Everything here is disposable:

- a reboot clears `/tmp`, so on startup any task whose `workspace.worktree` no longer exists is cloned again from its branch
- the branch is in the repo to clone from because the server fetches it out of the workspace whenever an agent finishes — see [The workspace is a clone](workspace.md#the-workspace-is-a-clone)
- uncommitted work does not survive that, which is one more reason the agent contract is "commit as you go"

## The views

Five snapshots, one per question a reader asks.

- each is written to a temp file and renamed, so a reader always sees a whole document
- the manager can watch mtimes instead of polling
- all five carry the same `seq` — the transition cursor at the time of the write — so a view and a graph delta can be lined up

### `inbox.json`

- everything waiting on a person, most nearly closed first
- the one the manager reads to decide what to do next

```json
{
  "at": "2026-07-29T02:14:09.113Z",
  "seq": 4417,
  "inbox": [
    {
      "task_id": "000042",
      "title": "Parse frontmatter with Bun.YAML",
      "rank": "MANAGER_REVIEW",
      "blocking": 3,
      "open_todos": 0,
      "held_reason": null,
      "branch": "task/000042",
      "waiting_since": "2026-07-29T02:11:44.002Z"
    }
  ]
}
```

### `agents.json`

- the pool, including what is doing nothing
- answers "can I dispatch anything right now"

```json
{
  "at": "2026-07-29T02:14:09.113Z",
  "seq": 4417,
  "agents": [
    {
      "name": "pi-anthropic-claude-sonnet-4-5-1",
      "type": "pi",
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "slot": 1,
      "state": "BUSY",
      "task_id": "000042",
      "role": "worker",
      "pid": 91733,
      "started_at": "2026-07-29T01:58:02.004Z",
      "activity": "tool: bash — bun test",
      "tokens": 105000,
      "context_percent": 30,
      "session": "/tmp/task-graph-server/-home-model-task-graph-template/000042/session/worker/019fac03-fee6-7444-89f7-e643e848eba4.jsonl",
      "log": "/tmp/task-graph-server/-home-model-task-graph-template/000042/agent-rpc.jsonl"
    },
    {
      "name": "pi-llama.cpp-rocm-rocm-1",
      "type": "pi",
      "provider": "llama.cpp-rocm",
      "model": "rocm",
      "slot": 1,
      "state": "WAITING",
      "task_id": "000057",
      "role": "reviewer",
      "pid": 92014,
      "started_at": "2026-07-29T02:09:44.221Z",
      "activity": "provider: 503 model loading",
      "retry": { "at": "2026-07-29T02:14:14.000Z", "attempt": 3 }
    }
  ]
}
```

- `state` is one of `IDLE`, `DISABLED`, `SPAWNING`, `BUSY`, `WAITING`, `ABORTING`, `SETTLED` — the [agent state machine](agents.md#the-agent-state-machine)
- an idle slot is a row with nulls, never a missing row; the pool is fixed at load and the view shows all of it
- `enabled` is the agent's toggle, not the slot's: false on every slot of a disabled agent, including the ones still finishing a task, which read as `BUSY` with `enabled` false until released
- `retry` is null unless the slot is backing off, when it carries the time of the next attempt and how many have been made
- `tokens` and `context_percent` come from `get_session_stats`
- what a turn cost in dollars is not tracked — it is a provider fact that says nothing about whether the work is progressing, and the two numbers that do (context left, what the agent is doing right now) are already here

### `checks.json`

The check runner's processes, which have nothing to do with agents and no longer share a document with them.

```json
{
  "at": "2026-07-29T02:14:09.113Z",
  "seq": 4417,
  "checks": [
    {
      "task_id": "000058",
      "index": 1,
      "command": "bun test",
      "pid": 91802,
      "started_at": "2026-07-29T02:13:51.900Z",
      "log": "/tmp/task-graph-server/-home-model-task-graph-template/000058/check-1.log"
    }
  ]
}
```

### `tasks.json`

The graph, flattened for reading.

- the last 100 tasks to change state, closed ones included; the 101st drops off
- closed tasks stay visible because "what just landed" is the question a manager asks most often after a review

```json
{
  "at": "2026-07-29T02:14:09.113Z",
  "seq": 4417,
  "tasks": [
    {
      "id": "000042",
      "title": "Parse frontmatter with Bun.YAML",
      "state": "WORK",
      "state_entered": "2026-07-29T01:58:02.004Z",
      "depends_on": ["000007"],
      "blocking": 3,
      "claimed_by": "pi-anthropic-claude-sonnet-4-5-1",
      "held_reason": null,
      "worktree": "/tmp/task-graph-server/-home-model-task-graph-template/000042/worktree"
    }
  ]
}
```

- `blocking` is the transitive dependent count — how many tasks are waiting on this one
- it is the scheduler's tiebreak, the inbox's tiebreak, and the manager's reason to review one branch before another

### `queue.json`

What the dispatcher would hand out next, in the order it would hand it out, plus whether the scheduler is enabled at all.

- it is `candidates()` written down: the same ranking `dispatch` walks
- so the queue a reader sees is the queue that is about to be served, not a re-derivation of it

```json
{
  "at": "2026-07-29T02:14:09.113Z",
  "seq": 4417,
  "scheduling": true,
  "queue": [
    {
      "task_id": "000042",
      "rank": "WORK_STARTED",
      "claimed": "WORK",
      "role": "worker",
      "blocking": 3,
      "prefer_agent": "pi-anthropic-claude-sonnet-4-5-1",
      "session": null
    }
  ]
}
```

- a queued task is one waiting on a slot — `WORK_REVIEW`, `WORK`, `PLAN_REVIEW`, `PLAN`, `DESIGN_REVIEW`, `DESIGN`, or a failed task with a session to resume
- `claimed` is the state the task enters when the slot takes it, `role` the kind of agent that slot has to be
- the dispatcher reads both straight off the candidate rather than re-deriving them from the state
- everything else in the graph is waiting on a person, a check or an agent, and is in `inbox.json` or `tasks.json` instead

## The transition log

One line per successful transition, appended inside the graph lock where ordering is already serialized:

```json
{
  "seq": 1481,
  "at": "2026-07-29T01:51:43.543Z",
  "task_id": "000042",
  "transition": "fail",
  "from": "CHECK",
  "to": "WORK",
  "by": "server"
}
```

Three things for one:

- the cursor the views stamp
- a cheap delta for the manager
- the history a reviewer wants when a task arrives having been sent back four times

It is a server file, not a graph file — ephemeral, rebuilt from nothing on restart, and no part of the graph's correctness depends on it.

Caps:

- the file keeps the **last 1000 lines**; `seq` keeps counting past them
- a manager holding a cursor older than the window finds fewer entries than it expected, which is the correct answer — the graph itself is the record, and a manager that has been away that long should read `tasks.json`, not a delta
- `server.log` is capped the same way, at **100 MB**, trimmed to whole lines from the end
- both caps exist for the same reason: nothing under `/tmp` is worth losing a machine to, and the tail is the only part anyone reads

## Retention

```text
on every applied transition:
    if the task reached CLOSED:
        remove the worktree, delete the branch
        delete /tmp/task-graph-server/<repo>/<id>/ entirely
    move the task to the front of the recent list
    while the list is longer than 100:
        drop the last one
        if it is no longer an active task:
            delete /tmp/task-graph-server/<repo>/<id>/ entirely
```

`CLOSED` is terminal:

- no agent is ever dispatched against that task again, and the branch is either in `master` or thrown away
- so the sessions, the rotated assignments, the rpc log and the check logs go at that moment, rather than sitting in `/tmp` until a hundred other tasks have pushed the id off the recent list
- the row survives — `tasks.json` still shows it as `CLOSED` out of the in-memory archive, with `worktree` null — but nothing on disk backs it

The retention sweep is the second half of the same rule:

- it covers the directory of a task that left the active set without a closing transition — a task file deleted by hand, or one closed by a server that died before it could clean up
- an active task never loses its directory that way: its worktree is live, and it is only off the view because a hundred other tasks moved more recently
