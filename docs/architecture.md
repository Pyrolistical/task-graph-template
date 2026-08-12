# The layers

Five layers, every dependency pointing inward.

```text
main/      composition root — mcp.ts · console.ts    builds adapters, wires the app
adapters/  git · pi · bwrap · runtime dir · MCP · tty   every effect the system has
app/       use cases over ports                      orchestration
policy/    scheduler · settle · inbox · console       decisions over the model
domain/    state machine · task document · text       vocabulary and rules, no I/O
```

- `domain/` and `policy/` name no filesystem, subprocess or environment; `app/` knows only `app/ports/`; `main/compose.ts` is the only module that knows both halves
- tests in `domain/`, `policy/` and `app/` name no effect either — they run over the fakes in `testing/ports.ts`
- [`architecture.test.ts`](../orchestrator/architecture.test.ts) enforces all of it

## Why this shape

The pipeline is mostly **decisions**: what to dispatch, what a settled turn meant, where findings go, whether a worktree broke its guard. Inside one server they could only be reached by starting a subprocess, cloning a repo and driving a fake `pi`. As pure functions with the observations passed in, each is a table test.

`main/` drives the real adapters, so a port buys a seam, not a faster suite.

## Structure

`app/server.ts` holds the lifecycle and ticks the modules in order; `main/compose.ts` constructs them in dependency order and hands each port to the module that names it — no dependency bag. `dispatcher` → `settler` → `pool`/`task-graph`; `lander` → `checker`; nothing points back.

`app/manager.ts` declares what a protocol adapter may ask of the application, so `mcp.ts` holds a `Manager` and cannot reach a store, a path or a prompt through it. Every adapter is a class declaring `implements`, so it is checked where it is written.

## What the layers are not

- `Tasks` is one coarse port over whole documents under one lock: the document's point is that a person can edit it, and a repository-per-aggregate over that is `fs` with extra steps
- `Messages`, `Reviews` and `Assignments` share one adapter over the runtime directory, because it is one place with one convention; a file per verb only spreads the layout
- no `Clock` port: `rates.ts` takes `nowMs` as a defaulted parameter
