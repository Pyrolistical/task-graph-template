# Settling an agent

## Mapping pi signals onto the graph

The load-bearing one: everything the server does to a task in `DESIGN`, `DESIGN_REVIEW`, `PLAN`, `PLAN_REVIEW`, `WORK` or `WORK_REVIEW` comes out of it.

Two inputs, and they are not interchangeable:

- the **event stream** says how the turn ended
- the **`ASSIGNMENT.md` on disk** says what the agent believes it accomplished
- the stream is also where the result tool calls land — a `submit` or `blocked` call is an event like any other, read back at settle with the activity that surrounded it
- the file is authoritative for everything else
- a run whose every attempt failed still exits 0, and `agent_end` fires once per attempt, so the file is only worth reading once the stream says the turn settled

```text
on agent_settled:
    stopReason ← the last assistant message's stopReason

    if stopReason = error:                        # provider trouble, not the agent's
        back off, re-prompt the same session, done

    if the turn was cut short as a loop            → raise "looping"

    if stopReason = aborted:                      # shutdown or timeout
        close stdin, release the slot, done

    calls ← the result tools called this turn, from the rpc stream
    if stopReason = length, or there is no call → raise "missing-result"

    map the last call through the claimed state's result contract
    if the tool is blocked         → raise "blocked"

    compare ASSIGNMENT.md to what was dispatched
    if it changed above the appended section       → restore everything above the
                                                     agent's heading, keep what is
                                                     under it, raise
                                                     "modified-assignment"

    if the claimed state is DESIGN:
        if nothing was appended                   → raise "missing-design"
        if the worktree is dirty or carries commits  → raise "modified-worktree"
        submit, release the slot, done

    if the claimed state is DESIGN_REVIEW:
        if the assignment changed at all          → raise "modified-assignment"
        if the worktree is dirty or carries commits
                                                → raise "modified-worktree"
        if findings is empty → submit with the assignment as the new body, done
        findings → the designer's prompt queue, release the slot, done

    if the claimed state is PLAN:
        if nothing was appended                   → raise "missing-todos"
        if the worktree is dirty or carries commits  → raise "modified-worktree"
        submit, release the slot, done

    if the claimed state is PLAN_REVIEW:
        if the assignment changed at all          → raise "modified-assignment"
        if the worktree is dirty or carries commits
                                                → raise "modified-worktree"
        if findings is empty → submit with the assignment as the new body, done
        findings → the planner's prompt queue, release the slot, done

    if the claimed state is WORK_REVIEW:
        if the assignment changed at all          → raise "modified-assignment"
        findings ← result.findings (+ the tasks/ guard)
        findings → the body under # Review findings and the worker's queue,
                   or submit if there are none, release the slot, done

    # the claimed state is WORK
    if nothing was appended                       → raise "missing-notes"
    if the workspace is dirty, or the branch carries no commit of its own
                                                  → raise "uncommitted"
    submit with the assignment as the new body, release the slot
```

As a table, since these are the cases that matter:

| `stopReason` | result tool call | Server action                                              |
| ------------ | ---------------- | ---------------------------------------------------------- |
| `toolUse`    | `submit`         | per-state settle, `submit`, close stdin, release the slot  |
| `stop`       | `blocked`        | raise `blocked`                                            |
| `toolUse`    | wrong arguments  | never reaches the server; refused by the schema in-session |
| `length`     | any              | raise `missing-result`                                     |
| `error`      | any              | leave the process up; re-prompt on backoff                 |
| `aborted`    | any              | close stdin, release the slot                              |

A `length` or resultless outcome still keeps the branch, so the next attempt starts from the partial work rather than from the base.

## Issues

Everything the server can find wrong with a settle — and one thing it can find wrong before the settle — is a **named issue**.

- each has its own prompt fragment and its own number of attempts
- raising one prompts the live session with that fragment
- the attempt after the last one is a `hold` whose reason names the issue

| Issue                 | Attempts | Fragment                                                 | Held as                                                     |
| --------------------- | -------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `missing-result`      | 4        | `missing-result-<state>.md`                              | the agent stopped without calling a submit or blocked tool  |
| `missing-todos`       | 4        | `missing-todos.md`                                       | the planner submitted without appending a todo list         |
| `missing-design`      | 4        | `missing-design.md`                                      | the designer submitted without appending a design section   |
| `missing-notes`       | 4        | `missing-notes.md`                                       | the worker submitted without appending implementation notes |
| `modified-assignment` | 4        | `modified-assignment-<state>.md`                         | the agent changed parts of the assignment it may not        |
| `uncommitted`         | 4        | `uncommitted.md`, rendered from `git status`             | the agent submitted work it never committed                 |
| `looping`             | 3        | `looping-<state>.md`, rendered from the repeated command | the agent kept repeating one command                        |
| `blocked`             | 1        | `blocked-<state>.md`, one per claimed state              | the agent's own `message`, verbatim                         |
| `modified-worktree`   | 4        | `modified-worktree-<state>.md`                           | the agent wrote to the worktree during design or planning   |

Scoping:

- `missing-todos`, `missing-design`, `missing-notes` and `uncommitted` fire from exactly one state and keep a plain fragment name
- `looping`, `blocked`, `modified-worktree`, `modified-assignment` and `missing-result` can fire from several, so each is one file per state
- that way a project can override the designer's looping nudge without touching the worker's
- attempts are counted per issue per dispatch, not per settle — an agent that edits the assignment twice and then stops without a result has spent two of one budget and one of another

### Why four attempts

- the failures these catch are ordinary and recoverable: a result tool call with the wrong arguments, a turn that ran out of context before the final call was made, a section not yet appended
- each retry costs one turn against a session that already has the whole task in it
- the alternative — a hold — costs a person
- escalating to the most expensive resource in the system after a single misplaced brace is the wrong trade

### `looping` is the exception

- it is the one issue not raised from a settle, because the agent it catches never settles
- ten identical tool calls in a row — same tool, same arguments, byte for byte — and the stream flags it, `PiProcess` aborts the turn on the spot, and the settle that the abort produces raises the issue
- consecutive and within one turn: a command run ten times across ten turns is an agent checking its work, and a run broken by anything else starts the count again
- ten, because a handful of repeats is a retry and a screenful is an agent that has stopped reading

The reaction matters more than the number:

- a loop is not a failed submit, so the fragment does not correct anything
- it says the command was repeated, that the answer is not in its output, and that the cause may sit outside the diff entirely — in the environment rather than the code
- then it offers the two ways out: try something else, or send `{"type": "blocked", "message": ...}` and say what the wall is
- handing the agent straight to a person would throw away a session that still has the whole task in it, and would hand over "it kept running `zig build`" instead of the blocker the agent can write in one line
- three attempts rather than four, because each one costs ten tool calls to reach, and an agent that loops three times is not going to read its way out on the fourth

### `blocked` keeps its single attempt

- for the opposite reason: it is not a failure, the agent stated an outcome
- the second look is there to catch the one confusion the fragment can resolve — a reviewer that meant a delegation, a worker that could route around the wall
- if the agent says it again, it means it, and asking a third time is arguing with the answer

### Why they are named

- `server.log` says which issue and how many of its attempts are gone
- `held_reason` says which one won
- each fragment is a file that can be rewritten without touching the server

## A submit has to be in the git history

`uncommitted` is one of two issues that reads something other than `ASSIGNMENT.md`.

- `modified-worktree` is the other, and it is the same check with the requirements inverted
- the designer, the design reviewer, the planner and the plan reviewer must leave the worktree exactly as they found it, so any dirty file or any commit is an issue for them
- a worker is required to have both
- `uncommitted` is the one that catches the most expensive lie a worker can tell

Two facts are checked in the workspace before the `submit` is applied, both cheap:

- `git status --porcelain` is empty — `ASSIGNMENT.md` sits outside the tree, so anything reported here is real work the agent left behind
- `refs/remotes/origin/<base>..HEAD` counts at least one commit, so the branch carries something of the agent's own

Neither is a judgement, which is why it is the server's to enforce:

- everything downstream is a commit range — the checks run in the workspace, the reviewer is given `<base>..HEAD`, and the merge is a fast-forward of the branch
- a submit with a dirty tree hands all three the wrong thing: the checks pass against files nobody will ever see again, the reviewer reads an empty diff, and the work goes when the worktree does
- the base is read as a remote-tracking ref for the reason every base read inside a workspace is — see [The workspace is a clone](workspace.md#the-workspace-is-a-clone)

The fragment:

- quotes the `git status` output back — the first 20 entries, because a prompt is not a place to paste a thousand paths
- lands in the session that still holds every reason the agent had for what it wrote, so the usual outcome is one `git commit` and a second `submit`
- the agent was told this in `prompts/WORK.md` before it started; the check is there because "commit as you go" is an instruction, and a fast-forward merge needs a fact

Untracked counts, which is the point:

- a new file the agent wrote and never `git add`ed is the failure this catches most often
- the cost is build output the project does not ignore coming back as uncommitted work
- the fix for that is a `.gitignore` entry in the project, rather than a looser check here

## Applying a review

```text
when a reviewer settles in WORK_REVIEW:
    call ← the last result tool called this turn

    if the assignment changed at all:
        restore it, raise "modified-assignment",
        stay in WORK_REVIEW (past its attempts → hold)

    findings ← result.findings
    if the branch changed anything under tasks/:
        findings += "the diff writes to tasks/ …"

    if findings is empty → submit                (→ MANAGER_REVIEW)
    else → feedback with the findings, which appends them to the body
           under # Review findings, plus a fresh ## Implementation Notes
           heading; the findings are also queued to the worker's
           session                                    (→ WORK)
```

- `delegations` are not touched here
- they are part of the `submit` call, and the manager decides at `MANAGER_REVIEW` what should become a task
