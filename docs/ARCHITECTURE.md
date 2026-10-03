# Architecture

```
~/.claude/projects/**/*.jsonl ──┐
~/.claude/{settings,agents,…} ──┼─→ adapter ─→ core types ─→ SQLite index ─→ API ─→ dashboard
<project>/.claude/** ───────────┘      │                         ↑     ↑      │
                                       └── config surface ───────┘     │   SSE push
<org root>/org.json + vaults ─────────→ org reader (per request) ──────┘ (/api/hq)
```

Everything on the left is read, never written. That covers the org root as
much as `~/.claude`: Pebble opens `org.json` and the vaults beneath it to look,
and has no code path that writes there.

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

## The org

Pebble sits inside a holding company: an org root with `org.json`, an `HQ/`
vault, one vault per subsidiary, and tooling repos. `packages/core/src/org/`
reads it.

- **Finding it.** `--org`, then `PEBBLE_ORG_ROOT`, then the nearest ancestor of
  the working directory holding an `org.json`, then `~/Development`. An explicit
  choice is honoured even if it holds no `org.json`; the view then says so
  rather than quietly showing a different org.
- **Reading it.** `readOrg` walks `org.json` and the vault conventions —
  approvals, inbox, self-improvement proposals, changelog, weekly reviews,
  charters, department scorecards, agent definitions, `_HQ/SYNCED.md` — and
  returns an `OrgSnapshot`. It never throws; a malformed `org.json` or a missing
  vault is an `Issue` on the snapshot. The drift checks mirror `org status` in
  HQ's `org` script so the terminal and the dashboard agree.
- **Joining it to sessions.** `placeSession` maps a session's working directory
  to HQ, a subsidiary, a tooling repo, or outside — longest prefix on whole path
  segments. A department is attributed only on evidence: the session ran as that
  department's agent, or spawned a sub-agent of that type (from the `subagents`
  table, so no transcript is re-parsed per request).
- **Serving it.** `buildHqOverview` produces `GET /api/hq` from a fresh snapshot
  and the index. Attention items are derived on every call and never stored.
- **Keeping it live.** The org is not indexed, so on every loop tick the server
  takes a stat-only fingerprint (org.json, each vault's approvals, inbox,
  proposals and reviews folders and the files in them, changelog and charter)
  and publishes `{type: 'org'}` on the event bus when it moves.

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
while the indexer writes. Four tables: `sessions`, `session_models`,
`tool_usage` and `subagents` (one row per sub-agent run: who ran, its title,
status and times — not its cost), plus a `meta` key-value table carrying the
schema version.

It is a **cache**. The rules that follow from that:

- Every row is derived from exactly one file and replaced wholesale. There is no
  path by which a short read blanks out a good value — the classic
  "scraper returned zero and destroyed my data" failure cannot occur here because
  nothing is ever merged.
- `pruneMissing` deletes rows whose transcripts are gone, so the index cannot
  outlive its source.
- Deleting `~/.pebble` is a supported operation.

Schema changes bump `SCHEMA_VERSION`. Because everything is derivable, the
migration strategy for a breaking change is to rebuild rather than to migrate:
opening a store whose recorded version differs drops every derived table, and
the next index pass refills them from the transcripts.

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
