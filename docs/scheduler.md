# The scheduler

## Dispatch order

Right to left across the pipeline: capacity goes to whatever is closest to `CLOSED`, and a task nobody has touched is considered last. Within a state, one that already has a workspace outranks one that never started. A resume — `WORK` with a queued check failure and its session still on disk — outranks everything.

Ties break on most `blocking` first, then lowest id: unblocking three downstream tasks beats unblocking none.

Why work-in-progress rather than throughput: every task in flight holds a worktree, a branch, a session and a slice of the manager's attention, and all of it decays — a branch that sat through four sibling merges rebases badly, a review a day later is a worse review. Ten tasks at 90% are worth less than nine closed and one started.

- candidates are stages with a role and nothing holding them, so held states never reach the dispatcher and need no skip rule
- `claimed_by` is the first thing the ranking reads: a claimed task is not a candidate
- an empty pool refuses to start the scheduler, naming the pool file — a running scheduler with nothing to dispatch to is a queue that never moves
- a provider held back by its [health check](agents.md#healthcheck) is not free capacity: its slots exist but are not offered, and the queue waits
- an agent outside its [schedule](agents.md#schedule) is held the same way, and its provider is not even reached for: a slot that cannot be dispatched is not worth a health check

## Which free slot

Affinity first, speed second. A slot whose roles exclude the one the task needs is skipped.

- a task with a workspace knows which model wrote it; going back keeps the session, style and context it built, and no rate outweighs that
- otherwise the fastest free slot wins: output tokens/sec over an agent's last 10 assistant messages, from records the server already reads, kept per `type-provider-model` so every slot of a model feeds one window
- the window spans wall clock between first and last of those messages, so tool and thinking time count exactly as they cost the manager; it lives in memory and dies with the server, because it reads how providers behave now
- unmeasured agents sort first, so every model gets tried before speed rules it out; equal rates fall back to declaration order
- a tie-break, never a filter: a slow model takes work whenever it is the only thing free
- a resume that is not at the top of the queue waits for a tick with its own model free

## Losing the race with an abort

An unclaimed `WORK` task is both what the manager holds-and-aborts and what the scheduler dispatches, so the dispatcher must lose that race. Every claim re-reads the document and asserts the task is still in the planned state and still unclaimed, after the last `await` that could let a hold or a second tick through. A lost race becomes a clean dispatch error instead of a spawned process with nothing to do; the slot is released and the next tick plans against the graph as it now is.

## The slot handoff

The moment a `submit` is applied, stdin closes, the claim releases, and the slot takes the next queued item; checks then run in the background against the still-present worktree. When they fail, the session to resume is on disk and its process is gone, so the resume needs a slot of its own — hence its top rank. Holding the slot open until checks clear would throw away the parallelism this design exists for.

## The manager inbox

Same right-to-left rule over what only a person can do: `MANAGER_REVIEW`, then held states, then `NEW`; same tiebreaks, with fewest open todos between `blocking` and id.

- reviews first — a finished branch is the most perishable thing in the system and the only one holding downstream work hostage
- authoring last — a task nobody started costs nothing by waiting, and authoring while reviews queue moves the bottleneck upstream without removing it
- a row carries `branch`, not a worktree: the manager reads the commit range from its own checkout, and the worktree is the server's business
