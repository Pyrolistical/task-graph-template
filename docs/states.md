# States

| State            | Actor       | Mechanism                                                       |
| ---------------- | ----------- | --------------------------------------------------------------- |
| `NEW`            | manager     | authors the document; `submit` routes it by the dependencies    |
| `BLOCKED`        | —           | cleared automatically when the last dependency closes           |
| `HELD_DESIGN`    | **manager** | reads `held_reason`; `resume`, `abort` or restructures          |
| `HELD_PLAN`      | **manager** | reads `held_reason`; `resume`, `abort` or restructures          |
| `HELD_WORK`      | **manager** | reads `held_reason`; `resume`, `abort` or restructures          |
| `DESIGN`         | **agent**   | a fresh `designer` writes the `## Design` section               |
| `DESIGN_REVIEW`  | **agent**   | a `reviewer` checks the design against the criteria             |
| `PLAN`           | **agent**   | a fresh `planner` writes the numbered `## Todos` list           |
| `PLAN_REVIEW`    | **agent**   | a `reviewer` checks the list against the criteria               |
| `WORK`           | **agent**   | worktree + `ASSIGNMENT.md`; produces commits and notes          |
| `CHECK`          | **server**  | runs every check in the worktree                                |
| `WORK_REVIEW`    | **agent**   | fresh session, reads the commits and the notes, writes findings |
| `MANAGER_REVIEW` | **manager** | reads the task document; then `submit` or `task_feedback`       |

- six of the thirteen spend model tokens: `DESIGN`, `DESIGN_REVIEW`, `PLAN`, `PLAN_REVIEW`, `WORK`, `WORK_REVIEW`
- `CHECK` is deterministic — running `bun test` and reading an exit code does not need an LLM
- making it mechanical removes the most common failure in agent pipelines: a checker reporting a pass it did not get
- the full transition diagram, and the handoff diagram behind it, are in the [project README](../README.md#task-state-machine)

## The state is the stage, the claim is the agent

There is one state per stage. Whether an agent is on it is `claimed_by`, not a second state:

| `state` | `claimed_by` | what it is                         |
| ------- | ------------ | ---------------------------------- |
| `PLAN`  | `null`       | waiting for a planner slot         |
| `PLAN`  | `pi-fake-2`  | that slot is planning it right now |

- taking and clearing the claim write that one field and leave the state where it is
- the dispatcher's whole eligibility test is "a stage with a role, and nothing holding it"
- a claim is refused when the field is already set, under the graph lock — that compare-and-swap is the entire single-agent guarantee
- the claim is cleared once the process is gone, and the task keeps its workspace and branch and is dispatchable again where it stands
- `submit`, `feedback`, `hold`, `pass`, `fail` and `abort` all clear the claim on the way through, so no transition ever leaves one behind
- `submit` and `feedback` from a stage with a role are refused unless something is holding the task: they are an agent speaking, and an agent that is not there cannot speak

## The stage table is the source of truth

- `state-machine.ts` declares the eight stages once, and a stage carries everything the pipeline knows about it: state, phase, role, result-tool extension, the section its agent appends, the issue raised when it appends nothing, the guard its worktree is held to, where its findings send the task back to, and whether its `submit` hands the assignment in as the new task body
- everything else is derived from that one array — `NEXT_STATE`, `CLAIM_STATES`, `STAGE_OF`, the scheduler's `RANKS`, the issue table's state lists, and the settle
- adding a stage is an entry in the array, not an edit to six lookup tables that have to agree
- a row is a union keyed by its role, so the combinations that exist are the only ones that compile: a `designer`, `planner` or `worker` has an extension, the section it appends and the issue for appending nothing, and no `back`; a `reviewer` has an extension and a `back`; a stage with no role has neither extension nor section
- the two stages with a `null` role (`CHECK`, `MANAGER_REVIEW`) fall out of the agent-facing derivations by construction, so nothing claims them and no dispatcher special-cases them

## Why the review is split in two

- catching what a careful reader catches and deciding whether the work is acceptable are different jobs
- the first is cheap, mechanical to trigger, and scales with slots
- the second is a judgement and belongs to the manager
- merging them means every typo-level finding costs a manager round trip

**`WORK_REVIEW`** runs after the checks pass:

- a fresh agent, a fresh session, the worktree and the acceptance criteria
- the worker's appended notes are in the assignment it carries forward
- it calls `submit` with `findings` and settles
- it cannot pass or close anything: the server reads its tool call and applies it, while it still holds the claim, before the slot is released
- findings → written to `findings.json` and appended to the task body under `# Review findings`, task drops to `WORK`, and the next worker is dispatched fresh with `WORK-with-findings.md`
- a second rejection of the same review holds the task into `HELD_WORK` instead: the count of consecutive failures lives in `review-failure-count` under the task's runtime dir, and the second one writes `failed 2nd review with <findings>` into `held_reason`
- no findings → up to `MANAGER_REVIEW`

**`MANAGER_REVIEW`** is the manager, seeing only work that survived both a machine and a peer.

The same split covers the design and the plan:

- `DESIGN_REVIEW` and `PLAN_REVIEW` are each a fresh reviewer session reading a section the previous role appended — the `## Design` section, then the `## Todos` list
- findings go back to the role that wrote it, the same way in every phase: they are written to `findings.json` and replace its dispatch prompt with the `-with-findings` variant
- no review closes anything, so a typo-level finding on a design, a plan or a piece of work never costs a manager round trip
- the reviewer never applies its own findings and the server never interprets them
- the same two-rejection rule holds into `HELD_DESIGN` / `HELD_PLAN`; `MANAGER_REVIEW` bounces are never counted — the manager is the person a hold would escalate to
- a finding is copied verbatim into the body, which is the only thing that makes the copy safe to do without a judge

## The design and planning phases

Every task is designed, then planned, before it is worked.

- `task_submit` sends it to `DESIGN` — or `BLOCKED`, when the manager edited dependencies into it
- a `designer` in a fresh session reads the goal and the acceptance criteria, reads the code it is designing against, and writes the `## Design` section of `ASSIGNMENT.md`
- that section is the overall structure of the work and how it fits into the project: the architecture it should follow, the refactorings it proposes, the modules and files it touches
- no step-by-step detail — decomposing the design into executable todos is the planner's job
- only a design that survived a `reviewer` opens `PLAN`; only a plan that survived a `reviewer` opens `WORK`
- at design acceptance the whole assignment becomes the task body, so the design lands in the graph verbatim
- the planner's assignment is generated from that body, and the accepted plan then replaces it the same way

### The designer writes nothing but that section

- it runs in the same worktree the work will happen in
- the workspace is created at the first `DESIGN` claim and survives through design, planning, work, checks and reviews — so the designer's reading of the code, the planner's reading of it, and the worker's edits all happen against the same tree and the same branch
- the server checks at every settle that it left that worktree exactly as it found it: `git status` clean, no commits of its own, and the assignment unchanged above its appended section
- a designer that writes or commits is prompted in situ to undo it (up to four attempts, then `HELD_DESIGN`) — a dirty worktree or a stray commit would poison the work phase that follows
- the design itself lives only in `../ASSIGNMENT.md`, like every other deliverable

### The accepted design is the assignment itself

- at `DESIGN_REVIEW` with empty `findings` the server submits the whole `ASSIGNMENT.md` as the new task body, so the appended design section lands in the graph verbatim
- a settle that appended nothing is refused (`missing-design`, in situ, then `HELD_DESIGN`) — a design with no structure is not a design, and the designer is the one that knows

### The design review is a review of the design, not of code

- the reviewer carries the designer's own file forward; the appended `## Design` section is what it reads
- `findings` are the gaps between the structure it proposes and the acceptance criteria, plus any way the design is missing or proposes no structure
- they go back to the designer **verbatim**, as `DESIGN-with-findings.md` in place of `DESIGN.md` — the whole dispatch prompt, not a queued entry ahead of it
- they are held in `findings.json` under the task's server directory until the designer submits, so a compaction mid-design is steered back with them intact
- a rejection overwrites that file, so the designer is always answering the latest review and only the latest
- the findings never enter `ASSIGNMENT.md`, so nothing has to strip them before the accepted assignment becomes the task body
- the first design that satisfies the reviewer moves the task to `PLAN`
- the rejected design never touches the body — by the transition rule rather than by the settle — so no trace of the rejection survives into the plan
- a finding is a description of the gap, not a prescription of the fix; same standard as the plan and work reviews, for the same reason: the designer is better placed to decide how to structure the work

### The planner decomposes the approved design

- it writes the `## Todos` section of `ASSIGNMENT.md`: a numbered list, `1.` to `n.` consecutively, each entry specific and verifiable enough for a worker to execute without the planner present
- under the same worktree rules as the designer
- the plan review sends it back to `PLAN` with findings, or opens `WORK`
- at plan acceptance the whole assignment becomes the task body again, so the todo list lands in the graph verbatim next to the design it decomposes

### Holds carry the phase

- held from design → `HELD_DESIGN` → resumes to `DESIGN`
- held from planning → `HELD_PLAN` → resumes to `PLAN`
- held from work → `HELD_WORK` → resumes to `WORK`
- the state alone records where the wall stopped, so `resume` never sends a task back to a design or plan it does not have

## Failing forward

`fail` is how `CHECK` sends work back, and it records nothing in the graph:

| From    | To     | What is delivered                                                   | Who picks it up      |
| ------- | ------ | ------------------------------------------------------------------- | -------------------- |
| `CHECK` | `WORK` | every failing command, code and tail, in the worker's message queue | the worker's session |

- a result that cannot be read is not a failure and never reaches the graph
- the agent that wrote it is still holding the claim, so the server says what is wrong in that session and the state does not move
- only an agent that gets it wrong repeatedly is `hold`
- the queue carries the failure rather than the server holding it in memory, because the resume may happen after a manager restart
- everything the resume prompt says is rendered from the queue at dispatch time; nothing about it is remembered anywhere else
- the queue is drained when the state is dispatched — the agent is claiming the failures are gone, and `CHECK` is about to re-run everything and file a fresh entry if it lied

## HELD_DESIGN, HELD_PLAN and HELD_WORK

An agent that cannot finish sets `result.type: blocked` with a message.

- the server asks once whether it really is a wall
  - for a reviewer: work outside this task's scope is not a wall, and not a finding either
  - for a worker: a wall it can work around is not a wall
- if the next settle is blocked again it applies `hold`, which clears the claim and records the message verbatim in `held_reason`
- a person is the most expensive thing the system can spend, so it is worth one prompt to be sure

That question is one file, `blocked.md`, because the same words hold from every claimed state: an agent is asked to look again, and to resubmit `blocked` with the same message if it still cannot proceed.

- there is no shared fragment with a hole in it, and nothing is interpolated into the prose
- a per-state variant is one line in `ISSUES` when a state needs its own words, as `modified-assignment` does

### Why they are states, not a flag

- a flag needs the scheduler to remember to check it, and leaves a task sitting in a queue it is not eligible for
- a state cannot be forgotten: the dispatcher pulls from `WORK`, `PLAN` and `DESIGN`, a held task is in none of them, and nothing has to be careful
- one held state per phase, so the state carries the phase and nothing else has to:
  - `HELD_DESIGN` from `DESIGN` or `DESIGN_REVIEW`
  - `HELD_PLAN` from `PLAN` or `PLAN_REVIEW`
  - `HELD_WORK` from `WORK`, `CHECK` or `WORK_REVIEW`
- `resume` reads the phase straight off the state, so it never has to guess which stage the task belongs in
- [the claim](#the-state-is-the-stage-the-claim-is-the-agent) is a field rather than a state for the opposite reason: the dispatcher and the reaper both read `claimed_by` on every task they touch, so nothing has to remember to consult it

### Three ways out, all judgement

| Transition            | To                                                  | The manager decided                                                       |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `resume`              | `DESIGN`, `PLAN` or `WORK`, matching the held state | the wall is gone; try again unchanged, back to the phase the wall stopped |
| `resume` (deps added) | `BLOCKED`                                           | it was waiting on something that isn't done                               |
| `abort`               | `CLOSED`                                            | the task was the wrong shape                                              |

To resolve a hold:

- the manager first **updates the task directly** — edit the document, or `task_write_body` to fix the acceptance criteria or append guidance, editing `checks` and `depends_on` in the frontmatter if those are what was missing
- then `resume`, or `abort` to throw the task away
- there is no todo-adding; the todo list is the planner's to write
- a task held before it was designed is re-designed; one held before it was planned is re-planned
- a review-failure hold records the findings in `held_reason`, and `resume` starts a fresh failure count

### Held is not BLOCKED

- the dependencies-added `resume` is the common one, and it is the reason the two are separate
- "waiting on another task" is machine-resolvable and clears itself when the dependency closes
- "waiting on a person" never clears itself
- `BLOCKED` carries no phase — a task that unblocks starts again at `DESIGN`, because a task that sat waiting on another one is a task whose design is worth revisiting
- collapsing them would put a task nothing can ever unblock in the same bucket as one that will unblock itself in an hour

- when the manager genuinely cannot resolve it, it escalates to a human
- that escalation is the only unbounded thing in the system
- it is deliberately a person rather than a state — the task stays in its held state while it happens, which is exactly what those states mean
