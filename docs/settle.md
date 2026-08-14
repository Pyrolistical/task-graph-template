# Settling an agent

Everything the server does to a task in a role stage comes out of this path ([`tasks/policy/settle.ts`](../orchestrator/tasks/tasks/policy/settle.ts)).

Two inputs, not interchangeable: the **event stream** says how the turn ended and carries the result tool calls; **`ASSIGNMENT.md` on disk** says what the agent believes it accomplished. The file is only worth reading once the stream says the turn settled, because a run whose every attempt failed still fires `agent_end` per attempt ([reading the stream](sandbox.md#reading-the-stream)).

By outcome:

| Turn ended with                                                           | Server does                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| provider error                                                            | back off, re-prompt the same session ([outages](agents.md#when-the-provider-is-down)) |
| aborted, no command recorded (shutdown)                                   | close stdin, release the slot                                                         |
| aborted on a command ([`slot_abort`](agents.md#aborting-a-stuck-command)) | raise `aborted`                                                                       |
| `length`, or no result call                                               | raise `missing-result`                                                                |
| `blocked`                                                                 | raise `blocked`                                                                       |
| `submit`                                                                  | the checks below, then apply                                                          |

Then, in order: the stage's section must have been appended; nothing above it may have changed; the stage's worktree guard must hold; non-empty findings are feedback back to the author state; otherwise `submit`, handing the assignment in as the new body where the stage says so. A wrong-shaped result never reaches here — `pi` refuses it in-session against the schema.

A `length` or resultless outcome keeps the branch, so the next attempt starts from the partial work rather than the base.

## Issues

Every way a settle can be wrong is a **named issue** with its own [fragment](prompts.md) and attempt budget ([`prompts/domain/issues.ts`](../orchestrator/prompts/prompts/domain/issues.ts)). Raising one prompts the live session with that fragment; the attempt after the last is a `hold` naming the issue. Attempts are counted per issue per dispatch.

- **4** for the ordinary recoverable ones: a retry costs one turn against a session that already holds the whole task, and the alternative costs a person
- **8** for `missing-result`: the work is done and only the reporting call is missing, the causes are what a nudge clears (prose instead of a call, exhausted context, aborted turn), and a compaction between attempts changes the conditions
- **3** for `aborted`: nothing was broken by the agent, so the fragment names the dead command and nothing else; a third abort in one dispatch is a person deciding the same thing three times, which is a hold
- **1** for `blocked`: it is a stated outcome, not a failure. The second look catches only resolvable confusion; a third would argue with the answer
- one fragment per issue whatever state it fires from, since the words do not depend on the state; `modified-assignment` is per state because each names the section that state may append
- named so the log says which issue and how many attempts are gone, `held_reason` says which won, and each fragment is rewritable without a server diff

`looping` is the only issue not raised from a settle, because the agent it catches never settles: ten identical tool calls in a row — same tool, same args, byte for byte, consecutive, within one turn — and the stream flags it, the process aborts the turn, and the resulting settle raises it. Across turns is an agent checking its work, and any other call restarts the count; ten because a handful is a retry and a screenful is an agent that stopped reading. The fragment corrects nothing — the answer is not in that command's output and the cause may be the environment rather than the diff — it offers the two ways out: try something else, or send `blocked` with what the wall is. Handing straight to a person would throw away a session holding the whole task and hand over "it kept running `zig build`" instead of a one-line blocker. 3 attempts, because each costs ten tool calls to reach.

## A submit has to be in the git history

`uncommitted` and `modified-worktree` are the same check inverted: designer, planner and their reviewers must leave the worktree as found, a worker must have committed. Two cheap facts before `submit` applies: `git status --porcelain` empty, and at least one commit over the base.

Not a judgement, hence the server's: everything downstream is a commit range — checks run in the workspace, the reviewer gets the range, the merge is a fast-forward. A dirty submit hands all three the wrong thing: checks pass against files nobody sees again, the reviewer reads an empty diff, the work goes when the worktree does. `ASSIGNMENT.md` is outside the tree, so anything `git status` reports is real work left behind, untracked files included; unignored build output showing up here is fixed by a project `.gitignore`, not a looser check.

The fragment quotes the first `git status` entries into the session that still holds every reason the agent had, so the usual outcome is one `git commit` and a second `submit`. The prompt already said to commit as you go; the check exists because that is an instruction and a fast-forward needs a fact.

## Applying a work review

Empty findings submit to `MANAGER_REVIEW`; otherwise feedback appends them to the body under `# Review findings` with a fresh `## Implementation Notes` heading and queues them to the worker — and the [second consecutive rejection holds instead](states.md#reviews-are-split-in-two).
