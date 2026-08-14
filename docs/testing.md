# Testing

```bash
bun test          # the suite
bun run typecheck # tsc --noEmit
bun run bdd       # regenerate docs/bdd.md from the suite
```

Nothing in the suite calls a model: everything that would is replaced by a fake `pi` speaking the same rpc protocol, so the tests exercise the real server against a scripted agent.

## The fake pi

`fixture.ts` writes a `pi`-compatible bun script and points the server at it. It parses the same flags, reads the same JSONL, emits the same events, and writes a real session `.jsonl` so the transcript reader and `get_session_stats` have something true to read.

Behaviour is declared, not coded: a `Plan` maps task id → claimed state → one `Step` per dispatch of that state. A step can append a section, call a result tool with arguments, answer in prose and call nothing, commit or dirty the worktree, tamper with the assignment, settle with any `stopReason`, repeat a call, compact, take time, die without settling, or corrupt the workspace. Every [issue](settle.md#issues) has a step that produces it.

Tests assert on the graph, on `held_reason`, or on the fragment the agent was prompted with — never on server internals.

## The jigs

`temp-dirs.ts` gives per-test directories kept only on failure; `ports.ts` pure fakes for every port; `orchestrator-jig.ts` a real git repo; `graph-jig.ts` a seeded task directory; `fixture.ts` the whole world plus the `Plan` it runs; `server-jig.ts` a wired server and time.

- `settle` and `until` tick **and** drain, because a tick starts work the next tick observes; asserting after one tick would assert on a half-applied transition
- `deadPid()` spawns and reaps a real process, the only honest way to get a pid that is certainly gone

## Where a test lives

Each decision is tested where it lives ([the slices](architecture.md)): the state machine and the document in `vocabulary/`, settle, ranking and the console's frame in a slice's `policy/`, the pool and reaper over fakes in a slice's `app/`, real git and rpc in its `adapters/`, the wired server against the fake `pi` and the tool surface over a real MCP client in `main/`.

Only an `adapters/` or `main/` suite may touch the filesystem; a suite needing a real repo, task directory or subprocess belongs there. `architecture.test.ts` and `bdd.test.ts` guard the slicing and the test style.

The console is the most-formatted code in the repo and is tested with exact-output tests, which is what lets the drawing code stay free of defensive checks.

## The schema jig

```bash
bun orchestrator/testing/tools-jig.ts --provider <provider> --model <model> [--trials N] [--states ...]
```

This one **does** call a model: per state and scenario it spawns a real `pi` session with that state's extension and prompt, sends a trivial assignment, and reports how often the last call was the right result tool, with the failure modes. The tool for iterating on the wording of the result contract. A model that scores badly is one to restrict with [`roles`](agents.md#roles), not to work around in the server.
