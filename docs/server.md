# The server

One `bun` process, started by the manager over stdio, owning every mutation of the graph. `tasks/app/server.ts` is the lifecycle only: the locks, the tick, the console channel, detach and shutdown. What it used to front — the task verbs, the slots, the views, the scheduler switch — belongs to the modules it ticks ([Structure](architecture.md#structure)).

## Starting

1. take the [runtime directory lock](runtime-directory.md#one-server-at-a-time) before touching anything
2. load `agents.json` and build the fixed pool — [a bad config is rejected outright](agents.md)
3. reclone any task whose worktree is gone, from its branch in the repo
4. reattach to claims whose `claimed_pid` is alive, picking their rpc streams back up
5. write the five views once, so a console or manager attaching immediately sees whole documents

A held runtime directory, a bad config or a non-git directory is fatal to startup and [reported, not crashed](mcp.md#when-the-server-cannot-start); none is recoverable by a tick.

## The tick

Settle checks → reap dead claims → start checks → re-prompt the runs whose [backoff](agents.md#when-the-provider-is-down) is up → dispatch → write views.

Dispatch is last because everything before it can free a slot or move a task: the queue is planned against the graph as it is after this tick's facts. A reaped claim leaves the task's state where it is, so it re-enters the queue where it stands.

## Every edit through one door

The graph is a directory of whole documents, and rewriting one is a read and a write with an `await` between them. Nothing in the server writes a document itself: every mutation is a method on [the task graph](architecture.md#what-the-slices-are-not), which runs them one at a time. So a cost recorded as a slot is released cannot land on top of a body the manager just wrote, and the tick that follows reads what both of them left.

A tool call returns once its edit has been applied, not once a tick has picked it up.

## When a tick fails

The failure is kept, and served as `error`. Every tool and view refuses with that message while it stands, because a manager acting on views the server could not write is worse than a manager that is told to wait; `paths` and `workspace_path` still answer, since they are how a person finds what broke. The first tick that comes round cleanly clears it — a full disk that gets emptied needs no restart.

## Paused

`disable_scheduler` means "start nothing new", not "stop watching": transitions still apply, agents mid-run still settle and release, checks run, claims are reaped, views are written.

## Detaching

The MCP server dies with the manager; agents do not. The next manager reads `slots.json`, finds live pids and reattaches to their streams instead of orphaning live work — which is why the [runtime directory](runtime-directory.md) exists: everything needed to pick the pool back up is a file, not process memory.

`shutdown` is the other exit — it aborts every live turn and kills the processes, which is what a test harness or an operator wants and what a manager exiting does not.

## The console command channel

The server watches its runtime root for `console-command`: one JSON object, validated against a three-arm union, read and deleted in one step so it applies exactly once. Unparseable files are dropped silently, since anything on the machine can write there. It is the only channel besides MCP that changes server behaviour, and it can only do what [the console](console.md) can do.
