---
description: Full verification pass — typecheck, build, tests, then the CLI and API against real data
---

Run Pebble's full verification by dispatching the `pebble-verify` agent. Do not
run the steps yourself; the point of the agent is that verification output does
not fill the main conversation.

When it reports back:

- If anything failed, show the actual output and fix it (or dispatch the right
  implementation agent), then verify again. Do not report success on a partial
  pass.
- If it passed, state the numbers it returned — sessions indexed, total cost,
  issue counts, timings — so the next run has something to compare against.

A cost total that changed since the last verification is the single most important
signal here. Explain why it changed before moving on.
