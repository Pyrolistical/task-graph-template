# The inline agent

A second `type` in [`agents.json`](agents.md). `"type": "pi"` spawns `pi --mode rpc` and reads its stream; `"type": "inline"` runs the turn in the server's own process — its own loop, its own tools, its own transcript, no child but the ones its `bash` calls. Both implement `Agents` and `AgentProcess`, so the pool, the dispatcher, the settler, the reaper and the console see one kind of thing.

```text
pi      server ── JSONL rpc ──▶ bwrap ── pi ── tools
inline  server ── a function call ──▶ the loop ── tools ── bwrap (bash only)
```

## Why

What the subprocess costs, in the order it hurts:

- **the tools are pi's.** `abort_bash` aborts only commands the rpc started, so the console's abort on a runaway `bash` has to end the whole turn ([Agents](agents.md#aborting-a-stuck-command)). The fix is three lines in a tool we do not own
- **the stream is pi's, version by version.** `agent_end` is not completion, `agent_settled` is; that table is [verified against 0.83](sandbox.md#reading-the-stream) and is a guess about 0.85
- **the result contract is a file the child loads.** `--extension` is a second module system for four tools, and the child resolves it from inside the sandbox
- **every fact costs a round trip**: what the session path is, what the turn spent, how full the context is
- **the suite carries a whole second program.** `fixture.ts` writes a fake `pi` — flags, JSONL, session files — to say "the agent called `submit`"

In-process, the loop is a value, a tool is a function, the transcript is a list we hold, and a scripted `Models` fake replaces a program.

## What does not move

The port is the seam. Nothing above `agents/ports/agents.ts` learns a new word.

| `AgentProcess`   | pi                        | inline                                    |
| ---------------- | ------------------------- | ----------------------------------------- |
| `pid`            | the child                 | the server's own                          |
| `alive`          | exit code, stdout open    | the run is not finished                   |
| `stream.state`   | parsed out of JSONL       | written by the loop                       |
| `newSession`     | `new_session`+`get_state` | create the file, return its path          |
| `switchSession`  | `switch_session`          | read the file back into the transcript    |
| `prompt`/`steer` | rpc                       | append a message, start or join the loop  |
| `abort`          | rpc `abort`               | cancel the request, kill the running tool |
| `stats`          | `get_session_stats`       | counters the loop already keeps           |
| `close`/`kill`   | end stdin, `SIGKILL`      | **end the run — never a signal**          |

`kill()` is the one place the process metaphor leaks. `Pool.stopSlot` kills when `alive(pid)` answers true, and an inline run's pid is the server's, so `kill()` must mean "abandon this run and kill whatever `bash` child it holds" and must never reach `process.kill`. Pin it with a test that stops an inline run and asserts the server is still ticking.

Reporting the server's pid is right, not a fudge: a claim exists so the reaper can ask whether the thing holding it is gone, and for an inline run the answer is exactly "is that server gone". A restarted server finds its predecessor's pid dead, skips the reattach, releases the claim and re-queues the task — the existing path, unchanged.

## The turn

```text
prompt(message)
  └─ starting()                     stopReason, looping, errors cleared
     └─ loop:
        request ── usage ─▶ onUsage         tokens per assistant message
        ├─ no tool calls            → stopReason, settled, done
        └─ tool calls
           activity = toolCall(name, args)  what the console draws
           execute                          the result tool also raises onResult
           activity = thinking
           append results, repeat           terminate ⇒ settled
```

`agents/domain/protocol.ts` splits in two. The state machine — `starting`, tool started, tool ended, message ended, settled, the repeat counter behind `LOOP_LIMIT` — is `TurnState`, pure domain with no transport in it. `PiStream` keeps the JSONL parsing and feeds the same object. The inline loop calls its methods directly. `StreamState` is then written once and read by everything, which is what makes an inline slot draw in the console with no console change.

Turn end is a value the loop produces rather than an event it waits for, so `stream.settled()` resolves where the loop returns. `stopReason` keeps the five names it has, because [settle](settle.md) reads them.

## The tools

| Tool               | Is                                                                     |
| ------------------ | ---------------------------------------------------------------------- |
| `bash`             | one sandboxed command, timed out, abortable, output truncated          |
| `read`             | a file under the task's runtime directory                              |
| `write` / `edit`   | the same, guarded the same                                             |
| `submit`/`blocked` | the [result tools](assignment.md), one pair per role, as they read now |

Everything else stays a CLI over `bash` — `rg`, `git`, the project's own commands. That is the same direction as the whole design: an agent's interface to the world is a file.

Parameters are zod schemas, parsed and never asserted, like everything else off a wire. `toolCall`/`toolTarget` in [`views/activity.ts`](../orchestrator/views/activity.ts) already turn a name and an argument bag into a row, so an inline tool's arguments must keep the names those functions read: `command` and `path`.

The wording of `submit` and `blocked` is prompt surface and must not fork while both types exist: the strings stay in `result-tools.ts`, the pi extensions keep wrapping them in `defineTool`, and the inline tool set builds its definitions from the same constants.

## Where the sandbox goes

This is what the design actually costs. Today one `bwrap` wraps the whole agent and `--ro-bind / /` is the only boundary there is ([Sandbox](sandbox.md)). In-process, the thing running the tools is the server: it holds the API keys, the task graph and every worktree. The boundary splits in two.

- **`bash` keeps the kernel.** Each call execs the same `systemd-run … choom … bwrap … --chdir <worktree>` line the [checks](checks.md) already exec, with the run's [`write` list](agents.md#write) and `AGENT_OOM_SCORE_ADJUST`. The adapter is `CheckRunner` with an `AbortSignal` and a per-call log
- **the file tools get a function.** `read`, `write` and `edit` run in the server, and their guard is one pure rule: the resolved realpath sits under the task's runtime directory, or the call comes back as a tool error. A refusal is a tool result, not an exception — the agent must be able to read what it did wrong and try again

Two consequences to accept out loud:

1. **a fresh shell per call.** No `cd` carried between calls, no background process outliving one. `cd sub && cmd` answers the first; a server that must outlive a call is a check's job, not an agent's
2. **a file-tool bug now writes where a pi bug could not.** The kernel refused it before; our guard refuses it now. The guard is a total function over strings with a table test, and the `bash` tool — the one that can do real damage — is still the kernel's problem

`~/.pi` drops out of the write list for inline slots, since nothing under it exists to lock.

## Sessions

One JSONL file per task and role, in the same `sessionDir`, one record per message. `newSession` creates it and returns the path, which lands in `workspace.session` exactly as now; `switchSession` reads it back.

A session belongs to the agent type that wrote it. Its first record names the writer, `hasSession` answers false for a file its type cannot read, and a resume candidate is only paired with a slot of that type — the candidate carries it, the way it already carries a role. Skip that and the failure is not silent but it is ugly: `switchSession` throws, the dispatch is logged and rolled back, and the task goes round again into whichever slot wins next.

Everything [Sessions](sessions.md) says about which turns resume and which start fresh is a rule about phases, not about pi, and holds unchanged.

## Cost, tokens and context

Usage arrives on every response, so `stats()` answers from counters instead of a round trip.

- `contextPercent` is tokens over the model's window, and the window comes from the catalog — an entry without one is refused on load, not drawn as 0%
- `costOf` already prefers a reported cost over the wattage meter. An inline agent reports one only if its entry carries `costPerMtokIn`/`costPerMtokOut`; a local model leaves them at zero and keeps [`wattage`](agents.md#wattage-and-costperkwh). One or the other, never both

## Compaction and steering

The loop decides, at the top of each iteration: over the threshold, keep the first user message and the last few exchanges, summarise the middle with the same model, raise the compaction callback. The settler already turns that into a worktree reset for every role but `worker` and a re-steer of the dispatch fragment ([Agents](agents.md#compaction)) — that stays as written.

`steer` is a message appended before the next request. pi's is the same thing with a hop in it: nothing joins a request already in flight.

## Abort, at last in two sizes

- **the turn** — shutdown, a detected loop, a settle that must end. Cancel the request signal, kill the running tool's sandbox, mark it settled. Exactly today's meaning, and [settle](settle.md) needs no change
- **the command** — the console's `slot_abort`. Kill the `bash` child and hand the turn `the operator aborted this command` as that tool's result. The turn keeps its context and carries on: no settle, no `aborted` issue, no re-prompt of a dead command

Ship the first, then move `slot_abort` to the second as its own change — it changes what an operator's button means and it retires an issue with a retry budget attached.

## The provider

A `Models` port with one method: a request with an `AbortSignal`, streamed back. Adapters for the two api families [`health.ts`](../orchestrator/agents/domain/health.ts) already knows how to probe, `anthropic-messages` and `openai-completions`.

Endpoints come from `<task dir>/models.json`, keyed by the `provider` in `agents.json`, so both files sit in the [task directory](task-document.md) and one orchestrator still drives several projects:

```json
{
  "anthropic": {
    "api": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "contextWindow": 200000
  }
}
```

The env var's name, never the key. `unhealthy()` keeps calling `probe()`; only where the base url came from changes, and the pi import in `compose.ts` goes with it.

Retries stay where they are today, both of them. The loop retries a transport failure a few times with the same 1s/2s/4s shape and raises the retry events, so `retrying` keeps meaning what it means; when it gives up, the turn ends with `stopReason: error` and the server's [backoff](agents.md#when-the-provider-is-down) takes over. One policy per scope, and neither is new.

## Where the code goes

| File                                    | Layer    | Is                                                     |
| --------------------------------------- | -------- | ------------------------------------------------------ |
| `agents/domain/turn.ts`                 | domain   | `TurnState`, split out of `protocol.ts`                |
| `agents/domain/transcript.ts`           | domain   | messages, tool calls, the session record schema        |
| `kernel/domain/within.ts`               | domain   | the path guard: is this realpath under that root       |
| `agents/policy/compaction.ts`           | policy   | when to compact, what survives                         |
| `agents/ports/models.ts`                | ports    | `Models`                                               |
| `agents/adapters/inline-agents.ts`      | adapters | `implements Agents`                                    |
| `agents/adapters/inline-run.ts`         | adapters | `implements AgentProcess` — the loop                   |
| `agents/adapters/tools/*.ts`            | adapters | bash, read, write, edit                                |
| `agents/adapters/anthropic-messages.ts` | adapters | `implements Models`                                    |
| `agents/adapters/model-catalog.ts`      | adapters | `models.json`                                          |
| `agents/adapters/agents-by-type.ts`     | adapters | routes `spawn`/`unhealthy`/`hasSession` on `slot.type` |

The router is what lets both types run in one pool, and `compose.ts` is the only module holding both halves — the shape [the slices](architecture.md) already require. `type` stops being a free string in `slots.ts` and becomes an enum, because a pool naming a type nothing can spawn should fail on load, not on the tenth dispatch.

## Testing

The `Plan` vocabulary in `fixture.ts` — append a section, call a result tool, dirty the worktree, settle with a `stopReason`, repeat a call, compact, take time, die — describes what an agent does, not how it is spawned. Against an inline slot, a step becomes a scripted `Models` response instead of a line the fake `pi` prints, so the [behaviour suite](bdd-tests.md) runs unchanged against either type, and the fake `pi` stays only as long as `type: "pi"` does.

`tools-jig.ts` is the exception that must be duplicated rather than shared: it exists to call a real model, and the inline version calls it through the adapter instead of through a spawned session.

## What is lost

1. **Detaching.** Agents outlive the manager today, and a new server reattaches by pid ([Server](server.md#detaching)). An inline run dies with its server. What survives is everything on disk — worktree, branch, commits, session, assignment — so the next start reaps the claim and re-dispatches, and a `WORK` task resumes with its context. What is lost is the turn that was in flight
2. **The blast radius.** pi ran under its own `MemoryMax=8G`; the loop now runs in the server's memory. Transcripts are small and `bash` still gets its own scope, so what is really given up is the guarantee
3. **Provider breadth.** pi speaks every api in its catalog; the inline agent speaks what its adapters speak
4. **Free improvements.** A pinned dependency was doing work for us

If (1) is the one that matters, the escape hatch is in the design already: the loop names no transport, so a `main/agent.ts` can host it in a child process speaking rpc — the same modules, one adapter more, and nothing above the port changes again.

## Rejected

- **fork pi and patch `abort_bash`.** Fixes the symptom, keeps the stream, the extension loading, the round trips and the second program in the suite
- **our own agent as a child process.** Keeps detaching and the whole-process sandbox, and gives up exactly what in-process is for. It is the escape hatch, not the plan
- **tools over MCP into the server.** An agent talking to the graph's own process, which [authority](authority.md) forbids in one line
- **one persistent sandboxed shell per run.** Restores `cd` and background processes, and costs a hand-rolled sentinel protocol over an interactive `bash`: output framing, exit codes, timeouts and abort, all ours. Revisit if an agent ever genuinely needs a process to outlive a tool call
