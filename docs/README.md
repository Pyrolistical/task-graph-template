# Orchestrator

MCP server turning a task graph into a work queue for `pi` agents.

```text
manager (Claude Code)     authors tasks, judges reviews, closes tasks
  │ stdio (MCP)
server (bun)              scheduler · check runner · reaper · settler · lander
  │ JSONL rpc
pi #1  pi #2  pi #3       commits on task/<id>, read ASSIGNMENT.md
```

Invariants everything else rests on:

- agents never see the graph; `ASSIGNMENT.md` is their whole interface
- nothing an agent writes becomes a graph mutation without the server or the manager
- one writer process, one lock, one transition log
- a task reaches the manager only when a judgement is needed

| Document                                  | Covers                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| [Dictionary](dictionary.md)               | one name per thing; identifier spelling                |
| [Authority](authority.md)                 | server states facts, manager states opinions           |
| [States](states.md)                       | the pipeline, claims, splits, holds                    |
| [Task document](task-document.md)         | the graph on disk                                      |
| [ASSIGNMENT.md](assignment.md)            | the agent interface                                    |
| [MCP surface](mcp.md)                     | tools, resources, startup failure                      |
| [Layers](architecture.md)                 | domain · policy · app · adapters · main, and the ports |
| [Import graph](import-graph.md)           | every value import between modules, generated          |
| [Runtime directory](runtime-directory.md) | views, transition log, retention                       |
| [Server](server.md)                       | startup, tick order, pause, detach                     |
| [Scheduler](scheduler.md)                 | dispatch order, slot choice, inbox order               |
| [Settle](settle.md)                       | turn end → graph, issues and their budgets             |
| [Checks](checks.md)                       | the deterministic half                                 |
| [Workspace](workspace.md)                 | the per-task clone and landing it                      |
| [Sessions](sessions.md)                   | what resumes, what is fresh                            |
| [Agents](agents.md)                       | `agents.json`, health checks, outages, disabling       |
| [Sandbox](sandbox.md)                     | `pi` spawn, `bwrap`, cgroups, the rpc stream           |
| [Prompts](prompts.md)                     | every word an agent reads, and overrides               |
| [Console](console.md)                     | read-only TUI over the views                           |
| [Testing](testing.md)                     | the fake `pi`, the jigs                                |
| [Behaviour tests](bdd-tests.md)           | how a test is written here                             |
| [Behaviour](bdd.md)                       | every Given/When/Then, generated                       |
| [Coverage](coverage.md)                   | where the suite does not reach                         |

Read in order: dictionary → authority → states → assignment.
