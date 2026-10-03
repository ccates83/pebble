# Pebble

A local control center for AI coding agents — what they're doing, what they cost,
and what your configuration actually adds up to.

Pebble reads what agent tools leave on disk. It doesn't wrap them, doesn't proxy
them, and doesn't need an API key. Claude Code is supported today; the adapter
layer exists so a second tool is a class, not a rewrite.

```bash
pnpm install && pnpm build
node packages/cli/bin/pebble.mjs serve --open
```

Dashboard on `http://127.0.0.1:7777`.

## What it shows you

**Fleet** — which agents are working right now, which are waiting on you (an
unanswered tool call usually means a permission prompt), where the money went in
the last 30 days, and which projects are consuming it.

**Sessions** — every session across every project, filterable by state, project,
model and text, sortable by anything. Open one for its full timeline: prompts,
tool calls and their results, hook events, errors, cache hit rate, and a
per-agent breakdown of every sub-agent it spawned.

**Config** — an inventory of every agent, skill, command, hook, MCP server,
`CLAUDE.md` and settings file this machine would load, across your global config
and every project your agent tool knows about. With what's wrong: broken
symlinks, invalid JSON, skills with no description, directories that look like
skills but aren't, and definitions that exist at more than one scope.

**Analytics** — spend by day, project and model; tool use by frequency and by
calls-per-session.

**Doctor** — a deterministic health check. No model is called to produce it,
which is the only reason it's worth trusting as a check.

## Two things it does differently

**Every number carries its provenance.** Pebble prefers the cost your agent tool
recorded itself. Where it has to compute one, it says so. Where it can only
estimate — an unrecognized model priced at its family's rate — it marks the
figure `~`. Where its own calculation disagrees with the reported one, it shows
`*`, keeps both numbers, and tells you which it displayed. It will not quietly
reconcile a disagreement into a confident answer.

**Sub-agent cost is kept separate.** Sub-agents get their own transcripts, so
Pebble can price each one. Whether the parent session's reported cost already
includes them isn't something the transcripts state — so Pebble shows both
figures, labelled, instead of adding them and risking a double count.

## Read-only, by design

Pebble does not write to `~/.claude`, start or stop agents, install hooks, or make
network requests. It parses files and serves a localhost page. Its own index is a
cache in `~/.pebble` that can be rebuilt from your transcripts at any time, or
deleted.

It binds to `127.0.0.1` and has no authentication, because it holds the contents
of your prompts. Don't expose it.

The index stores session metadata and a short preview of each session's first
prompt, for search. Full prompt and response text is never copied into it —
detail views re-read the transcript on demand, so Pebble doesn't become a second
copy of everything you've said to an agent.

## CLI

```
pebble serve [--port N] [--host H] [--open]   Dashboard and API
pebble sessions [--status s,s] [--limit N]    List sessions
pebble show <session-id> [--events N]         One session in detail
pebble config [--kind K] [--issues]           The whole config inventory
pebble cost [--days N]                        Spend by day, project and model
pebble index [--force]                        Re-read transcripts
pebble doctor                                 Health check; exits non-zero on error
pebble where                                  Paths Pebble reads and writes
```

Every command takes `--json`.

## Requirements

Node 22.5+ (for the built-in `node:sqlite`), pnpm 10, and an agent tool worth
watching. macOS and Linux; Windows is untested.

## How it works

A poll — not a hook. Every couple of seconds Pebble stats each transcript and
re-parses only the ones whose size or mtime moved, which is why installing it
changes nothing about your setup. A full pass over 24 unchanged sessions here
takes about 150ms. Changes are pushed to open dashboards over SSE.

See `docs/ARCHITECTURE.md` for the data flow, `docs/ADAPTERS.md` to add another
tool, `docs/DESIGN.md` for the interface rules, and `docs/DECISIONS.md` for why
things are the way they are.

## Status

v1 watches and inventories. It deliberately has no control verbs — no launching,
stopping or queueing agents from the dashboard. `docs/ROADMAP.md` covers what
comes next and what would have to be true first.

MIT.
