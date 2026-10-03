# Architecture

```
~/.claude/projects/**/*.jsonl ──┐
~/.claude/{settings,agents,…} ──┼─→ adapter ─→ core types ─→ SQLite index ─→ API ─→ dashboard
<project>/.claude/** ───────────┘      │                         ↑            │
                                       └── config surface ───────┘         SSE push
```

Four packages, one direction of dependency: `web → server → core`, with `cli`
depending on `core` and `server`. Nothing depends on `web`.

## The flow

1. **An adapter** finds sessions and describes each one's backing file cheaply
   (`listSources`: a readdir and a stat).
2. **The indexer** asks the store which of those are stale — size or mtime moved
   — and parses only those (`summarizeSource`). An adapter that can't do this
   gets re-read in full, which is fine for tens of sessions.
3. **The store** holds one row per session. Writes replace the whole row from the
   parsed file; nothing is merged. Then statuses are recomputed against the
   clock, because "active" is time-relative and goes stale without the file
   changing.
4. **The API** serves the index. Session *detail* is the exception: it re-reads
   the transcript on demand rather than storing every event, so the index stays
   small and never becomes a second copy of your prompts.
5. **The dashboard** subscribes to SSE. One subscription for the whole app bumps
   a token that every view depends on, so there is no per-view polling.

## Why a poll and not hooks

Hooks would give sub-second liveness, but installing them means editing the
user's global `settings.json` — which on this machine is a symlink into another
repository. A poll is slower by a second or two and costs nothing but a stat per
session, and it works retroactively on history that predates Pebble. The
`IndexLoop` is a plain `setInterval` around `indexAll`.

If sub-second events are wanted later, a hook becomes an *additional* source that
nudges the loop, not a replacement for it. Pebble must keep working with no hooks
installed.

## Where the layers stop

**core** knows about files, formats and arithmetic. No HTTP, no React, no
`process.stdout`.

**server** knows about HTTP. It builds no domain objects of its own; the one piece
of logic it owns is a cache around config scans, because a scan stats several
hundred files and should not run on a timer.

**cli** knows about terminals. It opens its own store and runs the indexer
directly — it does not talk to a running server, so every command works whether
or not `serve` is up.

**web** knows about pixels. It imports types from `@pebble/core` so the API shape
is checked at compile time, and ships none of that code — type-only imports
disappear.

## The index

SQLite via Node's built-in `node:sqlite`, in WAL mode so the dashboard can read
while the indexer writes. Three tables: `sessions`, `session_models`,
`tool_usage`, plus a `meta` key-value table carrying the schema version.

It is a **cache**. The rules that follow from that:

- Every row is derived from exactly one file and replaced wholesale. There is no
  path by which a short read blanks out a good value — the classic
  "scraper returned zero and destroyed my data" failure cannot occur here because
  nothing is ever merged.
- `pruneMissing` deletes rows whose transcripts are gone, so the index cannot
  outlive its source.
- Deleting `~/.pebble` is a supported operation.

Schema changes bump `SCHEMA_VERSION`. Because everything is derivable, the
migration strategy for a breaking change is to rebuild rather than to migrate.

## Status derivation

Nothing publishes liveness, so status is inferred from evidence:

| Status | Means |
|---|---|
| `active` | wrote to its transcript within 90s |
| `waiting` | quiet, and its last act was an unanswered tool call — usually a permission prompt |
| `idle` | quiet under 30 minutes |
| `done` | quiet longer than that |

`waiting` outranks `idle` because it is the only state worth interrupting someone
for. The windows are a parameter (`StatusWindows`) precisely because they are a
guess.

## Config scanning

Separate from session indexing and on demand, not on a timer. For each scope it
walks `agents/`, `commands/`, `skills/`, the settings files, the memory files and
`.mcp.json`, reads frontmatter, resolves symlinks, and attaches an `Issue` to
anything suspect.

The scope model matters. `user` is `~/.claude`. `project` is `<project>/.claude`
plus the project's `CLAUDE.md`. `local` is `settings.local.json` *only* — it lives
in the same directory as the project scope, so scanning definition directories
again under `local` would double-count everything.
