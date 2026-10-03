# Decisions

Why things are the way they are, so they don't get "fixed" back.

## Read-only in v1

Observability and inventory first; no launching, stopping or queueing agents from
the dashboard. The read-only guarantee is what makes Pebble safe to point at a
real machine with real client work on it, and it is a claim made in the README,
the CLI help and the UI. Breaking it is a product decision, not a refactor.

## Poll transcripts; don't install hooks

Hooks give sub-second liveness but require editing the user's global
`settings.json` — which on this machine is a symlink into a separate repository.
A poll costs a readdir and a stat per session (≈150ms for 24 sessions, nearly all
of it skipped), works retroactively on history that predates Pebble, and means
installing Pebble changes nothing about your setup. If hooks arrive later they are
an *additional* source, and Pebble must keep working without them.

## TypeScript end-to-end

One language across the parser, the API and the UI; the same ecosystem as the
agent tooling being watched; one process to run. The web package imports its API
types from core, so a shape change is a compile error rather than a runtime
surprise. The alternative considered was Python + React, which is what the
reference guide this project drew on recommends — rejected only because it means
a venv and two languages for one user.

## `node:sqlite`, not better-sqlite3

Built into Node 22.5+, so there is no native module to compile and no postinstall
step. It is still flagged experimental, which is why the CLI binary filters that
one warning rather than printing it on every run. It has no `transaction()`
helper, hence the explicit `BEGIN`/`COMMIT` wrapper in the store.

## The index is a cache, and rows are replaced whole

A session row is derived from exactly one file and written wholesale. Nothing is
merged field by field, which structurally eliminates the "a failed read returned
zero and overwrote good data" bug — there is no code path that can do it.
`pebble index --force` must always be able to rebuild everything from the agent
tool's own files.

## Prompt text is not copied into the index

Only a ~400 character preview of each session's first prompt, for search. Detail
views re-read the transcript on demand. Pebble should not become a second,
differently-secured copy of everything you have ever said to an agent.

## A reported cost beats a computed one, and disagreements are shown

Claude Code records `totalCostUSD` in `cost-state`. That is the billing-side
truth. Where Pebble's own calculation disagrees by more than the larger of one
cent and 2%, both figures are kept, the reported one is shown, and the UI marks
it. Quietly picking one would turn an open question into a confident answer; the
gap is nearly always a stale price table, which is information worth having.

## Sub-agent cost is reported separately, not added

Sub-agents have their own transcripts and can be priced individually. Nothing in
the transcripts says whether a parent's reported cost already includes them.
Adding them risks double counting; omitting them under-reports. So both numbers
are shown, labelled. If the vendor documents the relationship, this becomes a
one-line change and a note here.

## An unknown model is priced at its family's rate and marked

A model id that isn't in the table — a point release that shipped after the table
was written, like `claude-opus-5-5` — prices at its family's going rate with
`basis: 'estimated'`, and the figure renders with a `~`. The alternatives were
showing zero (wrong, and invisibly so) or refusing to show a cost (unhelpful).
Dated snapshots (`claude-haiku-4-5-20251001`) are the same model at the same
price, so they are normalized to an *exact* match, not an estimate.

## The project directory name is never trusted as a path

Claude Code names project directories after the cwd with `/` replaced by `-`,
which is ambiguous for any path containing a hyphen:
`-Users-me-connor-cates-site` has many valid decodings. The authoritative cwd is
the `cwd` field on the records. The decoder exists only for a directory whose
transcripts are empty, and it raises `transcript.cwd-inferred` when used. A test
asserts the wrong decoding on purpose, so nobody "fixes" the decoder into
appearing reliable.

## Only some config kinds can shadow

`CLAUDE.md` files concatenate up the tree, settings merge key by key, every
matching hook runs, and a plugin enabled at two scopes is just enabled. Only
`agent`, `skill`, `command` and `mcp-server` resolve by precedence. Reporting a
project `CLAUDE.md` as "overriding" the global one would be telling the user
something untrue about their own setup.

Shadowing is also resolved **per project**: a project's `review` agent shadows the
global one for that project only, and two projects each having a `review` agent is
not a collision. An earlier version grouped by scope and silently missed every
real global-vs-project override.

## Hash routing and no state library

Six views and one user. `useRoute` is thirty lines; React Router is forty
kilobytes. State is `useState` plus one SSE subscription that bumps a token every
view depends on.

## Four runtime dependencies

Hono, `@hono/node-server`, React, Vite (plus the React plugin). Everything else —
SQLite, file watching, argument parsing, SSE, frontmatter, the charts — is Node
built-ins or thirty lines. One user, one machine: there is no caching layer, no
message queue and no ORM. If a query gets slow it gets an index.

## Tests run against `dist`

They import the built output, not `src`. That tests what ships, and it avoids
needing a TypeScript loader for the test runner. The cost is remembering to build
first, which `pnpm check` does.
