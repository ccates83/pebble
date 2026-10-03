# Data model

The vocabulary in `packages/core/src/types.ts`. Everything an adapter produces is
one of these shapes, which is what lets the UI stay vendor-agnostic.

## `SessionSummary`

One agent session. What a list row needs and no more — the heavy parts
(`events`, `subagents`) live on `SessionDetail`.

Fields worth explaining:

| Field | Note |
|---|---|
| `title` / `titleSource` | Best available name, and where it came from: `custom` (you named it) → `ai` (the tool named it) → `agent` → `prompt` (its first real prompt) → `fallback` (a truncated id). Shown in the UI so a generated name isn't mistaken for one you chose. |
| `projectPath` | The *recorded* working directory, not one decoded from a directory name. See `docs/DECISIONS.md`. |
| `status` | Inferred. See Architecture. |
| `pendingToolCalls` | Tool calls with no result by the end of the transcript. The signal behind `waiting`. |
| `tokens` | Six buckets, because they price differently: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `thinking`. |
| `subagentTokens` / `subagentCost` | Sub-agent usage, deliberately *not* folded into the parent's. |
| `issues` | What the parser noticed while reading this session. |

`thinking` is reported separately but is already inside `output` — it is not
billed twice, and `billableTokens` excludes it.

## `TokenCounts` and why cache writes are split

Cache writes are billed at 1.25× input at the 5-minute TTL and 2× at one hour.
Transcripts record the split (`cache_creation.ephemeral_5m_input_tokens` /
`ephemeral_1h_input_tokens`), so Pebble prices them separately. Older transcripts
only have a lump `cache_creation_input_tokens`; that is attributed to the
5-minute TTL because it is the default, and the difference is a rounding error
against the honesty of not inventing a split.

## `Cost`

```ts
{ usd: number; basis: CostBasis; unpricedModels: string[]; conflict?: {...} }
```

`basis` is the whole point:

| `basis` | Meaning | UI |
|---|---|---|
| `reported` | The agent tool recorded this itself. Trusted over anything computed. | plain |
| `exact` | Computed, and every model matched the price table exactly. | plain |
| `estimated` | At least one model was priced at its family's rate. | `~` |
| `partial` | At least one model couldn't be priced, so its usage is *missing* from the total. | `?` |

`conflict` is set when a reported figure and a computed one disagree by more than
the tolerance (the larger of one cent and 2%). Both numbers are kept; the
reported one is displayed; the UI shows `*` and the tooltip explains. Usually it
means the price table is stale for one of that session's models.

## `SessionEvent`

A flat, ordered list — `seq` is position in the file and the only reliable
ordering key. `kind` is one of `prompt`, `response`, `tool-call`, `tool-result`,
`hook`, `error`, `meta`. `text` is a truncated gist, chosen per tool so a Bash
call shows its command and an Edit shows its path.

Events are built only when asked (`withEvents`), because indexing doesn't need
them and building them for 24 sessions would be wasted work.

## `SubagentSummary`

A sub-agent run, from its own transcript. Carries its own tokens, cost, tool
count and errors, plus the task text it was handed as its title.

## `ConfigItem` and `ConfigSurface`

One configuration thing: an agent, skill, command, hook, MCP server, plugin,
memory file or settings file.

- `scope` — `plugin` < `user` < `project` < `local`, in resolution order.
- `path` vs `realPath` — `realPath` is set only when `path` is a symlink. Config
  symlinked out of another repo is common and worth seeing.
- `meta` — kind-specific extras: a hook's event and matcher, an MCP server's
  transport, a skill's declared tools, whether a skill came from the synced
  bucket.
- `issues` — per-item findings with a stable `code` so the UI can group them and
  the docs can explain them.

`ConfigSurface.shadowed` lists definitions that exist at more than one scope,
resolved per project: a project's `review` agent shadows the global one *for that
project*, and two projects each having a `review` agent is not a collision at all.
Only `agent`, `skill`, `command` and `mcp-server` can shadow — memory files
concatenate, settings merge, hooks all run, and a plugin enabled twice is just
enabled.

## `Issue`

```ts
{ level: 'error' | 'warn' | 'info'; code: string; message: string; path?: string }
```

`code` is stable and machine-readable; `message` is written for a human who has
not read the source. Current codes:

| Code | Level | Meaning |
|---|---|---|
| `transcript.partial-lines` | info | A line couldn't be parsed. Normal for a live session. |
| `transcript.cwd-inferred` | info | No cwd recorded; the path shown was decoded from the directory name and may be wrong. |
| `cost.disagreement` | warn | Reported and computed costs differ beyond tolerance. |
| `cost.host-unknown-model` | warn | The agent tool itself flagged a model it couldn't price. |
| `settings.invalid-json` | error | The file will be ignored by the tool. |
| `path.broken-symlink` | error | Symlink with no target; the tool sees nothing there. |
| `definition.no-description` | warn/error | No `description` in frontmatter. Fatal for a skill — that field is how it gets selected. |
| `definition.no-frontmatter` | warn/info | No frontmatter block at all. |
| `definition.name-mismatch` | warn | Frontmatter `name` differs from the directory. The directory wins. |
| `definition.empty-body` | warn | Frontmatter but no instructions. |
| `skill.missing-manifest` | warn | A directory under `skills/` with no `SKILL.md`. |
| `skill.nested` | info | Deeper than `skills/<name>/SKILL.md` and not in the synced bucket. |
| `memory.large` | warn | A `CLAUDE.md` big enough to tax every request in its scope. |
| `project.missing` | info | History exists for a directory that no longer does. |
| `adapter.root-missing` | error | No config directory found. |
| `index.source-failed` | warn | A transcript couldn't be indexed. |
