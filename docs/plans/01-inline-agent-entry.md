# 1 · the inline row in `agents.json`

Teach the pool file a second kind of agent. After this plan an inline row loads, names its slots, holds its endpoint and is refused precisely when it is wrong — and nothing can spawn one yet, which is fine: a slot of an unspawnable type is a slot the router refuses, and the router arrives in [plan 7](07-the-inline-run.md).

**Needs first:** nothing.

## The row

```json
{
  "agents": [
    {
      "type": "inline",
      "id": "sonnet",
      "api": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "model": "claude-sonnet-4-5",
      "contextWindow": 200000,
      "costPerMtokIn": 3,
      "costPerMtokOut": 15,
      "slots": 2
    },
    {
      "type": "inline",
      "id": "rocm",
      "api": "openai-completions",
      "baseUrl": "http://192.168.1.202:2345/v1",
      "model": "qwen3-coder",
      "contextWindow": 131072,
      "slots": 1,
      "healthCheck": true,
      "wattage": 300,
      "costPerKwh": 0.19,
      "roles": ["worker"]
    }
  ]
}
```

`slots`, `maxSlots`, `enabled`, `schedule`, `healthCheck`, `roles`, `write`, `wattage` and `costPerKwh` mean exactly what [Agents](../agents.md) says they mean, on either type. Everything below is what the two types do not share.

| Key              | `pi`     | `inline`            | Is                                              |
| ---------------- | -------- | ------------------- | ----------------------------------------------- |
| `provider`       | required | **refused**         | a key into pi's own catalog                     |
| `id`             | refused  | **required**        | the agent's name, and half of every slot name   |
| `model`          | required | required            | the model as its api names it                   |
| `api`            | refused  | **required**        | `anthropic-messages` or `openai-completions`    |
| `baseUrl`        | refused  | **required**        | the endpoint, trailing slash or not             |
| `apiKeyEnv`      | refused  | optional            | the **name** of an env var, never a key         |
| `contextWindow`  | refused  | **required**        | tokens, what `context_percent` is a fraction of |
| `costPerMtokIn`  | refused  | optional, default 0 | dollars per million input tokens                |
| `costPerMtokOut` | refused  | optional, default 0 | dollars per million output tokens               |

## Naming

`agentName` becomes a switch on type:

```text
pi      type-provider-model      pi-anthropic-claude-sonnet-4-5
inline  type-id                  inline-sonnet
```

`slotName` still appends `-index`, so this pool's slots are `inline-sonnet-1`, `inline-sonnet-2`, `inline-rocm-1`. That string is what lands in `claimed_by`, what `disable_agent` and `set_agent_slots` are keyed by, and what `agentOf` cuts the index off — none of which changes, because all of them already read the derived name and never the parts.

## Rejected on load

Every one of these is a `parse` issue with the offending path, not an exception at spawn:

- `type` outside `{"pi", "inline"}` — it is an enum now, not a free string, because a pool naming a type nothing can spawn should fail on load and not on the tenth dispatch
- a key belonging to the other type: `provider` on inline, `id`/`api`/`baseUrl`/`apiKeyEnv`/`contextWindow`/`costPerMtok*` on pi. `strictObject` per branch gives this for free and the message names the key
- `id` not matching `^[a-z0-9]+(-[a-z0-9]+)*$` — a name that comes back out of a claim should never need quoting
- `api` outside the two adapters, named in the message alongside what is supported
- `baseUrl` that is not a parseable `http`/`https` url
- `contextWindow` below 1
- `apiKeyEnv` naming a variable that is **unset or empty in the server's environment**, refused by variable name (never a value): a pool that cannot authenticate should say so at startup, not at the first turn
- a token price _and_ a meter on one row: any of `costPerMtokIn`/`costPerMtokOut` nonzero together with any of `wattage`/`costPerKwh` nonzero. One or the other, never both — the same rule [Agents](../agents.md#wattage-and-costperkwh) states for pi, now enforceable because both numbers sit in one file
- two rows deriving the same agent name. This replaces the `type+provider+model` duplicate check, and states the rule once over the thing that is actually unique

## The change

| File                            | Layer    | Change                                                                                                                |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `agents/domain/slots.ts`        | domain   | discriminated union over `type`; `AgentEntry`/`Slot` gain the inline fields; `agentName` switches; the refusals above |
| `views/slots.ts`                | views    | `provider`/`model` become `maybe`; add `id: maybe(z.string())`                                                        |
| `console/policy/panes.ts`       | policy   | `identity()` draws `inline sonnet` where it draws `pi anthropic/claude-sonnet-4-5`                                    |
| `agents/adapters/agent-pool.ts` | adapters | nothing: `agentWrite` already withholds `PI_HOME` from any non-pi slot                                                |
| `docs/agents.md`                | doc      | a `## type` section carrying the table above, and `## id`                                                             |

Keep one `Slot` type rather than two. The pool, scheduler and views handle slots without caring, and a union there would split every one of them; a `Slot` whose inline fields are set exactly when `type === "inline"` is a narrower thing to get right, and the parser is the only place it can go wrong.

## Tests

`agents/domain/slots.test.ts`, table-driven over the refusals — each names the message it expects:

- an inline row loads, and its slots are named `inline-<id>-<n>`
- a pi row is unchanged, name and all
- inline without `id`, and pi with one, are both refused
- inline with `provider` is refused by key name
- `id` with an underscore, a capital, a leading dash or a double dash is refused
- an unsupported `api` is refused and the message names the two that work
- `contextWindow` of 0 is refused; a missing one is refused
- `apiKeyEnv` naming an unset variable is refused by variable name, and the message contains no value; set it in the test and the same row loads
- a row with both `costPerMtokOut` and `wattage` is refused
- two inline rows sharing an `id` are refused; an inline `id` colliding with nothing else is fine
- an inline row and a pi row may sit in one pool and each keeps its own name

`console/policy/panes.test.ts`: an inline pane's header reads `inline sonnet slot 1 / 2`, and a pi pane's is byte-for-byte what it was.

## Done when

`bun test` and `bun run typecheck` are green, `tasks/agents.json` still loads unchanged, and a pool file holding one row of each type starts a server whose console draws two idle panes.

## Not this plan

Spawning, health-checking or dispatching an inline slot; the `Models` port; anything reading `contextWindow` or `costPerMtok*` at runtime. They are parsed, stored on the `Slot`, and used by [plan 4](04-the-models-port.md) and [plan 7](07-the-inline-run.md).
