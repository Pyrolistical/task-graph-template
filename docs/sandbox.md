# Spawning pi and the sandbox

```text
systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p TasksMax=512 -- \
choom -n <300 agent | 400 check> -- \
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
      --ro-bind <repo> <repo> --ro-bind <orchestrator> <orchestrator> \
      --overlay-src <each write path> --tmp-overlay <each write path> \
      --bind <runtime dir>/<id> <runtime dir>/<id> \
      --setenv GIT_EDITOR true --setenv EDITOR true --setenv VISUAL true \
      --unshare-user --unshare-pid --unshare-ipc --unshare-uts --new-session \
      --chdir <worktree> -- pi --mode rpc --provider … --model … \
        --session-dir … --name "<id> <role>" --approve --extension <state tools>
```

## The command line

- `--mode rpc` is a run mode, not an output mode: no `-p`, no positional message; the process reads stdin until it closes and work is requested with `prompt` ([Sessions](sessions.md#why-rpc-mode))
- no `--cwd`: the working directory is the sandbox's `--chdir`
- no system prompt: the role arrives as the first `prompt`, the claimed state's [prompt file](prompts.md), whole, read by the server so the child never opens it
- the extension is the claimed state's too, absolute into the orchestrator checkout because the child's cwd is the worktree
- the first prompt stays short: the work lives in `ASSIGNMENT.md`, which survives compaction, while a pasted brief does not
- `pi` has no MCP client — the project expects CLI tools over bash, which is the same direction as manager-owns-the-graph: the agent's interface to the world is a file
- spawned detached; stdout is parsed into records as it arrives and nothing else keeps it

## Readable vs writable

`--ro-bind / /` is recursive: everything readable stays readable, everything not named below is unwritable. With `--approve` auto-approving every tool call, this is the only boundary there is.

- the bound-writable set is one directory, the task's runtime directory: worktree, `ASSIGNMENT.md`, sessions. Not the repo, not another task, not the views, not the manager's home
- the repo is re-bound read-only **after** `--tmpfs /tmp`, because a repo can sit under `/tmp`; the orchestrator checkout likewise, for agents only, since `pi` loads the extension from inside the sandbox and a check loads none
- `/tmp` is a private tmpfs, so scribbles go with the process
- everything else writable is the declared [`write` list](agents.md#write), each path a throwaway overlay: reads see the host, writes land in an upper layer discarded with the sandbox
- `~/.pi` is overlaid for any `pi` agent whether declared or not: `pi` locks under it at startup, and discarding writes stops one agent editing the next one's settings
- read-only `~/.cache` is not a slow build but a hard failure — `zig build` dies with `manifest_create ReadOnlyFileSystem`, which reads like a compile error and sends an agent hunting through its own diff. The overlay keeps the host's warm cache readable
- a check gets no `~/.pi` and the union of `write` across the pool, since it runs the same build the agent just ran

## The editor variables

`GIT_EDITOR`, `EDITOR` and `VISUAL` are `true`, the no-op. Otherwise `git commit` with no `-m` opens the host editor on a stdin nobody drives: a wedge with no timeout, a held slot, a silent stream. With the no-op it fails in under a second with a message the agent can read and correct.

## The namespaces

- no `--unshare-net`: calling a provider is the whole job, and a fresh net namespace has only loopback — even llama.cpp on `127.0.0.1` would be unreachable
- no `--die-with-parent`: agents outlive the manager on purpose ([detaching](server.md#detaching))
- `bwrap` stays the parent of what it spawns and both wrappers `exec` in place, so the recorded pid is a `bwrap` owned by the server's user — `kill(pid, 0)` answers liveness, `kill` stops it, and because it is pid 1 of the namespace leftover tool subprocesses die with it instead of leaking

## Why cgroups as well

`bwrap` is namespaces, mounts and seccomp — not a resource limit; `--unshare-pid` bounds nothing inside the namespace. A fork-bombing check reached 6337 processes and 36G rss, and the kernel's global oom reaped a llama.cpp server, `dbus-broker` and the user's `systemd` before it got to the agent.

- one transient cgroup v2 scope per spawn contains a runaway to itself
- `TasksMax` is what actually stops a fork bomb, dying at process 512 rather than 50000
- `MemoryMax` triggers a cgroup oom that kills inside the scope instead of letting the kernel pick victims machine-wide, and `MemorySwapMax=0` matters as much — swap thrashing makes the host unresponsive before anything is killed
- `OOMScoreAdjust` is an exec property a scope rejects, so `choom` sets it; it is inherited across `fork` and `exec`, reaching every descendant. Checks score above agents because a check is more disposable, both far above the user's own processes
- no `systemd-run` or no cgroup delegation: warn once at startup and spawn bare `bwrap` — isolation unchanged, limits gone

## The command channel

JSONL on stdin, one object per line, `\n` only; a command may carry an `id` and gets a `response` back on stdout. Split stdout on `\n` alone — Node's `readline` also splits U+2028/U+2029 and would corrupt such a stream.

Commands used: `new_session`/`switch_session`, `prompt`, `steer` (re-dispatch after a compaction, mid-turn), `abort_bash` (the console's abort: one command, not a turn), `abort` (shutdown, and a detected loop), `get_state` (the session path), `get_session_stats` (tokens and context percent), `get_last_assistant_text`.

## Reading the stream

Verified against pi 0.83.0.

| Signal             | Value                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| completion         | `agent_settled` — the only event meaning "pi will not continue"               |
| **not** completion | `agent_end` — once per attempt; a failing run emitted four, three `willRetry` |
| outcome            | `stopReason` on the final assistant message, `errorMessage` beside it         |
| progress           | `tool_execution_start` / `tool_execution_end`                                 |
| result             | `tool_execution_start` on `submit`/`blocked`; the last one settles            |
| trouble            | `auto_retry_start`, `compaction_start`                                        |

Treating `agent_end` as "finished" is the mistake this design is most likely to make. The exit code is useless: in rpc mode the process outlives the turn.
