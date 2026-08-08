# ASSIGNMENT.md

`ASSIGNMENT.md` is the entire interface between an agent and the project.

- the server generates it at dispatch; the agent owns it from that moment until it settles
- it is the task body, verbatim, plus the empty heading of the section this role is to write — nothing else
- no frontmatter, no title, no role prose
- the task document's body is the assignment, and the assignment becomes the task document's body again when the work is accepted: the graph and the agent read and write the same text
- the rules of engagement — what goes in that section, and how the turn ends — live entirely in the role's [dispatch prompt](prompts.md)

## Append-only

The server appends the section heading at dispatch, so the agent never writes a heading of its own and never has to guess its spelling; it writes under the one already at the end of the file.

| Role          | Section                   | What goes there                                                                                                                              |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **designer**  | `## Design`               | the overall structure of the work and how it fits into the project — architecture, refactorings, modules and files; no step-by-step detail   |
| **planner**   | `## Todos`                | a numbered list (`1.` to `n.`, consecutively), each entry specific and verifiable enough for a worker to execute without the planner present |
| **worker**    | `## Implementation Notes` | every todo answered by number — the change, the commit, and how it saw the work                                                              |
| **reviewers** | none                      | they append nothing at all                                                                                                                   |

At settle the server compares the file to what it dispatched:

- `live.startsWith(dispatched)` is an append and passes
- anything else is a divergence, and the server repairs it rather than arguing about it:
  - everything above the agent's own heading goes back to what was dispatched
  - what the agent wrote under that heading is kept
  - the agent is told (`modified-assignment`) so it can check its work still answers the assignment it was actually given
- a missing append is told the same way (`missing-todos`, `missing-design`, `missing-notes`) and the agent writes it
- what is left for the agent to answer is only what the server genuinely cannot know: whether the work is done

## The result

The result is not a file edit.

- every session is loaded with a terminating result tool — `submit`, or `blocked` when the one thing standing in the way is a wall
- the call ends the turn
- there is one extension per _state_, so the same `submit` name works everywhere while the schema the model sees is the one shape that state accepts
- six result types, one per role-phase pair, sharing the `blocked` arm

| Tool      | Arguments                                | Result                       | States                                        |
| --------- | ---------------------------------------- | ---------------------------- | --------------------------------------------- |
| `submit`  | none (designer/planner/worker extension) | `{type: "submit"}`           | `DESIGN`, `PLAN`, `WORK`                      |
| `submit`  | `findings: string[]` (any review)        | `{type: "submit", findings}` | `DESIGN_REVIEW`, `PLAN_REVIEW`, `WORK_REVIEW` |
| `blocked` | `message: string`                        | `{type: "blocked", message}` | every state                                   |

- each tool returns `terminate: true`, so the call ends the turn on the spot
- the result is a tool call, not prose — there is nothing to mis-parse on the way out
- every argument is required and no others are accepted, so a shape that does not fit the state never reaches the server
- `pi` validates the call against the tool's schema before the tool runs and hands the failure back to the agent as a tool error, inside the same turn
- a stage that writes and a stage that reviews carry different shapes, and each extension declares only its own

What each field means:

- **`findings`** on a design review — the gaps between the design and the acceptance criteria, plus any way the design is missing or proposes no structure. Each goes to `findings.json`, verbatim, and comes back as the designer's next dispatch prompt; the task goes back to `DESIGN`. An empty list approves the design.
- **`findings`** on a plan review — the gaps between the plan and the acceptance criteria, plus any way the list is missing or misnumbered. Each goes to `findings.json`, verbatim, and comes back as the planner's next dispatch prompt; the task goes back to `PLAN`. An empty list approves the plan.
- **`findings`** on a work review — defects in _this_ work. Each goes to `findings.json` and is appended to the task body under `# Review findings`, verbatim, and comes back as the worker's next dispatch prompt. The task goes back to `WORK`. An empty list is the reviewer saying it is satisfied.
- **`message`** on a `blocked` result — required, and becomes `held_reason` verbatim.

Findings are held to a standard about **description, not instruction**:

- name the symbol, the file and the input that breaks it, say what goes wrong, and stop
- a reviewer that writes "use a Map here" has skipped the part only it can supply — what it saw — and substituted the part the worker is better placed to decide

A result tool call that does not fit the state is refused before it runs, by the schema, and the agent is told inside its own turn.

- being strict at that boundary is cheap — the agent is still in the session, with everything it needs to call again
- it is what lets the six states share one result contract without the server having to police it afterwards

## Validation on settle

- the server reads the result tool calls out of the session's rpc stream — the same records it already parses for activity — and maps the last one through the state's contract
- the arguments arrive already validated against the state's schema, so the mapping is a read, not a check
- a settle with no result call at all (prose instead of a call, a truncated context, an aborted turn) is `missing-result`, retried a fixed number of times and then held
- the whole settle path is in [Settling an agent](settle.md)

## Findings and the message queue

Findings — from a design, plan, work or manager review — go to one place, `findings.json` in the task's runtime directory:

- they replace the next dispatch prompt for the stage they were sent back to, as `<STATE>-with-findings.md`
- they survive a compaction and a restart, so the agent is steered back with them intact
- a rejection overwrites the file, so an agent is only ever answering the latest review
- the file is cleared when the stage they were sent back to submits

Failing checks go to the message queue instead — `messages/<STATE>.md`, plain markdown, nothing structured — and are delivered into the agent's session as one prompt at the next dispatch of that state:

- the queue is drained when the state is dispatched, so a task that fails its checks is resumed with the failures already in its session
- a queued message is what makes a task resumable at all: findings regenerate the file and start a fresh session, a failed check reopens the one that produced it
- nothing in the queue or in `findings.json` is ever written to the task document

## Rotation

- the server writes `ASSIGNMENT.md` exactly once per dispatch and never again — not even to record a failed check
- anything it wants to say mid-run goes through the session as a `prompt`, and the agent folds it into its own appended notes
- one writer per file at all times, so notes can never be clobbered mid-thought

On every dispatch that generates a file:

- the previous one rotates into `history/ASSIGNMENT.<n>.md` first, numbered in order
- nothing an agent wrote is ever overwritten, and the manager sees every attempt rather than the last
- a re-dispatch after a hold rotates; a resume reopens the same file in the same session and rotates nothing

Rotation is also the role handoff:

- when a reviewer is dispatched, the previous role's file is carried forward, not regenerated
- the design reviewer reads the designer's appended section, the plan reviewer the planner's, the work reviewer the worker's
- the file is regenerated from the task body only at a fresh designer, planner or worker dispatch

## The task graph is not in the worktree

- the graph lives outside the repo — `~/task-graph/<key>/` by default, or wherever the manager points the server
- so no worktree contains it and an agent cannot read it, stale or otherwise
- `ASSIGNMENT.md` is the only statement of what the task is
- the dispatch prompts do not have to argue an agent out of consulting the graph
- what the graph looks like on disk is [The task document](task-document.md)
