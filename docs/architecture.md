# The layers

The orchestrator is an onion: five layers, and every dependency points inward.

```text
              ┌─────────────────────────────────────────┐
              │  main/     composition root             │  builds the adapters,
              │            mcp.ts · console.ts          │  hands them to the app
              ├─────────────────────────────────────────┤
              │  adapters/ git · pi · bwrap · the       │  every effect the
              │            runtime directory · MCP · tty│  system has
              ├─────────────────────────────────────────┤
              │  app/      the use cases, one module    │  orchestration, over ports
              │            each, and the ports they use │
              ├─────────────────────────────────────────┤
              │  policy/   scheduler · settle · inbox   │  decisions over the model
              ├─────────────────────────────────────────┤
              │  domain/   the state machine · the task│  the vocabulary, and the
              │            document · transitions       │  rules that never do I/O
              └─────────────────────────────────────────┘
```

- `domain/` and `policy/` name no filesystem, no subprocess, no environment
- `app/` knows the ports in `app/ports.ts` and nothing about what implements them
- `adapters/` is where `node:fs`, `git`, `bwrap` and `pi` live
- `main/compose.ts` is the only module that knows both halves

- a test in `domain/`, `policy/` or `app/` names no effect either: those layers
  decide, and their suites run over the fakes in `testing/ports.ts`

[`architecture.test.ts`](../orchestrator/architecture.test.ts) enforces all four
rules on every commit, and it is what keeps the diagram true.

## Why this shape here

The pipeline is mostly **decisions**: which task is dispatched next, what a
settled agent's turn meant, where findings go, whether a worktree broke its
guard. Those decisions were spread through a 1,500-line server that could only
be reached by starting a subprocess, cloning a repo and driving a fake `pi`.

They are now pure functions with the observations passed in:

| Decision                       | Lives in                  | Tested by                     |
| ------------------------------ | ------------------------- | ----------------------------- |
| what a settled turn meant      | `policy/settle.ts`        | 18 tests, no subprocess, 36ms |
| what to dispatch next          | `policy/scheduler.ts`     | a table of tasks and slots    |
| what is waiting on the manager | `policy/inbox.ts`         | a map of tasks                |
| where a transition lands       | `domain/state-machine.ts` | a `TaskMeta` and a name       |
| whether a worktree is clean    | `domain/guard.ts`         | `{ dirty, commits }`          |
| what an agent may have written | `domain/assignment.ts`    | two strings                   |

## The application modules

`app/server.ts` is the lifecycle and the console; the work is one module each,
constructed in dependency order by `main/compose.ts`.

| Module            | What it owns                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `task-graph.ts`   | reading the graph, applying transitions, the recently-touched list |
| `pool.ts`         | the agent slots, their processes, and the work in flight           |
| `dispatch.ts`     | turning a scheduled candidate into a claimed, prompted agent       |
| `settle-agent.ts` | what a settled turn does next: restore, raise, back off, submit    |
| `run-checks.ts`   | running a task's declared checks and passing or failing it         |
| `land.ts`         | rebasing, re-checking and fast-forwarding a task onto the base     |
| `recover.ts`      | recloning workspaces, reattaching live pids, reaping dead claims   |

- `dispatch` needs `settle-agent`, `settle-agent` needs `pool` and `task-graph`,
  `land` needs `run-checks`; nothing points back the other way
- `server.ts` holds them, ticks them in order, and owns nothing else

## The ports

`app/ports.ts` declares what the application needs; `main/compose.ts` supplies it,
and hands each port to the constructor of the module that uses it. There is no
bag of dependencies: a module names what it needs, and gets exactly that.

| Port          | What it is for                                          | Adapter                           |
| ------------- | ------------------------------------------------------- | --------------------------------- |
| `Tasks`       | the graph on disk, under its lock                       | `task-store` + `transition-store` |
| `Workspaces`  | clones, branches, rebases, and the status a guard reads | `git.ts`                          |
| `Agents`      | spawning a sandboxed `pi` and talking to it             | `pi-process` + `sandbox`          |
| `Checks`      | running a declared check and reporting how it went      | `check-runner`                    |
| `Prompts`     | every word an agent reads                               | `prompts.ts`                      |
| `Inbox`       | the prompt queue and `findings.json`                    | `queue` + `findings`              |
| `Assignments` | the live `ASSIGNMENT.md` and its rotation               | `assignment-store`                |
| `Journal`     | the transition log and its cursor                       | `transition-log`                  |
| `Publisher`   | the five views and the server log                       | `runtime`                         |
| `Console`     | the command channel the TUI writes on                   | `command`                         |
| `Paths`       | the runtime directory layout                            | `runtime`                         |

Two of these earn their keep immediately: `Agents` and `Checks` are what make
the integration tests slow, and they are now one object away from being faked.

## What the layers are not

- `Tasks` is deliberately coarse — whole documents, read and written under one
  lock. The task document's whole point is that a person can edit it; a
  repository-per-aggregate abstraction over that would be `fs` with extra steps.
- there is no `Clock` port. `rates.ts` takes `nowMs` as a defaulted parameter,
  which is the same benefit without the ceremony.
- `main/` may import anything. That is what a composition root is for.
