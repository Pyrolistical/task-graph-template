# 1 · the http server

The [plan](http-server.md#the-plan)'s first change, in detail. The stdio process serves the route table on loopback, and the tools and resources become clients of it — the wire the [design](http-server.md) draws is live before any refactoring lands, and every later step runs against it. The port is the process's own: in this phase only its own tools use it, and one manager runs stdio at a time, so the bind is uncontended. From the manager's perspective nothing has changed — same tools, same names, same payloads, same stdio.

**Needs first:** nothing.

## The route table

`main/http.ts` — a small router, method and path segments, no framework, on `Bun.serve`. One route per verb, the verbs of [the api](http-server.md#the-http-api) minus the registry's — no `POST /project`, no `GET /project`, no `GET /project/:key`:

```text
GET  /health
POST /project/:key/prompt/reload
POST /project/:key/scheduler/enable
POST /project/:key/scheduler/disable

POST /project/:key/task                    { title }
PUT  /project/:key/task/:id/body           { body }
POST /project/:key/task/:id/enter/:entry   submit_designing | submit_planning | submit_working
POST /project/:key/task/:id/feedback       { findings: [ … ] }
POST /project/:key/task/:id/resume
POST /project/:key/task/:id/hold           { reason }
POST /project/:key/task/:id/submit
POST /project/:key/task/:id/abort

POST /agent/:agent/enable
POST /agent/:agent/disable
PUT  /agent/:agent/slot                    { slots }
POST /slot/:slot/abort

GET  /project/:key/inbox
GET  /project/:key/task
GET  /project/:key/check
GET  /slot
GET  /queue
```

- the `:key` of a `/project/:key/…` route must be the [key](http-server.md#the-project-registry) of the checkout the process started in — `repoKey`, the absolute path with `/` → `-` — and a `:key` that is not is a 404 with `{ error }` naming the project
- the pool verbs are not project-scoped — `/agent/…`, `/slot/…` — because the pool is the machine's, even while one project serves it
- every noun in a path is singular

## The handlers

Every handler is a tool body of today with the seam moved one layer down: the verb calls the `App` exactly as the tool does — `app.graph.create(title)`, `app.graph.enter(id, name)`, `app.pool.setAgentSlots(agent, slots)` — so the judgements, the refusal texts and the payloads are what the manager sees today.

- the held failure comes first: while an error stands — the startup error or `health.lastError` — every route except `GET /health` answers 503 with `{ error }` carrying its text. `GET /health` always answers: `{ ok: true }` clean, 503 with `{ ok: false }` and the text while one stands. The first clean tick clears the error — a full disk that gets emptied needs no restart
- the `applied()` tail stays the last line of every mutating handler: apply the edit, then `app.reports.write()`, before the answer — what a manager reads next, by route or by file, is what its call just did. Step 1 keeps the tail writing every view; the subset of affected views is a later optimization, and the invariant the tests pin — the answer arrives after the views are written — holds either way
- a refusal is a 4xx with `{ error }`, and the text is what the model reads, verbatim: the bad state names the state it found, the unknown id names the id, slots above `maxSlots` name the ceiling. A refusal is a fact, not a failure, and the clients do not retry
- the arguments are parsed, never asserted — the zod schemas move to `main/schemas.ts`, shared by the door and the table: the door validates a tool's input before the wire, the table validates a body on the wire, and a body that does not parse is a 4xx carrying the schema's message

## The client

`main/mcp.ts` — the tools and resources become thin fetches to the table: one request per verb, no retry, the fetch carrying an abort signal where the door provides one (the stdio door does not today; the [extension](http-server-pi-ext.md) will).

- a success is the body as the answer — the same `json()` and `text()` shapes the tools answer today, so a curl and the tool see one payload
- a 4xx or 503 is its `{ error }` as the tool's error, the text verbatim — the model reads it and decides
- a connection failure is `the server is not reachable at <url>` — the listener is the process's own, so this names a bug rather than crashing
- the base url is the one the listener bound, handed to the client in process — no env var between a process and itself. `TASK_GRAPH_SERVER_URL`, default `http://127.0.0.1:8787`, is what the listener binds, read in `main/serve.ts`

The door's names do not change. The five view resources fetch their GETs — `inbox` onto `/project/:key/inbox`, `slots` onto `/slot`, `checks` onto `/project/:key/check`, `tasks` onto `/project/:key/task`, `queue` onto `/queue` — and `error` onto `GET /health`, one source for the text. `paths` and `workspace_path` stay in process for this step — their routes are the registry's reads, which land with the [registry](http-server.md#the-plan). `build()` takes the url beside the `Startup`: the two in-process resources read the `Startup`, and everything else fetches.

## Bind, and what fails

`main/serve.ts`:

- the listener binds loopback **before** `serveStdio` answers tools — a tool's first act is its fetch, and a fetch before the listener is up is a connection error
- a bind failure — the port taken, loopback refused — is a process that exits with the reason in `server.log`: the tools cannot work without the listener, so there is no degraded mode left to serve
- the wiring failure is unchanged in what the manager sees: `boot()` still answers the error, the routes 503 with it and `GET /health` carries it, and the stdio door still answers, because the manager's prompt is the one that asks what went wrong

## The change

Every file sits in `main/` or `testing/`:

| File                    | Is                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/http.ts`          | the route table: the routes, the key check, the 503 rule, the views' GETs reading the same files the publisher writes                                                                        |
| `main/schemas.ts`       | the zod argument schemas, shared by the door and the table                                                                                                                                   |
| `main/mcp.ts`           | the tools and resources as thin fetches; the `applied()`, `live()` and `started()` closures go                                                                                               |
| `main/serve.ts`         | the listener bound before `serveStdio`, the url handed to the client, the bind failure an exit with the reason in `server.log`                                                               |
| `testing/server-jig.ts` | the jig binds the listener on an ephemeral port and stores the bound url in the rig — `httpUrlOf(app)` — so `serverFor` keeps answering the `App` and the wire is there when a test wants it |
| `bdd.test.ts`           | the new behaviours, regenerated with `bun run bdd`                                                                                                                                           |

## Tests

`main/http.test.ts` — the table against the jig's one project:

- every verb answers over the wire what the tool answered in process before the change — one assertion per verb: create, body, the three enters, feedback, resume, hold, submit, abort, the scheduler pair, reload, the agent pair, slots, slot abort, the five views
- the mutation's answer is after the views — hold a task over the wire, and when the fetch resolves the view file on disk carries the hold
- the 4xx texts — a submit from the wrong state names the state it found; a verb that names an id the graph does not hold names the id; slots above the ceiling name the ceiling; a `:key` that is not the process's is refused, naming the project
- while the error stands — `health.fail` from the jig — every route except `GET /health` answers 503 carrying the text, `GET /health` answers with `{ ok: false }` and it, a clean tick clears it, and the routes answer as they did before
- `GET /health` clean is `{ ok: true }`

`main/mcp.test.ts` — the client:

- a tool's answer is the body of its route — a hold through the tool and a hold through the route are one payload
- a resource reads the view its route serves — the `inbox` resource is the rows `GET /project/:key/inbox` serves
- a 4xx or 503 is the `{ error }` as the tool's error, the text verbatim
- a connection failure — the listener closed — is `the server is not reachable at <url>`

`main/serve.test.ts` — the process:

- the listener is up before the first tool answers — the jig's first tool call is a fetch, and it answers
- a bind failure — a second process on the same port — exits with the reason in `server.log`

The BDD behaviours that land with this step, in the form [the suite takes them](bdd-tests.md), are the single-project subset of the [design's](http-server.md#testing): a mutation answers once its views are written; a verb that names an unknown task is refused; a verb in the wrong state is refused; slots above the ceiling are refused; the server's failure holds every endpoint; the health check carries it and answers while the server is clean; a held failure clears on the first clean tick; a manager that finds no server is told the url. The multi-project forms — a project's failure holding only its own verbs, the registry's reads — land with the [registry](http-server.md#the-plan).

## Done when

- a manager's whole loop — read the inbox, act, re-read — runs unchanged over stdio with the tools over http
- `bun test` and `bun run typecheck` green, `bun run bdd` regenerated

## Not this step

- the registry — no `POST /project`, no `projects.json`, the `:key` pinned to the process's one, `paths` and `workspace_path` still in process: step 4
- the manager's door — stdio until the mcp interface: step 5
- the two-tier failure — one error until lifecycle: step 7
- the views' split, `project` on the rows, the tail's subset of views — until the registry: step 4
