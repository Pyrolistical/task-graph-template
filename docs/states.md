# States

```text
NEW → [BLOCKED_*] → DESIGN → DESIGN_REVIEW → PLAN → PLAN_REVIEW
    → WORK → CHECK → WORK_REVIEW → MANAGER_REVIEW → CLOSED
entries:    NEW → DESIGN, PLAN or WORK, by which submit_* the manager calls
waiting:    a submit_* with dependencies open → BLOCKED_DESIGN / BLOCKED_PLAN /
            BLOCKED_WORK → its phase state when the last dependency closes
back edges: review feedback → its author state; CHECK fail → WORK;
            any phase → HELD_DESIGN / HELD_PLAN / HELD_WORK → its phase state
```

Edges, guards and roles are declared once in [`vocabulary/state-machine.ts`](../orchestrator/vocabulary/state-machine.ts); `NEXT_STATE`, `CLAIM_STATES`, the scheduler's ranks, the issue table's state lists and the settle all derive from that one table, so adding a stage is one entry. A stage row is a union keyed by role, so only real combinations compile, and the two roleless stages (`CHECK`, `MANAGER_REVIEW`) drop out of every agent-facing derivation by construction.

- six stages spend model tokens; [`CHECK`](checks.md) is the server and `MANAGER_REVIEW`/`NEW`/`HELD_*` are the manager

## State is the stage; the claim is the agent

`PLAN` unclaimed is a task waiting for a planner slot; `PLAN` claimed is that slot planning it.

- claiming and releasing write one field, leaving the state where it is
- a claim is refused when the field is already set — that read-refuse-write, in the one writer process, on one field, is the entire single-agent guarantee
- the claim clears when the process is gone; the task keeps its workspace and branch and is dispatchable where it stands
- `submit`/`feedback` from a role stage are refused unless something holds the task: an agent that is not there cannot speak

## Reviews are split in two

Catching what a careful reader catches is cheap and scales with slots; deciding whether work is acceptable is a judgement. Merged, every typo-level finding would cost a manager round trip — so `MANAGER_REVIEW` only ever sees work that survived a machine and a peer.

- a reviewer is fresh: the worktree, the commit range, the criteria; never the author's session ([Sessions](sessions.md))
- findings go verbatim to `findings.json` and become the author's next dispatch prompt; a work review's also land in the body under `# Review findings`
- a reviewer never applies its own findings and the server never interprets them
- a finding describes the gap — symbol, file, input, what breaks — and never prescribes the fix, which is the part the author is better placed to decide
- second consecutive rejection of one review holds the phase instead of bouncing, findings as `held_reason`; `MANAGER_REVIEW` bounces are never counted, since a hold escalates to the manager

## Design and planning

Every task is designed, then planned, then worked; only a reviewed design opens `PLAN`, only a reviewed plan opens `WORK` — from `DESIGN` on. Where a task starts is the manager's call: `submit_designing`, `submit_planning` or `submit_working` out of `NEW`/`BLOCKED_*`.

- `submit_planning` says the design is already in the body, `submit_working` says the design and the plan are; nothing checks either, because the manager is the one authority that does not need checking ([Authority](authority.md))
- one transition per entry rather than an argument, so a phase skipped is a named judgement in the transition log
- designer writes structure and project fit, no step-by-step; planner decomposes it into todos each executable without the planner present
- at each acceptance the whole assignment becomes the task body, so design and plan land in the graph verbatim and the next role's assignment is generated from it
- design review reviews the design against the criteria; plan-level detail is not a finding there
- both roles run in the worktree the work will use, created at the first `DESIGN` claim and surviving to review, so every role reads the same tree — and both are guarded `untouched`, because a dirty tree or stray commit would poison the work phase
- findings never enter `ASSIGNMENT.md`, so nothing is stripped before an accepted assignment becomes the body

## Failing forward

`fail` records nothing in the graph: the failing commands, codes and tails go to the worker's [message queue](assignment.md#findings-vs-the-message-queue), which is what makes the task resumable across a manager restart. The queue is drained at dispatch — the agent claims the failures are gone and `CHECK` re-runs everything if it lied.

An unreadable result is not a failure and never reaches the graph: the agent still holds the claim, so the server says what is wrong in that session and the state stays put. Only repeated failure becomes `hold`.

## Held

An agent that cannot finish calls `blocked`. The server asks once whether it really is a wall (out-of-scope work is not one; a wall it can route around is not one) — one prompt is cheap, a person is the most expensive thing the system can spend. Still blocked next settle → `hold`, claim cleared, message verbatim into `held_reason`.

- a state, not a flag: a flag needs the scheduler to remember to check it; held states are simply not stages the dispatcher pulls from
- one held state per phase, so the state carries where `resume` goes
- the manager resolves by editing the task first, then `resume` (or the blocked state of its phase if it added dependencies) or `abort`; a resume starts a fresh failure count
- held is not blocked: "waiting on another task" clears itself, "waiting on a person" never does
- one blocked state per phase, exactly as with held, so the state carries where the last dependency releases it to: the entry the manager chose is what it waits for, and a `submit_working` behind a dependency is still a `submit_working` when that dependency closes. The manager can change its mind while it waits — another `submit_*` moves it to that phase's blocked state
- a hold the manager cannot resolve escalates to a human, the only unbounded thing in the system; the task stays held meanwhile
