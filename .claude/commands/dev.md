---
description: Start Pebble's API and the Vite dev server, and report where they are
argument-hint: "[--port N]"
---

Bring up the development environment for Pebble.

1. Build if `packages/core/dist` is missing or older than `packages/core/src`.
2. Start the API in the background, surviving task cleanup:
   `cd $CLAUDE_PROJECT_DIR && nohup node packages/cli/bin/pebble.mjs serve --port 7777 > /tmp/pebble-api.log 2>&1 & disown`
3. Start Vite the same way:
   `cd $CLAUDE_PROJECT_DIR && nohup pnpm --filter ./packages/web run dev > /tmp/pebble-web.log 2>&1 & disown`
4. Verify both: `curl -s http://127.0.0.1:7777/api/health` must return `ok: true`,
   and the Vite log must show a local URL. Check more than one API endpoint — a
   server can answer `/api/health` while every data route fails.
5. Report both URLs, and tail each log if either failed to come up.

Use `nohup ... & disown`, not a tracked background task: tracked tasks get cleaned
up between turns and the servers die with them.

$ARGUMENTS
