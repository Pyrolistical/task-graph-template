# Orchestrator

An MCP server that turns the task graph into a work queue for `pi` agents.

- a manager agent (Claude Code) owns the server over stdio
- the server drives `pi --mode rpc` subprocesses, each in a dedicated clone of the repo
- each subprocess runs inside a `bwrap` sandbox that leaves the repo itself read-only
- the server runs the declared checks itself, rather than trusting an agent to
- it publishes a live view of everything it owns under `/tmp/task-graph-server/<repo>/`
- it brings a task to the manager only when a judgement is needed

## Topology

```text
        ┌─────────────────────────┐
        │  manager (Claude Code)  │   authors tasks, reviews commits,
        └────────────┬────────────┘   decides what enters the graph
                     │ stdio (MCP)      watches inbox/agents/checks/tasks.json
        ┌────────────┴────────────┐
        │   orchestrator server   │   scheduler · check runner · reaper
        │        (bun)            │   mechanical transitions only
        └────────────┬────────────┘
                     │ JSONL commands in, events out
     ┌───────────────┼───────────────┐
┌────┴────┐     ┌────┴────┐     ┌────┴────┐
│ pi #1   │     │ pi #2   │     │ pi #3   │   commits + ASSIGNMENT.md
│ 000042  │     │ 000057  │     │ 000058  │   no graph access
└─────────┘     └─────────┘     └─────────┘
```

- agents never touch the task graph
- each one gets an `ASSIGNMENT.md` and produces two things: commits on its own branch, and edits to that `ASSIGNMENT.md`
- nothing it writes becomes a graph mutation without passing through the server or the manager

## The documents

**The contract**

| Document                              | What it covers                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Authority](authority.md)             | who may write what — the server states facts, the manager states opinions                  |
| [States](states.md)                   | the thirteen states, why the reviews are split, the design and planning phases, held tasks |
| [The task document](task-document.md) | the graph on disk: frontmatter schema, ids, the lock, cycles, closing                      |
| [ASSIGNMENT.md](assignment.md)        | the whole interface between an agent and the project: append-only, result tools, rotation  |
| [The MCP tool surface](mcp.md)        | the tools and resources the manager drives the server through, and the manager's own loop  |

**The machinery**

| Document                                      | What it covers                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| [The layers](architecture.md)                 | the onion: domain, policy, app, adapters, main, and the ports between them      |
| [The runtime directory](runtime-directory.md) | `/tmp/task-graph-server/<repo>/`, the five views, the transition log, retention |
| [The server](server.md)                       | startup, the tick, pausing, detaching, recovery                                 |
| [The scheduler](scheduler.md)                 | dispatch order, the slot handoff, the manager inbox                             |
| [Settling an agent](settle.md)                | mapping pi signals onto the graph, the named issues, applying a review          |
| [Checks](checks.md)                           | the deterministic half of the pipeline                                          |
| [The workspace](workspace.md)                 | the per-task clone, its lifecycle, and landing a branch                         |
| [Sessions](sessions.md)                       | what is resumed, what is fresh, and why roles never share one                   |

**The agents**

| Document                            | What it covers                                                              |
| ----------------------------------- | --------------------------------------------------------------------------- |
| [Agents configuration](agents.md)   | `agents.json`, roles, the write list, disabling, provider outages           |
| [The sandbox](sandbox.md)           | spawning `pi`, `bwrap` and cgroups, the command channel, reading the stream |
| [Prompts and templates](prompts.md) | every word an agent reads, and how a project replaces any of it             |

**The tools around it**

| Document                        | What it covers                                                         |
| ------------------------------- | ---------------------------------------------------------------------- |
| [The console](console.md)       | the live TUI over the views, and the command channel it writes back on |
| [Testing](testing.md)           | the fake `pi`, the jigs, the schema jig, and the Given/When/Then style |
| [Behaviour tests](bdd-tests.md) | how a test is written here                                             |
| [Behaviour](bdd.md)             | every Given, When and Then in the suite, generated from it             |
| [Coverage](coverage.md)         | what the suite holds down, and where it does not reach                 |

## Where to start

- [Authority](authority.md) — who is allowed to move a task
- [States](states.md) — where it can move to
- [ASSIGNMENT.md](assignment.md) — the only thing an agent ever sees

Those three are enough to follow the rest.
