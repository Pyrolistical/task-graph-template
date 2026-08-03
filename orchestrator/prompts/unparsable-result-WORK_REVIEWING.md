Your last action was not a valid result for this step:

```
{{#issues}}
{{message}}
{{/issues}}
```

The result must be a call to one of these tools, as your last action, with
nothing after it:

- `submit` — with `findings` naming the defects in this work (an empty list
  means you are satisfied) and `delegations` naming the defects outside it.
- `blocked` — with `message` naming the one thing that stands in the way.

Submit again by calling the right tool. Nothing you did in this session is
lost.
