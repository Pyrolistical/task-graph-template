# Spawning pi and the sandbox

## The command line

```
pi --mode rpc \
   --provider  <agent.provider> \
   --model     <agent.model> \
   --session-dir /tmp/task-graph-server/<repo>/000042/session/worker \
   --name      "000042 worker" \
   --approve \
   --extension /path/to/task-graph-template/orchestrator/result-tools-worker.ts
```

- no `-p` and no positional message. `--mode rpc` is a run mode, not an output mode: the process reads commands from stdin until stdin closes, and the work is requested with a `prompt` command.
- there is no `--cwd`. The working directory is set at spawn, as `--chdir <workspace>` on the sandbox around it.
- there is no system prompt flag. `pi`'s own default stands, and the role arrives as the first `prompt` command: the **claimed state's** file, whole — `prompts/DESIGN.md`, `prompts/DESIGN_REVIEW.md`, `prompts/PLAN.md`, `prompts/PLAN_REVIEW.md`, `prompts/WORK.md` or `prompts/WORK_REVIEW.md`. The server reads it, so the child never opens it.
- the extension is the claimed state's too, chosen through the stage table's `tools`. The path is absolute and points into the orchestrator's own checkout, because the child's cwd is the worktree and the extensions do not live in the driven repo.
- that first prompt stays short on purpose. The work lives in `ASSIGNMENT.md`, where it can be re-read after compaction; a brief pasted into the conversation cannot be re-read once it scrolls out.
- `pi` has no MCP client — the project rejects MCP by design and expects agents to drive CLI tools over bash. That and the manager-owns-the-graph rule point the same way: the agent's interface to the outside world is a file, not a tool.
- spawn detached, tee stdout to `/tmp/task-graph-server/<repo>/000042/agent-rpc.jsonl`, appending. Every process that ever ran against this task writes to that one file, in order, so the record of an assignment that took four attempts across four roles reads as one stream.

## The sandbox

Every process the server spawns — agents and checks alike — is wrapped in a cgroup scope, an oom score, and `bwrap`:

```
systemd-run --user --scope --quiet --collect \
      -p MemoryMax=8G -p MemorySwapMax=0 -p TasksMax=512 -- \
choom -n <300 agent | 400 check> -- \
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
      --ro-bind <repo> <repo> \
      --ro-bind <orchestrator> <orchestrator> \
      --overlay-src ~/.cache --tmp-overlay ~/.cache \
      --overlay-src ~/.pi --tmp-overlay ~/.pi \
      --bind  /tmp/task-graph-server/<repo>/000042 \
              /tmp/task-graph-server/<repo>/000042 \
      --setenv GIT_EDITOR true --setenv EDITOR true --setenv VISUAL true \
      --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session \
      --chdir <workspace> -- pi --mode rpc …
```

### What is readable and what is writable

- `--ro-bind / /` is recursive, so everything an agent needs to read stays readable — toolchains under `/usr/local`, the extensions in the orchestrator's own checkout — and everything not named below is unwritable. `--approve` auto-approves every tool call, so this is the only boundary there is.
- the repo is re-bound read-only **after** `--tmpfs /tmp`, because a repo can sit under `/tmp`. The orchestrator's own checkout is re-bound for the same reason and only for agents: `pi` loads the result-tools extension from inside the sandbox, and a checkout under `/tmp` would otherwise be behind the tmpfs. A check loads no extension, so it does not get that bind.
- the bound-writable set is one directory: the task's own runtime directory. That is the workspace, `ASSIGNMENT.md` and the session files — not the repo, not another task's directory, not the views, not the manager's home.
- `/tmp` is a private tmpfs, so whatever an agent or a check scribbles there goes when the process does.

### The overlays

- everything else an agent may write to is declared, not hardcoded: the `write` array on its [`agents.json` entry](agents.md#what-an-agent-may-write), each path mounted as a throwaway overlay. Reads see the host, writes land in an upper layer that is discarded with the sandbox.
- `~/.pi` is added to that list for any agent of type `pi`, declared or not. `pi` takes a lock under it at startup; reads see the real settings and writes are discarded, so an agent cannot edit the settings of the next one.
- `~/.cache` is the default `write` entry, and its purpose is zig. A build tool keeps a cache outside the workspace — `zig` under `~/.cache/zig`, and cargo, go and npm under their own — and a read-only one is not a slow build but a hard failure: `zig build` cannot even compile `build.zig` and dies with `manifest_create ReadOnlyFileSystem`, which reads like a compile error and sends an agent hunting through its own diff. The overlay keeps the host's warm cache readable, so a build is not paying to rebuild the standard library, while every entry the task writes is discarded with the sandbox.
- a check has no agent, so it gets no `~/.pi` and runs with the union of the `write` paths declared across the pool — a check runs the same build the agent just ran, and would hit the same read-only cache.

### The editor variables

- `GIT_EDITOR`, `EDITOR` and `VISUAL` are all forced to `true`, the command that does nothing and succeeds
- an agent that runs `git commit` without `-m` otherwise gets whatever editor the host has configured
- an editor waiting for input on a stdin the agent is not driving is a wedge with no timeout behind it: the slot is held, the rpc stream is silent, and the only evidence is a `nvim …/COMMIT_EDITMSG` under the workspace
- with the no-op editor the same command fails in under a second with `Aborting commit due to empty commit message`, which the agent can read and correct
- the same applies to `git rebase -i` and to any tool that reaches for `$EDITOR`

### The namespaces

- no `--unshare-net`. Calling a provider is the whole job, and a network namespace has nothing but loopback — a fresh one, so even a llama.cpp server on `127.0.0.1` is unreachable from inside it.
- no `--die-with-parent`. Agents outlive the manager on purpose; tying the sandbox to its parent would undo `detach`.
- `bwrap` stays as the parent of what it spawns, which is what keeps the process bookkeeping honest: the recorded pid is a `bwrap` owned by the server's own user, so `kill(pid, 0)` still answers "is this agent alive" and `kill` still stops it. Because that `bwrap` is pid 1 of the namespace, the tool subprocesses an agent left behind die with it instead of leaking. Both wrappers `exec` in place rather than forking, so the recorded pid is still the `bwrap` and none of that bookkeeping changes.

### Why cgroups, not just bwrap

- `bwrap` is not a resource limit. It gives namespaces, bind mounts and seccomp, and has no notion of how much memory or how many processes live inside it — `--unshare-pid` isolates the pid namespace but puts no bound on what may be spawned in it.
- a check that fork-bombs took the host down once: `zig build spec-test` re-entered its own parent branch in every child and reached at least 6337 live processes and 36G of rss, and because nothing was scoped the kernel's `global_oom` reaped a llama.cpp server, `dbus-broker` and the user's own `systemd` before it got to the agent.
- the cap therefore comes from cgroup v2, which is a property of the scope and not of the sandbox. Every spawn gets its own transient scope, so a runaway task is contained to itself and the other slots keep running.
- `TasksMax` is what actually stops a fork bomb, and cheaply — it dies at process 512 rather than at 50000.
- `MemoryMax` contains it too, but by triggering a cgroup oom that kills inside the scope instead of letting the kernel choose victims across the machine.
- `MemorySwapMax=0` matters as much as either: thrashing swap is what makes the host unresponsive well before anything is killed.
- `--collect` so a scope whose process died is garbage collected rather than left behind as a failed unit.
- `OOMScoreAdjust` is an exec property and a scope has no exec context, so systemd rejects it outright — `Unknown assignment: OOMScoreAdjust=300`. `choom` sets it instead, and because `oom_score_adj` is inherited across both `fork` and `exec` it reaches every descendant inside the sandbox. Checks sit above agents (400 against 300) because a check is the more disposable of the two, and both sit well above anything of the user's, so the kernel takes a task apart before it takes the session apart.
- if `systemd-run` is missing, or the host has no cgroup delegation, the server warns once at startup and spawns bare `bwrap`. The isolation is unchanged; only the limits are gone.

## The command channel

- commands are JSONL on stdin, one object per line, `\n` only
- every command may carry an `id`, and the matching `{"type":"response","id":…,"success":…}` comes back on stdout
- split stdout on `\n` alone — Node's `readline` also splits on U+2028/U+2029 and will corrupt a stream containing them

| Command                          | Used for                                         |
| -------------------------------- | ------------------------------------------------ |
| `new_session` / `switch_session` | start an assignment, or reopen one for a resume  |
| `prompt`                         | the dispatch message, and every fragment         |
| `steer`                          | re-dispatch after a compaction, mid-turn         |
| `abort_bash`                     | the console's `[abort]`: one command, not a turn |
| `abort`                          | shutdown, and a detected loop                    |
| `get_state`                      | the session file path, right after `new_session` |
| `get_session_stats`              | tokens and context percent for `slots.json`      |
| `get_last_assistant_text`        | the agent's closing words, for the log           |

## Reading the stream

Verified against pi 0.83.0:

| Signal             | Value                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| completion         | `agent_settled` — the only event meaning "pi will not continue"                                 |
| **not** completion | `agent_end` — fires once per attempt; a failing run emitted four, three with `willRetry: true`  |
| outcome            | `stopReason` on the final assistant message: `stop`, `length`, `toolUse`, `error`, `aborted`    |
| error text         | `errorMessage` on that same message                                                             |
| progress           | `tool_execution_start` / `tool_execution_end` (`isError`)                                       |
| result             | `tool_execution_start` on the `submit*` / `blocked` tools — name and args, the last one settles |
| trouble            | `auto_retry_start` (`attempt`, `maxAttempts`), `compaction_start` (`reason: "overflow"`)        |

- treating `agent_end` as "the agent finished" is the mistake this design is most likely to make
- `willRetry` is the field that distinguishes them, and `agent_settled` is the one to wait on
- the exit code is no help at all — in rpc mode the process outlives the turn
