# Checks

`CHECK` is the deterministic half of the pipeline: the commands in a task's `checks` frontmatter, run in order in its workspace by the server. All pass → `WORK_REVIEW`; any fail → `WORK`, with each failing command, code and output tail [queued to the worker](states.md#failing-forward).

- reading an exit code does not need an LLM, and the server running them removes the most common failure in agent pipelines: a checker reporting a pass it did not get
- spawned into the same [sandbox](sandbox.md) an agent gets, except only the task's own directory is writable — a check runs code the agent wrote, so it is no more trusted than the agent
- stdout+stderr per check to `check-<index>.log`; running ones are their own view, since checks and slots have nothing to do with each other
- every tick starts commands for anything sitting in `CHECK` with no run, so a server that died mid-check re-runs them on the next start
- nothing records a pass, so there is no stale result to trust and no field for an agent to flip; re-running a passing command costs seconds, believing a stale pass costs a review
- they run again at [integration](workspace.md#integration), because a green review does not mean a green merge
