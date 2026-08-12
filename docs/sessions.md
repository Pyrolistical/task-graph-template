# Sessions

A session belongs to a task **and a role**. A slot is a concurrency unit running one process at a time; a session is a conversation that outlives the process, because `pi` writes it to disk as it goes.

## Why rpc mode

A `pi` process in `--mode rpc` is a long-lived server on stdin/stdout: it emits `agent_settled` and waits instead of exiting, so the server can ask questions after the fact (`get_session_stats`), interrupt (`abort`) and follow up (`prompt`) without respawning. A resume is the same process type pointed at an existing session file with `switch_session`.

- the session path comes from `get_state` after `new_session` and is recorded in `workspace.session`; without it a resume cannot be found after a manager restart
- the process starts **before** the claim, so the claim records the agent's real pid and the reaper has the right pid to test

## Roles never share a session

One directory per role; all three review phases share `session/reviewer`, since the role owns the directory and the phase names the files.

A worker's session holds every rationalisation it built while convincing itself the work was done — the shortcut it decided was acceptable, the test it decided was flaky, the edge case it decided was out of scope. A reviewer inheriting that context inherits the conclusions and agrees. The review's whole value is an independent read of the commits against the criteria by something that was not there, so a reviewer gets the worktree, the commit range, the goal, the criteria and the passing checks — not the author's notes or reasoning.

In reverse, a rejected task starts fresh: the context worth keeping is already distilled into the design, todos or findings, and the rest is what produced the rejection.

`workspace.session` records the **work** session only, since `WORK` is the only state a resume targets. Otherwise the following review would own the field and a worker sent back by a finding would switch into the reviewer's session — the review of its own work, exactly what the split denies it.

## Resume only within the same submit cycle

A failed check is seconds after the work, so the agent still holds every reason for its choices: `switch_session`, assignment carried forward with its notes, failures already in the session as the first prompt, at the scheduler's top rank. `runner.checkout.dispatched` is re-based on the carried file so the append-only check still holds.

A review rejection is minutes or hours later, after the work was restructured: fresh session, assignment regenerated from the body, findings arriving as the dispatch prompt. Same for a resume out of a held state.

Everything else — no result, nothing appended, blocked, a modified assignment, a provider error — is a `prompt` into a live process that still holds the session, and a compaction is a `steer` into the turn in flight.

- an unreadable result is not reset: the agent needs to see the call it made in order to fix it, and the fragment quotes what came back
- a check-failed resume cannot carry a stale submit: the result is a call in the stream and a fresh process starts with an empty call record, so the agent must call `submit` again — nothing is cleared because nothing persists
- the server only ever writes a session's files between turns, and only what the agent was not allowed to write
