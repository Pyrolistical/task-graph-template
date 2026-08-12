# The workspace

Every task gets one clone of the repo on its own branch `task/<id>`, created at the first claim into `DESIGN` and surviving every design → plan → work → check → review round trip: the review needs the tree the checks ran in, the sessions live beside it, and the rotated assignments are the record of every attempt. It goes when the task closes, or is recreated from the branch when `/tmp` was cleared.

## A clone, not a linked worktree

- `git worktree add` keeps refs, index and objects in the repo's `.git`, so committing in one writes to the repo — impossible for an agent that cannot write the repo
- `clone --shared` points the clone at the repo's object store: no history copied, cost is a checkout, nothing written to the repo
- a clone does not copy local config, so the commit identity is read from the repo and set in the clone; without that the first commit fails wherever `user.email` is local

Objects flow back only on `fetch`, which the server does whenever an agent finishes and again after the merge rebase. So the branch is a fact in the repo rather than a directory under `/tmp`: everything the server and manager read is the repo's own refs, the reclone after a cleared `/tmp` has something to clone, and a `git gc --prune` cannot collect objects only a clone's alternates still reach.

The base is always `refs/remotes/origin/<base>`, never the bare name: a clone made from the base has a local branch of that name, but one recloned from a surviving `task/<id>` has only the remote-tracking ref, where `git merge-base master HEAD` is a fatal error rather than a fallback. The one exception is the merge rebase, which fetches the base into a local ref first precisely so it has one.

The branch name is minted exactly once, at the claim that creates the workspace; everything afterwards reads `workspace.branch` out of the document. So changing the prefix needs no migration.

Two commit streams that never collide: **work branches** carry code, **the graph** carries state and is not in git at all.

## Integration

Whether a branch lands is a fact about git, not a graph decision, so `task_submit` from `MANAGER_REVIEW` does the work first — rebase onto the base, re-run every check in the rebased workspace, fetch back, fast-forward, assert the branch is now an ancestor — and applies the transition only if all of it worked.

- every failure is an error on the tool call and the task stays in `MANAGER_REVIEW`: the manager asked whether the branch lands, and "no, and here is why" answers that question
- whether a conflicted rebase is worth an agent round trip, a rewrite or an abort is exactly the judgement `MANAGER_REVIEW` exists for, and the task is already in that state
- rebase and recheck happen **after** acceptance: rebasing before review means reviewing a diff that no longer exists
- `abort` refuses a branch that is already an ancestor of the base, which stops it being used to disown work that landed

The same judgement is available while a task waits: an unclaimed task in `DESIGN`, `PLAN` or `WORK` can be held and then aborted rather than spending a slot on an answer the manager already has. The race with the dispatcher is [the scheduler's](scheduler.md#losing-the-race-with-an-abort).
