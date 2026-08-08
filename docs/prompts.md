# Prompts and templates

Every word an agent reads is a file.

- nothing in `orchestrator/*.ts` builds a sentence
- so a prompt can be rewritten without a diff to the server
- and reading the fifty files is reading everything the agents are told

| File                                     | Kind            | Given to                                                                 |
| ---------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `prompts/DESIGN.md`                      | dispatch prompt | every `DESIGN` agent, as the first thing it is asked                     |
| `prompts/DESIGN-with-findings.md`        | dispatch prompt | a `DESIGN` agent the design review sent back, in place of `DESIGN.md`    |
| `prompts/DESIGN_REVIEW.md`               | dispatch prompt | every `DESIGN_REVIEW` agent, as the first thing it is asked              |
| `prompts/PLAN.md`                        | dispatch prompt | every `PLAN` agent, as the first thing it is asked                       |
| `prompts/PLAN-with-findings.md`          | dispatch prompt | a `PLAN` agent the plan review sent back, in place of `PLAN.md`          |
| `prompts/PLAN_REVIEW.md`                 | dispatch prompt | every `PLAN_REVIEW` agent, as the first thing it is asked                |
| `prompts/WORK.md`                        | dispatch prompt | every `WORK` agent, as the first thing it is asked                       |
| `prompts/WORK-with-findings.md`          | dispatch prompt | a `WORK` agent a work or manager review sent back, in place of `WORK.md` |
| `prompts/WORK_REVIEW.md`                 | dispatch prompt | every `WORK_REVIEW` agent, as the first thing it is asked                |
| `prompts/check-failed.md`                | queue entry     | a failed check, rendered into the worker's prompt queue                  |
| `prompts/missing-result.md`              | prompt fragment | an agent that settled without calling a result tool                      |
| `prompts/missing-todos.md`               | prompt fragment | a planner that submitted without appending a `## Todos` section          |
| `prompts/missing-design.md`              | prompt fragment | a designer that submitted without appending a `## Design` section        |
| `prompts/missing-notes.md`               | prompt fragment | a worker that submitted without appending `## Implementation Notes`      |
| `prompts/modified-assignment-<state>.md` | prompt fragment | an agent that changed the assignment above its allowed section           |
| `prompts/modified-worktree.md`           | prompt fragment | a designer, planner or their reviewer that wrote or committed            |
| `prompts/uncommitted.md`                 | prompt fragment | a worker that submitted uncommitted work                                 |
| `prompts/looping.md`                     | prompt fragment | an agent, caught repeating one command                                   |
| `prompts/blocked.md`                     | prompt fragment | an agent that came back blocked                                          |

Six files are code, not prose:

- `result-tools-designer.ts`, `result-tools-planner.ts`, `result-tools-worker.ts`, `result-tools-design-reviewer.ts`, `result-tools-plan-reviewer.ts`, `result-tools-work-reviewer.ts`
- they are the pi extensions sessions are started with (`--extension`, chosen by claimed state through the stage table's `tools`)
- each registers `submit` and `blocked` with `terminate: true` and their parameter schemas declared in zod
- they are loaded into the agent's process, so they are the one thing the agents read that is not a file in `prompts/`

There are no templates: `ASSIGNMENT.md` is the task body, verbatim, and every role instruction lives in the prompts.

## The six dispatch prompts differ because the six jobs do

They are not one file with a conditional:

- a **designer** is told the deliverable is the `## Design` section — the overall structure and how it fits into the project, with no step-by-step decomposition — and that it writes no code and commits nothing
- a **design reviewer** is told it reviews a design, not code: the design must propose the structure and cover every acceptance criterion at that level, and detail that belongs to the plan is not a finding
- a **planner** is told the deliverable is the `## Todos` section, numbered `1.` to `n.` consecutively, each todo carrying everything needed to act on it
- a **plan reviewer** is told it reviews a plan, not code, against the same three properties
- a **worker** is told to do every todo and record it by number under `## Implementation Notes`, and to commit as it goes
- a **work reviewer** is told it did not write the code and was not told why any of it is the way it is, and that a finding is one defect in this work named by symbol, file and input

What the result tools are and how they are shaped is left to their schemas, which every session already carries.

The overlap — `../ASSIGNMENT.md` is the task body, write only your own section, finish by calling a result tool — is short enough to state six times and worth stating in each state's own terms.

**No prompt names another role.**

- a designer is not told that a planner decomposes its design
- a plan reviewer is not told that an implementer executes the list
- a work reviewer is not told that the manager reads what it accepted
- the pipeline is the server's business: an agent cannot act on what happens after it settles, so telling it costs context and invites it to write for the next role instead of doing its own job

## A project can replace any of them

- a project that wants its agents told something else adds files to `<task-dir>/prompts/`
- any file there is used in place of the one the orchestrator ships, matched by name
- a name with no file there resolves in the orchestrator's checkout
- the directory does not have to exist
- a file present in both is **not merged** — the project's copy is the whole file
- `reload_prompts` re-reads them without a restart

The unit of override is the file rather than the directory:

- the files are not equally project-specific
- a house style, a build command a worker should know about, or a review that has to name a project's own invariants belongs to the project
- `missing-notes.md` telling an agent which section to append does not
- a project that had to copy them all to change one would carry stale files the moment the orchestrator's own moved on

Rendering:

- a fragment is rendered by `render()` with the same variables as the file it replaces
- a `{{…}}` naming something the server does not pass throws at load
- this is deliberate: every prompt is resolved when the server starts — the log lists the absolute path of each file it loaded, with the project's copy winning over the checkout's — and `reload_prompts` re-resolves them
- `agents.json` is read from the task directory, because the pool is a property of the machine the server runs on and the overrides are a property of the project

## A fragment names the fix, not the mistake

- every issue fragment is an instruction to do the specific thing that ends the situation, with the exact tool to call in the fragment
- none of them is a description of what the agent got wrong

A prompt that describes the mistake gets answered in the register it was asked in: a model forty turns into talking to a person will write `type: blocked` as prose in its reply and reason that it has already given the result. So each fragment:

- leads with the imperative — `Your last action was not a valid result for this step: … The result must be a call to one of these tools`, `Commit your work in this worktree, then submit again:`
- names the tools
- says outright that the final action is a tool call, not prose
- `missing-todos.md` tells the planner the exact section to append; `missing-notes.md` tells the worker the same

Making the result a tool call removes the register problem entirely: a model that would answer prose with prose has no way to send a result except the tool, and the tool's schema does the validation.

The same reasoning splits `missing-result` per state, the way `blocked` is split, and splits the extensions with it:

- every state calls the same two tools, but not always the same shape
- a worker calls bare `submit`, and every reviewer calls `submit` with `findings`
- an agent shown another state's shape would be told to send something the state refuses
- one extension per state, each declaring only its own shape, means there is no call the schema accepts and the state does not

## The role prompt is the dispatch, and there is no system prompt

An agent is spawned with no `--append-system-prompt`; the first thing it is asked is its state's file, whole.

- a role in the system prompt plus a shared nudge as the first message is two channels, and the nudge has to be one text for six states — whatever verb it picks is wrong for five of them
- a weak model resolves that contradiction by following the user turn: a `DESIGN_REVIEW` agent asked to "do the work `../ASSIGNMENT.md` describes" edits the worktree instead of attacking the design
- one file, in one channel, cannot contradict itself
- it also makes the override whole: a project that replaces `prompts/WORK.md` has replaced everything its worker is told, with no second file to keep in sync

Compaction is what a system prompt would have bought, and it is already handled:

- `compacted()` re-sends the same state fragment through `steer`, so the role and the path come back verbatim when the window rolls
- for a non-worker it resets the worktree to the recorded head first, so a compacted reviewer resumes from the same place the fragment describes

`../ASSIGNMENT.md` is the only place the assignment's location appears:

- all six prompts name it, the agent's working directory is the worktree, and the assignment sits beside it
- so one relative path is correct for every task, every role and every attempt, and no prompt is a string the server interpolates an absolute path into
