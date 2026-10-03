# Adding an adapter

An adapter is the only part of Pebble allowed to know a vendor's name. Everything
else — routes, queries, views — works off the normalized types. Adding a tool
means writing one class.

## The contract

`AgentAdapter` in `packages/core/src/types.ts`. Four required methods:

```ts
detect(): Promise<AdapterPresence>            // is this tool here, and how do you know
listSessions(opts?): Promise<SessionSummary[]>
readSession(id): Promise<SessionDetail | null>
scanConfig(opts?): Promise<ConfigSurface>
watchRoots(): string[]
```

`detect` returns `evidence` as a sentence, because it is printed verbatim in
`pebble doctor` and "not found" without a reason is a bad bug report.

Two optional methods make indexing incremental:

```ts
listSources?(): Promise<SessionSource[]>          // cheap: readdir + stat
summarizeSource?(source): Promise<IndexedSession | null>  // parse exactly one
```

Implement both or neither. With them, the indexer skips anything whose `bytes` and
`mtimeMs` are unchanged. Without them it falls back to `listSessions()` and
re-reads everything — fine for tens of sessions, wasteful for thousands.

## Steps

1. `packages/core/src/adapters/<tool>/` with `index.ts` (the class), plus whatever
   `paths.ts` / `transcript.ts` / `config.ts` the format needs.
2. Register it in `defaultAdapters()` in `registry.ts`.
3. Export anything reusable from `packages/core/src/index.ts`.
4. Tests in `packages/core/test/`, built on fixtures you write to a temp dir.
   Point your adapter at them with an env var, as the Claude Code adapter does
   with `PEBBLE_CLAUDE_DIR` — never read the developer's real config in a test.

There is no UI work. The adapter shows up in the fleet view, every session table,
the config inventory and the doctor because none of them know what a Claude is.

## Things that will bite you

**Normalize, don't pass through.** If the tool reports cost in credits, convert it
and set `basis` honestly. If it reports no cost, compute from tokens and a price
table. If you cannot do either, leave `usd: 0` with `basis: 'partial'` and list
the model in `unpricedModels` — a confident zero is worse than a visible gap.

**Deduplicate usage.** Claude Code repeats one API response's `usage` across every
record of that response. Assume any append-only log does something similar until
you have checked, because the failure mode is a cost figure several times too
large that looks perfectly plausible.

**Never trust a path encoded in a filename.** Claude Code's project directories
replace `/` with `-`, which cannot be decoded. Prefer a path the tool recorded
inside the file; if you must decode, flag it with `transcript.cwd-inferred`.

**Expect truncated input.** A log being appended to right now ends mid-line.
Count it, raise `transcript.partial-lines`, carry on. Never throw.

**Every vendor field is optional.** Define your record types with everything
optional and guard every access. A new version of the tool will add, rename and
remove fields without telling you.

**Status is inferred.** Use `deriveStatus` rather than inventing another rule, so
every tool's sessions mean the same thing by `active`.

**Make failures `Issue`s.** An adapter that throws takes out the whole index pass.
An adapter that reports an issue tells the user exactly what to look at.

## Control verbs

v1 is read-only on purpose. When launching and stopping agents arrives, it goes in
a *separate* optional interface (`AgentController`) that an adapter may implement,
so a read-only adapter stays a complete adapter and the UI can tell which tools
can be driven. Do not add write methods to `AgentAdapter`.
