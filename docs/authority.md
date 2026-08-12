# Authority

**The server states facts, the manager states opinions.** One writer process, two authorities.

## Mechanical — the server applies it itself

Every one is fully determined by an observed fact: a result tool was called, a command exited, a process died. Agent `submit`s, `pass`/`fail`, `feedback` carrying a review's findings, `hold` when an issue outlasts its budget, and the claim itself.

## Judgement — the manager only, through [MCP tools](mcp.md)

Nothing here is derivable from an observation: creating a task, entering it into a phase out of `NEW`/`BLOCKED_*`, closing it out of `MANAGER_REVIEW`, deciding a finding is real, holding, aborting, resuming.

A task entered at `PLAN` or `WORK` claims a design, or a design and a plan, that nothing verifies. That is the point: the manager is the judgement authority, so its word about its own body is a fact the server has no better source for.

One tool per judgement, named for it. A generic `task_transition` would make every judgement look alike, put the manager one typo from one it did not mean, and move validation from schema to string parsing.

Anything with no tool is either the server's (a tool would let the manager state an unobserved fact) or plain editing of the document (`checks`, `depends_on`, title).

## The line

- an agent's opinion is neither authority — it sits in `findings` until something with authority reads it
- mechanical `feedback` is the deliberate edge: a written finding is copied verbatim, never interpreted
- a failed check does not reach the graph as detail — `fail`, details in the message queue; nobody decides anything about a red build
- resolving a hold is editing the task, then `resume`
- nothing adds todos; the list is the planner's
