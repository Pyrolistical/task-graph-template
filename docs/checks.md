# Checks

`CHECK` is the deterministic half of the pipeline: the commands a task declares in its `checks` frontmatter, run by the server rather than by an agent.

```text
when a task enters CHECK:
    run every check, in order, in the task's workspace, sandboxed
    failures ← the ones that exited non-zero, each with its output tail

    if failures is empty → pass       (→ WORK_REVIEW)
    else                 → fail, and queue the failures to the
                           worker's prompt queue   (→ WORK)
```

- a check is spawned into the same [sandbox](sandbox.md) the agent gets, except that only its own directory is writable
- a check runs code the agent wrote, so it is no more trusted than the agent
- each check's stdout and stderr go to `check-<index>.log` in the task's runtime directory, and the running ones are listed in [`checks.json`](runtime-directory.md#checksjson)
- the check runner has no agent and no slot: `checks.json` and `agents.json` are separate documents because the two have nothing to do with each other
- `WORK` submits straight into `CHECK`, and every tick starts the commands of any task sitting there without a run of its own, so a server that dies mid-check re-runs them on the next start

## Every check runs every time

- nothing records that a check has passed, so there is no stale result to trust and no field for an agent to flip
- re-running a passing command costs seconds; believing a stale pass costs a review
- the checks run again at [integration](workspace.md#integration), against the rebased workspace, for the same reason: a green review does not mean a green merge

## Why the server runs them

- running `bun test` and reading an exit code does not need an LLM
- making it mechanical removes the most common failure in agent pipelines, which is a checker reporting a pass it did not get
- a failing check records nothing in the graph — it is a `fail` whose command, code and tail go to the worker's prompt queue; see [Failing forward](states.md#failing-forward)
