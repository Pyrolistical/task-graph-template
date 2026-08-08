# Sessions

Sessions belong to a task **and a role**.

- a slot is a concurrency unit that runs one process at a time
- a session is a conversation that outlives the process holding it, because `pi` writes it to disk as it goes

## Why rpc mode

- in rpc mode a `pi` process is a long-lived server on stdin/stdout
- it does not exit when the agent finishes — it emits `agent_settled` and waits
- that is the whole reason for rpc over `--mode json`: the server can ask questions after the fact (`get_session_stats`), interrupt (`abort`), and follow up (`prompt`) without respawning anything

An assignment is therefore a conversation with a process, not a command line:

```jsonl
→ {"id":"1","type":"new_session"}
← {"id":"1","type":"response","command":"new_session","success":true,"data":{"cancelled":false}}
→ {"id":"2","type":"prompt","message":"Read ASSIGNMENT.md at <path> and do the work it describes."}
← {"id":"2","type":"response","command":"prompt","success":true}
← {"type":"agent_start"} … {"type":"tool_execution_start", …} … {"type":"agent_end","willRetry":false}
← {"type":"agent_settled"}
→ {"id":"3","type":"get_session_stats"}
```

A resume is the same process type pointed at an existing session file:

```jsonl
→ {"id":"1","type":"switch_session","sessionPath":"<workspace.session>"}
→ {"id":"2","type":"prompt","message":"<the fragment rendered from failures>"}
```

- the session path comes out of `get_state` after `new_session` and is recorded in `workspace.session`
- without it a resume cannot be found after a manager restart
- `workspace.session` is the **work** session and nothing else: only a claim into `WORK` writes it, and a claim into any other state leaves the one already recorded alone
- there is one field because `WORK` is the only state a resume targets — a reviewer, designer or planner session is never reopened, so recording it would only overwrite the one that is
- without that rule the review that follows the work owns the field, and the worker sent back by a finding switches into the reviewer's session — the review of its own work, which is exactly the context the split below exists to deny it
- the process is started **before** the claim: it has a pid the moment it exists, so the claim records the agent's real pid rather than the supervisor's, and the reaper, which requires a dead pid, has the right one to test

## Roles never share a session

Session directories are per role: `session/worker`, `session/reviewer`, `session/planner`, `session/designer`.

- a reviewer is given a new session that has never seen the worker's
- a designer or planner one that has never seen either
- a design review runs in `session/reviewer` like a plan review and a work review do — the role owns the session directory, the phase names the files inside it
- a re-design is always a fresh `designer` session and a re-plan a fresh `planner` session, because the previous attempt's reasoning is exactly what the review rejected

This is not tidiness:

- a worker's session contains every rationalisation it built while convincing itself the work was done — the shortcut it decided was acceptable, the test it decided was flaky, the edge case it decided was out of scope
- a reviewer that inherits that context inherits the conclusions with it, and agrees
- the entire value of the review is that it is an independent read of the commits against the acceptance criteria by something that was not there

So the reviewer gets:

- the worktree, the commit range, the goal, the acceptance criteria and the checks that passed
- **not** the worker's notes, and not the reasoning behind them

The same applies in reverse:

- a rejected task starts a fresh session rather than switching back
- by the time review comes back, the context worth keeping has been distilled into todos, and the context not worth keeping is the part that produced the rejection

## Resume only within the same submit cycle

- a failed check is seconds after the work — the agent still holds every reason it made its choices, and re-reading the assignment from scratch would waste all of it
- a review rejection is minutes or hours later, after todos have been restructured; that gets a fresh session and a regenerated file

| Trigger                                       | Session          | `ASSIGNMENT.md`                                                                                                |
| --------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| first dispatch                                | `new_session`    | generated from the task body                                                                                   |
| plan review rejected                          | `new_session`    | regenerated; the findings arrive as the dispatch prompt                                                        |
| check failed                                  | `switch_session` | carried forward, with the worker's notes                                                                       |
| settled without a result                      | `prompt` in situ | untouched                                                                                                      |
| appended nothing                              | `prompt` in situ | untouched                                                                                                      |
| came back blocked                             | `prompt` in situ | untouched                                                                                                      |
| assignment changed above the appended section | `prompt` in situ | restored by the server above the agent's heading                                                               |
| work review rejected                          | `new_session`    | regenerated from the body, which now carries `# Review findings` and a fresh `## Implementation Notes` heading |
| manager review rejected                       | `new_session`    | regenerated the same way                                                                                       |
| resumed out of a held state                   | `new_session`    | regenerated                                                                                                    |
| provider error                                | `prompt` in situ | untouched                                                                                                      |
| context overflow compaction                   | `steer` in situ  | untouched — it is what the steer points the agent back at                                                      |

- the `in situ` rows are the ones where the process is still alive and still holds the session — nothing needs switching
- only a resume arriving after the slot was released has to reopen the file
- a check-failed resume cannot carry a stale submit: the result is the tool call in the stream, and a fresh process starts with an empty call record, so the agent must call `submit` again — the fragment tells it exactly that. Nothing is cleared because nothing persists.
- an unreadable result is **not** reset either: the agent needs to see the call it made in order to fix it, and the fragment quotes the contract issues that came back
- the divergence row is the only one where the file changes without the agent being told. It is safe for the same reason the check-failed clear is: the server is writing between two of the agent's turns, and the fields it touches are ones the agent was never allowed to write.

## Resuming a failed check

- a failed check is the only thing a resume is for: it is the only thing that queues an entry, and an unclaimed `WORK` with a live session and a queued entry is the whole resumable test
- a review rejection queues nothing — it writes `findings.json` — so it is dispatched fresh, which is the rule this file argues for above
- a failed check returns the task to `WORK`, and the scheduler's top rank is the resume
- the same session is reopened, the same branch and worktree
- the queued failures are already in the session as the first prompt
- the assignment is not regenerated — the worker's file, with its appended notes, is carried forward
- `worker.checkout.dispatched` is re-based on it, so the append-only check still holds for the round that follows
