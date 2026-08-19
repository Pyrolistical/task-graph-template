# 5 · the tools an inline agent has

Six tools: `bash`, `read`, `write`, `edit`, and the [result pair](../assignment.md) the role decides. Everything else an agent needs is a CLI it reaches through `bash`, which is the same direction as the rest of the design — an agent's interface to the world is a file.

**Needs first:** nothing. These are functions over a worktree, testable against a temp directory with no model and no loop.

## The path guard

`kernel/domain/within.ts`, one exported function, total over strings, no I/O:

```ts
export function within(root: string, target: string): string | undefined;
```

Resolves `target` against `root`, returns the absolute path when it lies under `root`, and `undefined` otherwise. The caller does the `realpath` and hands in what it got, so the guard stays pure and the symlink question has one answer in one place.

- `root` is the task's runtime directory, so the worktree, `ASSIGNMENT.md` and the task's own files are all reachable and nothing else is
- `..` that climbs out is refused, however many times it climbs
- the root itself is allowed; a sibling whose name merely starts with the root's is not — `/w/task-1` must not admit `/w/task-10`
- an absolute target outside the root is refused rather than reinterpreted

The file tools call `realpath` on the nearest existing ancestor first — a `write` creates its target, so the target itself may not exist — then guard that. A symlink inside the worktree pointing out of it is therefore refused, which is the point.

## The tools

| Tool    | Arguments                         | Is                                                      |
| ------- | --------------------------------- | ------------------------------------------------------- |
| `bash`  | `command`, optional `timeoutMs`   | one sandboxed command in the worktree                   |
| `read`  | `path`, optional `offset`/`limit` | a file under the runtime directory, line-numbered       |
| `write` | `path`, `content`                 | the whole file, parents created, guarded the same       |
| `edit`  | `path`, `old`, `new`              | one exact replacement, refused unless `old` occurs once |

Parameters are zod schemas, parsed and never asserted, like everything else off a wire. The argument **names** are fixed: `toolCall`/`toolTarget` in [`views/activity.ts`](../../orchestrator/views/activity.ts) turn a name and an argument bag into a console row by reading `command` and `path`, so those two names are wire contract, not preference.

A refusal is a tool **result**, not an exception: `{ ok: false, message }` handed back to the model, which must be able to read what it did wrong and try again. The only things that throw out of a tool are bugs.

### `bash`

Execs the same line the [checks](../checks.md) exec — `systemd-run … choom … bwrap … --chdir <worktree>` — built from the run's [`write` list](../agents.md#write) and `AGENT_OOM_SCORE_ADJUST`, through `CheckRunner` with an `AbortSignal` and a log path of its own. The kernel stays the boundary for the one tool that can do real damage.

- a fresh shell per call. No `cd` carried between calls, no background process outliving one; `cd sub && cmd` answers the first, and a server that must outlive a call is a check's job
- default timeout 120s, ceiling 600s; a timeout kills the sandbox and returns what was written so far plus the fact that it timed out
- output is stdout and stderr interleaved, truncated to the middle-out limit `tailOf` already applies, with the exit code named
- an abort returns `the operator aborted this command` as the result — the wording [plan 9](09-aborting-one-command.md) depends on

`CheckRunner.start` grows an optional `signal` and kills the child on it. That is the only change to the checks slice, and a check that passes no signal behaves as it does today.

### the result tools

The wording of `submit` and `blocked` is prompt surface and **must not fork** while both agent types exist. The strings — descriptions, snippets, guidelines, `verdict()` — stay in `result-tools.ts`; the pi extensions keep wrapping them in `defineTool`; the inline set builds its own definitions from the same constants. Two shapes, one text, and a test that asserts it.

Calling one sets `terminate`, which the loop reads as the turn ending. `isResultTool` and `resultFromCall` in `agents/domain/results.ts` are unchanged and are what the run raises `onResult` through.

## The change

| File                               | Layer    | Is                                              |
| ---------------------------------- | -------- | ----------------------------------------------- |
| `kernel/domain/within.ts`          | domain   | the guard                                       |
| `kernel/domain/within.test.ts`     | domain   | the table                                       |
| `agents/adapters/tools/bash.ts`    | adapters | the sandboxed command                           |
| `agents/adapters/tools/files.ts`   | adapters | `read`, `write`, `edit`                         |
| `agents/adapters/tools/results.ts` | adapters | `submit`/`blocked` from the shared constants    |
| `agents/adapters/tools/index.ts`   | adapters | the set for a role, given a worktree and a root |
| `checks/adapters/check-runner.ts`  | adapters | an optional `AbortSignal`                       |
| `docs/sandbox.md`                  | doc      | the boundary in two halves                      |

## Tests

`within.test.ts`, a table, no filesystem: the root itself; a child; a nested child; `..` out; `../..` out; an absolute path elsewhere; `/w/task-10` against root `/w/task-1`; a target with a trailing slash; an empty target.

`agents/adapters/tools/*.test.ts`, against a real temp directory:

- `read` returns a file under the root, and refuses one outside it with a message and no throw
- `read` of a missing file is a refusal, not a throw
- `write` creates parent directories, and refuses a path outside the root
- `write` through a symlink pointing out of the root is refused
- `edit` replaces one occurrence; refuses when `old` occurs twice; refuses when it occurs never; each with a message saying which
- `bash` runs in the worktree and returns stdout, stderr and the code
- `bash` past its timeout is killed and says so
- `bash` under an aborted signal returns the operator wording
- output past the limit is truncated and says it was
- every tool's arguments are parsed, and a bad bag is a refusal rather than a throw
- `submit`'s description in the inline set is `===` the pi extension's, for every role

## Done when

The tool suites are green, `bun test` is green, and no tool anywhere in the set can write outside the task's runtime directory except through `bash`, which the kernel refuses.

## Not this plan

The loop that calls them, the transcript they append to, and turning the console's `[abort]` into a command-level abort — [plan 9](09-aborting-one-command.md) does the last, and this plan only makes the wording it needs exist.
