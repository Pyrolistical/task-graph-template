You have run this exact command {{limit}} times in a row:

```
{{command}}
```

Your turn was interrupted, so nothing is lost — but that command has stopped
telling you anything new. A command that gives byte-identical output ten times
running is not going to give you a different one on the eleventh, and the answer
you are looking for is not in it.

Read its output once more as though someone else had sent it to you. If it names
a file, a path or a permission, the fault may sit outside your diff entirely —
in the environment this task runs in, not in the code you changed. A build that
cannot write its cache fails the same way whether your patch is right or wrong.

Then do one of two things:

- If there is something else to try — a different command, a different reading
  of the error, a way around it — try that instead. Do not run the repeated
  command again to confirm it still fails.
- If you have no way past it, call the `blocked` tool with a `message` naming
  the one thing that stands in the way.

  Make that message the thing you learned, not the thing you attempted: name the
  command, the error it gives and what you think it needs. The manager reads
  this and can change the environment; it cannot see your terminal.
