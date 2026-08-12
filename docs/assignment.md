# ASSIGNMENT.md

The entire interface between an agent and the project: the task body verbatim plus the empty heading of the section this role writes. No frontmatter, no title, no role prose — rules of engagement are the [dispatch prompt](prompts.md).

body → assignment → accepted assignment → body: the graph and the agent read and write the same text.

## Append-only

The server appends the section heading at dispatch, so the agent never spells a heading itself; reviewers append nothing. At settle the server compares the live file to what it dispatched:

- `live.startsWith(dispatched)` is an append and passes
- anything else is repaired, not argued about: everything above the agent's own heading is restored, what it wrote under that heading is kept, and it is told (`modified-assignment`) so it can check its work still answers the assignment
- a missing append is told the same way

What remains for the agent to answer is only what the server cannot know: whether the work is done.

## The result is a tool call, not a file edit

Every session loads a terminating result tool (`terminate: true`) registered by the state's [pi extension](prompts.md). One extension per **state**, so the name is always `submit` while the schema is the one shape that state accepts: no arguments for author roles, `findings: string[]` for reviewers, plus `blocked(message)` everywhere.

- every argument required and no others accepted, so a shape that does not fit the state never reaches the server; `pi` hands a schema failure back inside the same turn, where the agent still has everything it needs to call again
- prose has no way to send a result, which removes the register problem a written result would have
- `findings` empty approves; non-empty sends the task back to the author state. `message` becomes `held_reason` verbatim
- no result call at all is `missing-result` — retried, then held ([Settle](settle.md))

## Findings vs the message queue

`findings.json` holds review findings from any phase: they replace the next dispatch prompt for the stage they were sent back to, survive compaction and restart, are overwritten by a later rejection so an agent answers only the latest review, and are cleared when that stage submits.

Failing checks go to `messages/<STATE>.md` instead, delivered as one prompt at the next dispatch of that state. A queued message is what makes a task resumable at all: findings regenerate the file and start a fresh session; a failed check reopens the one that produced it.

Nothing in either is ever written to the task document.

## Rotation

The server writes `ASSIGNMENT.md` exactly once per dispatch and never again — not even to record a failed check. Anything mid-run goes through the session as a `prompt` and the agent folds it into its own notes, so there is one writer per file at all times and notes cannot be clobbered mid-thought.

Each generating dispatch first rotates the previous file into `history/ASSIGNMENT.<n>.md`, so nothing an agent wrote is overwritten and the manager sees every attempt. A resume reopens the same file and rotates nothing.

Rotation is also the role handoff: a reviewer carries the previous role's file forward rather than regenerating it, so it reads the section just appended. The file is regenerated from the task body only at a fresh designer, planner or worker dispatch.

## The graph is not in the worktree

The graph lives outside the repo, so an agent cannot read it, stale or otherwise. `ASSIGNMENT.md` is therefore the only statement of what the task is, and no prompt has to argue an agent out of consulting the graph.
