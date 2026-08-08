# Who may write what

The graph has one writer process — the server — but two authorities behind it.

## Mechanical transitions

- the server applies these on its own
- each is fully determined by an observed fact: a process settled, a command returned an exit code, a result tool was called

| Transition                                      | Triggering fact                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `submit` from `DESIGN`                          | a `submit` call with the `## Design` section written                                                |
| `submit` from `DESIGN_REVIEW`                   | a `submit` call with empty `findings`; the accepted `ASSIGNMENT.md` becomes the task body           |
| `submit` from `PLAN`                            | a `submit` call with the `## Todos` section written                                                 |
| `submit` from `PLAN_REVIEW`                     | a `submit` call with empty `findings`; the accepted `ASSIGNMENT.md` becomes the task body           |
| `submit` from `WORK`                            | a `submit` call with notes written, and the branch committed and clean                              |
| `submit` from `WORK_REVIEW`                     | a `submit` call with empty `findings`                                                               |
| `pass` from `CHECK`                             | every check exited 0                                                                                |
| `fail` from `CHECK`                             | at least one check did not; command, code and tail go to the worker's message queue                 |
| `feedback` in `WORK_REVIEW` or `MANAGER_REVIEW` | a `findings` list, copied verbatim into the body under `# Review findings` and into `findings.json` |
| `feedback` in `DESIGN_REVIEW`                   | a design review finding, copied verbatim into `findings.json` for the designer                      |
| `feedback` in `PLAN_REVIEW`                     | a plan review finding, copied verbatim into `findings.json` for the planner                         |
| `hold <reason>`                                 | an issue outlasted its attempts; the reason names it                                                |

The claim is a write of the same kind, and the server is the only thing that makes it: it takes the claim when it dispatches a free slot to a task nothing is holding, and clears it when the holding process is gone.

## Judgement transitions

- only the manager, through [MCP tools](mcp.md)
- nothing here is derivable from an observation

| Transition                                                               | Tool            | Why it needs a judge                             |
| ------------------------------------------------------------------------ | --------------- | ------------------------------------------------ |
| `create`                                                                 | `task_create`   | new work                                         |
| `submit` from `NEW`, `BLOCKED` or `MANAGER_REVIEW`                       | `task_submit`   | whether the task is done with the stage it is in |
| `feedback` in `MANAGER_REVIEW`                                           | `task_feedback` | whether a finding is real                        |
| `hold` from any planning or work state                                   | `task_hold`     | whether a task should wait                       |
| `abort` from `MANAGER_REVIEW`, `HELD_DESIGN`, `HELD_PLAN` or `HELD_WORK` | `task_abort`    | whether the task should exist at all             |
| `resume` from `HELD_DESIGN`, `HELD_PLAN` or `HELD_WORK`                  | `task_resume`   | whether the wall is gone                         |

One tool per judgement, named for the judgement.

- there is no generic `task_transition` taking a transition name and a list of strings: it would make every judgement look alike in the tool list, put the manager one typo away from a transition it did not mean, and push argument validation from the schema into a string parser
- `task_submit` is the one name that spans three states because they are the same judgement — the task is done with where it is — with the branch landing added when it is asked at `MANAGER_REVIEW`
- everything not in this table has no tool:
  - the manager edits the task document directly for what it is allowed to change (`checks`, `depends_on`, the title)
  - `pass`, `fail`, the claim, and the agent `submit`s are the server's — a tool for them would be a way for the manager to state a fact it has not observed

## The line

**The server states facts, the manager states opinions.**

- an agent's opinion is neither — it sits in `findings` until something with authority reads it
- the mechanical `feedback`s are the edge the server sits on deliberately: a written finding is copied, never interpreted
- a failed check does not even get that far — it is a `fail` whose details go to the message queue, not to the graph, because nobody has to decide anything about a red build
- to resolve a held task the manager edits the task directly (the document, or `task_write_body`) and `resume`s
- there is no todo-adding anywhere; the todo list is the planner's to write
