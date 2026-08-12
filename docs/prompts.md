# Prompts

Every word an agent reads is a file under [`orchestrator/prompts/`](../orchestrator/prompts). Nothing in `orchestrator/*.ts` builds a sentence, so a prompt is rewritable without a server diff and reading the directory is reading everything the agents are told.

Three kinds: one **dispatch prompt** per claim state, plus a `-with-findings` variant for each state a review sends back to; one **queued message** for a failed check; one **fragment** per [issue](settle.md#issues), `modified-assignment` per state.

Six files are code rather than prose: `result-tools-*.ts`, the pi extensions a session starts with, chosen by claimed state through the stage table. Each registers `submit` and `blocked` with `terminate: true` and zod schemas — the one thing agents read that is not in `prompts/`. One extension per state, so there is no call the schema accepts and the state does not.

## Six dispatch prompts because six jobs

Not one file with a conditional. Each states its own deliverable in its own terms — designer structure, design reviewer the design against the criteria, planner todos, plan reviewer the same three properties, worker every todo plus commits, work reviewer defects it can name by symbol, file and input. The overlap (`../ASSIGNMENT.md` is the task body, write only your own section, finish with a result tool) is short enough to state six times.

**No prompt names another role.** The pipeline is the server's business: an agent cannot act on what happens after it settles, so telling it costs context and invites it to write for the next role instead of doing its own job.

`../ASSIGNMENT.md` is the only place the assignment's location appears: cwd is the worktree and the assignment sits beside it, so one relative path is correct for every task, role and attempt, and no prompt is a string the server interpolates a path into.

## No system prompt

Spawned with none; the first thing asked is the state's file, whole.

- a role in the system prompt plus a shared first-message nudge is two channels, and one nudge must serve six states — whatever verb it picks is wrong for five
- a weak model resolves that contradiction by following the user turn: a `DESIGN_REVIEW` agent asked to "do the work `../ASSIGNMENT.md` describes" edits the worktree instead of attacking the design
- one file in one channel cannot contradict itself, and it makes an override whole
- compaction is what a system prompt would have bought, and [the steer](agents.md#compaction) already re-sends the same fragment

## A fragment names the fix, not the mistake

Every issue fragment is an instruction to do the one thing that ends the situation, naming the exact tool; none describes what the agent got wrong. A prompt that describes the mistake gets answered in the register it was asked in: a model forty turns into talking to a person writes `blocked` as prose and reasons that it has already given the result.

## Overrides

Files in `<task-dir>/prompts/` replace shipped ones by name; a missing name resolves in the checkout and the directory need not exist. A file present in both is **not merged** — the project's copy is the whole file — because the files are not equally project-specific: a house style, a build command or a review naming project invariants belongs to the project, while a fragment naming a section does not. Copying them all to change one would carry stale files the moment the orchestrator's moved on.

`render()` passes the same variables as the file being replaced, and a `{{…}}` the server does not pass throws at load. Everything resolves at startup with each absolute path logged, so `reload_prompts` or a restart is needed after an edit. `agents.json` stays in the task directory rather than here because the pool is a property of the machine while overrides are a property of the project.
