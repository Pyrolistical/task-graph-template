# The scheduler

## Dispatch

Right to left across the state machine: capacity goes to whatever is closest to `CLOSED`, and a task nobody has touched is the last thing considered.

```text
every tick, while the scheduler is running:
    free ← every idle slot of an enabled agent, less the slots of any
        agent asking for a healthCheck whose provider did not answer
    queue ← every task in a stage with a role and nothing holding it, ranked
        1  resume            — WORK with a queued check failure
                               and a session file still on disk
        2  WORK_REVIEW
        3  WORK with a workspace          (started, sent back)
        4  WORK with none                 (never started)
        5  PLAN_REVIEW
        6  PLAN with a workspace          (re-planning after a rejection)
        7  PLAN with none                 (never planned)
        8  DESIGN_REVIEW
        9  DESIGN with a workspace        (re-designing after a rejection)
       10  DESIGN with none               (never designed)
    ties: most blocking first, then lowest id

    for each candidate, in order, while slots remain free:
        skip free slots whose roles do not include the one this task needs
          (designing needs designer, planning needs planner,
           reviews need reviewer, everything else worker)
        if it prefers a slot (workspace.slot) and a free slot has the
          same type-provider-model, take that one
        else if it is a resume and not at the top of the queue,
          leave it for a tick that has its own model free
        else take the fastest free slot — highest output tokens per second
          over that agent's last 10 assistant messages, an agent nobody has
          measured yet first, a tie going to the order the pool declares
```

- within every rank, most `blocking` first: unblocking three downstream tasks is worth more than unblocking none, and that is as true of a resume as of a fresh dispatch
- the point is not throughput, it is work in progress
- every task in flight holds a worktree, a branch, a session, and a slice of the manager's attention, and all of that decays
- a branch that sat through four sibling merges rebases badly, and a review a day after the fact is a worse review
- ten tasks at 90% are worth less than nine closed and one started
- there is no rank for held tasks and no rule that skips them: `HELD_DESIGN`, `HELD_PLAN` and `HELD_WORK` are not stages with a role, so the dispatcher never sees one
- `claimed_by` is the first thing `rankOf` reads: a task an agent holds is not a candidate
- a pool with no slots at all cannot be started: the switch is refused with the path of the pool file, because a running scheduler with nothing to dispatch to is a queue that never moves
- a provider held back by its [health check](agents.md#checking-the-provider-is-up-first) is not free capacity for that tick: the slots exist, they are simply not offered, and the queue waits rather than dispatching into a server that is not listening

## Which free slot, when several will do

Affinity first, speed second:

- a task that has a workspace already knows which model wrote it — going back to that model keeps the session, the style and the context it built, and no rate ever outweighs that
- only when nothing is preferred, or the preferred model is busy, does speed decide
- the rate is output tokens per second across an agent's last 10 assistant messages, measured from the `message_end` records the server is already reading, kept per `type-provider-model` so every slot of a model contributes to one window
- it lives in memory and dies with the server: it is a reading of how the providers are behaving right now, not a fact about the pool, and a provider that was throttled an hour ago should not be punished for it after a restart
- the window spans wall clock between the first and last of those messages, so tool time and thinking time count against a model exactly as they cost the manager
- an agent nobody has measured sorts ahead of every measured one, so each model in the pool gets tried before speed can rule it out; equal rates fall back to the order `agents.json` declares
- this is a tie-break, never a filter — a slow model still takes work whenever it is the only thing free, because a task moving slowly beats a task not moving

## Losing the race with an abort

- an unclaimed `WORK` task is both what the manager holds-and-aborts and what the scheduler dispatches, so the dispatcher has to lose that race rather than win it
- every claim asserts the task is still in the state the plan saw it in **and still unclaimed** — immediately before taking the claim, and after the last `await` that could have let a hold-and-abort, or a second tick, through
- the `claimed_by !== undefined` check runs under the graph lock and is what makes the race safe; the assertion is what turns a lost race into a clean dispatch error rather than a spawned process with nothing to do
- a claim that lost the race releases the slot and tears the process down, and the next tick plans against the graph as it now is

## The slot handoff

- the moment a `submit` result appears and the server applies `submit`, it closes stdin, releases the claim, and the slot takes the next queued item
- checks then run in the background against the worktree, which is still there
- when those checks fail, the session that must be resumed is on disk and its process is gone
- the resume needs a slot of its own, which is why resumes are their own rank and outrank fresh dispatch:
  - a fix that is already understood is worth more than a task nobody has looked at
  - the alternative — holding the slot open until checks clear — throws away exactly the parallelism this design exists for

## The manager inbox

The same right-to-left rule as dispatch, applied to the things only a person can do:

```text
inbox ← every task in one of these states, in this order:
    1  MANAGER_REVIEW    — a branch is finished and waiting on a judgement
    2  HELD_*            — an agent hit a wall and stopped
    3  NEW               — a task exists but has no body yet
ties: most blocking first, then fewest open todos, then lowest id
```

- a row carries `branch`, not the worktree it was built in: what the manager reads is the commit range, and it reads it from its own checkout — the worktree is the server's business
- reviews first, because a finished branch is the most perishable thing in the system and the only one holding a slot's worth of downstream work hostage
- authoring last, because a task nobody has started costs nothing by waiting
- a manager that authors while reviews queue up has moved the bottleneck upstream without removing it
