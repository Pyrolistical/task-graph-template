# The pi extension

The next phase of the [HTTP server](http-server.md): the pi manager. The first phase serves one kind of manager — a Claude Code session over `/mcp` — and this extension is a second thin client of the same stateless HTTP api, so a pi session drives its project the way the claude manager does. The verbs, the payloads and the refusals are the api's; the extension adds none of them.

The pi manager is a `pi` session started in the project's checkout, carrying one extension. It lives in `~/.pi/agent/extensions/task-graph/` (or a project-local `.pi/extensions/`); `TASK_GRAPH_SERVER_URL` points it at the server, defaulting to `http://127.0.0.1:8787`:

```text
~/.pi/agent/extensions/task-graph/
  index.ts    the factory: the project binding, the tools, the session events
  client.ts   one fetch per verb; the base url; the error text verbatim
  schema.ts   the typebox parameter schemas, the six-digit id check
```

- **the binding** — the extension derives the project key from `ctx.cwd` with the same path function the server uses — the absolute path with `/` → `-`, one line, duplicated into the extension and pinned to the server's by a test, because an unregistered project has no server-side name yet and registration takes the path anyway. On `session_start` it probes with `GET /project/:key`: a 200 notifies with the key and its open-task count, a 404 notifies that `project_register` is the first call. Every tool call re-checks, so a manager that skipped the register call gets the instruction in the tool result rather than a silent miss
- **the tools** — one per verb, named as the MCP tools are, each `execute` a single fetch carrying the call's `signal` and no retry. The descriptions move with the verbs, so the judgement explanations — _nothing checks that the body carries the design_ — read the same on both clients

| tool                                                      | call                                       |
| --------------------------------------------------------- | ------------------------------------------ |
| `project_register`                                        | `POST /project`, `path` defaulting to cwd  |
| `task_create { title }`                                   | `POST /project/:key/task`                  |
| `task_write_body { id, body }`                            | `PUT /project/:key/task/:id/body`          |
| `task_submit { id }`                                      | `POST /project/:key/task/:id/submit`       |
| `task_submit_designing` / `_planning` / `_working { id }` | `POST /project/:key/task/:id/enter/:entry` |
| `task_feedback { id, findings }`                          | `POST /project/:key/task/:id/feedback`     |
| `task_resume { id }`                                      | `POST /project/:key/task/:id/resume`       |
| `task_hold { id, reason }`                                | `POST /project/:key/task/:id/hold`         |
| `task_abort { id }`                                       | `POST /project/:key/task/:id/abort`        |
| `enable_scheduler` · `disable_scheduler`                  | `POST /project/:key/scheduler/…`           |
| `enable_agent` · `disable_agent { agent }`                | `POST /agent/:agent/…`                     |
| `set_agent_slots { agent, slots }`                        | `PUT /agent/:agent/slot`                   |
| `slot_abort { slot }`                                     | `POST /slot/:slot/abort`                   |
| `reload_prompts`                                          | `POST /project/:key/prompt/reload`         |
| `task_inbox` · `task_tasks` · `task_checks`               | `GET /project/:key/inbox · task · check`   |
| `task_slots` · `task_queue`                               | `GET /slot` · `GET /queue`                 |

- **the results** — the JSON body is the tool result; a 4xx or 503 is its `{ error }` as text, which the model reads and decides on rather than crashing; a connection failure is the url in the message. The `project_register` result additionally carries the paths — task directory, views, runtime root — because the manager still edits the documents it owns with ordinary file writes ([the manager owns what it holds](mcp.md#the-manager-owns-what-it-holds)), and the paths are how it reports them when something is wrong
- **what it is not** — it holds no state of its own, the server being the state; it opens no long-lived resources, every call being one fetch, so `session_shutdown` closes nothing; it polls nothing, the manager looping on its own judgement — idle → `task_inbox` → act, the [manager loop](mcp.md#the-manager-loop) unchanged in shape; and it exposes no generic transition tool, because one tool per judgement is the [authority](authority.md) rule, and it does not bend because the transport changed

The manager's loop instructions stay where they are — the checkout's own prompt — and only the tools they name have new implementations.

## The plan

One change, after the [http api](http-server.md#the-plan) of the first phase has landed:

### the extension

The pi manager: `~/.pi/agent/extensions/task-graph/`, one extension whose tools are the manager's verbs over the api.

**Needs first:** the stateless HTTP api of the first phase.

**The change**

- `index.ts` — the factory: the project binding, the tools, `session_start` probing `GET /project/:key` and naming `project_register` first on a 404
- `client.ts` — one fetch per verb carrying the call's `signal`, no retry; the base url from `TASK_GRAPH_SERVER_URL`; the error text verbatim
- `schema.ts` — the typebox parameter schemas and the six-digit id check, the names pinned to the MCP schemas

**Tests** — against a running server, one assertion per verb: the tool result is the JSON body, a 4xx or 503 is its `{ error }` as text, a connection failure is the url; the key function matches the server's on the same inputs, so an unregistered project registers and a registered one binds; `session_start` on an unregistered checkout says `project_register` is the first call.

**Done when** — a pi session in a checkout drives its project end-to-end over the api, and the suite is green.

**Not this** — nothing in the server: the extension holds no state of its own, opens no long-lived resources, and the loop instructions stay in the checkout's prompt.

## Testing

The extension is a client: it is tested against a running server the way the MCP client already is, one assertion per verb. The behaviours are written in the form [the suite takes them](bdd-tests.md), one per test:

### Feature: the pi extension

#### a session in a checkout is told the project it serves

- **Given** a pi session started in the checkout of a registered project
- **When** the session starts
- **Then** the session is told the key, and the number of its open tasks

#### a session in an unregistered checkout is told to register

- **Given** a pi session started in a checkout whose project is not registered
- **When** the session starts
- **Then** the session is told that registering the project is the first call

#### a tool call is one request, and its result is the body

- **Given** a pi manager bound to its project
- **When** it calls a tool over the api
- **Then** the tool's result is the call's body

#### a refused call comes back as text

- **Given** a pi manager bound to its project
- **When** it calls a tool the server refuses
- **Then** the result is the refusal's text, for the model to read rather than crash

#### a call that finds no server is the url

- **Given** a pi manager bound to its project
- **When** the server is down and it calls a tool
- **Then** the result is the url, and the call is not retried

#### the extension's key is the server's key

- **Given** a checkout at `~/my-project`
- **When** the extension derives the project key from the checkout
- **Then** it is `-home-model-my-project`, the key the server derives from the same path

## New words

| term      | is                                                                |
| --------- | ----------------------------------------------------------------- |
| extension | the pi extension whose tools are the manager's verbs over the api |
