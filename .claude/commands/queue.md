---
description: Pick up the next task from queue/ and work it
argument-hint: "[task-name]"
---

Work the task queue in `queue/`.

1. List `queue/*.md`, skipping `README.md`. If a name was given in `$ARGUMENTS`,
   use that file; otherwise read them all and pick the smallest unblocked one —
   small before large, since finished work beats work in progress.
2. Read the file. It states a problem, not an implementation.
3. Dispatch the right agent: `pebble-core` for anything outside
   `packages/web`, `pebble-web` for the dashboard. If it needs both, sequence
   them — core first, since the API shape determines the UI's work.
4. When the agent reports back, run `/check`.
5. On a clean verification, `git mv` the queue file to `queue/done/` (create it if
   needed) and summarise what changed in one line.
6. If the task turned out to be wrong, underspecified, or bigger than it looked,
   say so and leave the file where it is. Rewriting the task to match what you
   felt like doing is worse than not doing it.

Do not pick up a second task in the same pass.

$ARGUMENTS
