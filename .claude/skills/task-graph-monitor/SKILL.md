---
name: task-graph-monitor
description: Watch the task-graph manager inbox and clear it as work arrives. Only use when task-graph mcp is installed.
---

Clear what is waiting with the task-graph-inbox skill, then watch for the next arrival.

`orchestrator://paths` gives `views.inbox`. The server rewrites that file every tick, so poll its rows and report only the ones that are new:

```bash
view=VIEWS_INBOX
prev=""
while true; do
  rows=$(jq -r '.inbox[] | "\(.rank) \(.task_id) \(.title)"' "$view" 2>/dev/null) || { sleep 5; continue; }
  cur=$(printf '%s' "$rows" | sort)
  if [ -n "$cur" ]; then
    comm -13 <(echo "$prev") <(echo "$cur")
  fi
  prev=$cur
  sleep 5
done
```

Arm that with Monitor, persistent. Every event is another run of task-graph-inbox; the watch stays armed across them.
