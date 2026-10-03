# Pebble

A local-first control center for AI coding agents. It reads what agent tools leave
on disk, normalizes it, and shows you what your fleet is doing, what it cost, and
what your configuration actually adds up to.

**v1 is read-only.** Pebble never writes to `~/.claude`, never spawns or stops an
agent, and never makes a network request. Its own index lives in `~/.pebble` and
can be deleted at any time. Pebble also reads the org root (`org.json` and the
HQ and subsidiary vaults under it) and never writes to it. Keep it that way unless the user explicitly asks for
control features — the read-only guarantee is the main reason this is safe to run
against a real machine, and it is stated in the README, the CLI help and the UI.

## Commands

```bash
pnpm install
pnpm build                    # core → server → cli (tsc), then web (vite)
pnpm check                    # typecheck + build + test — run before committing
pnpm test                     # node:test against packages/core/dist
node packages/cli/bin/pebble.mjs serve --open   # dashboard on :7777
node packages/cli/bin/pebble.mjs doctor         # deterministic health check
```

For UI work run two processes: `pebble serve` (API on 7777) and
`pnpm --filter ./packages/web dev` (Vite on 5173, proxying `/api` to 7777).

Tests import `packages/core/dist`, not `src` — they test what ships. Build before
testing; `pnpm check` does both in order.

## Layout

| Package | What lives there |
|---|---|
| `packages/core` | Domain types, the adapter contract, the Claude Code adapter, pricing, the SQLite index, the indexer, the doctor. No HTTP, no React. |
| `packages/server` | Hono API, SSE stream, static file serving. Thin — all logic is in core. |
| `packages/cli` | `pebble` commands and terminal formatting. |
| `packages/web` | React + Vite dashboard. Talks only to `/api`. |
| `docs/` | Architecture, the data model, the design system, how to add an adapter, decisions. |
| `queue/` | One markdown file per queued task, for unattended work. |

Read `docs/ARCHITECTURE.md` before changing how data flows, and
`docs/ADAPTERS.md` before adding support for another tool.

## Hard-won facts about Claude Code's transcripts

These were established by reading real transcripts on this machine. They are not
documented by the vendor and they are easy to get wrong. If you touch
`packages/core/src/adapters/claude-code/`, these are the traps:

1. **`usage` is repeated across records.** Claude Code writes one record per
   content block, and every record belonging to one API response carries an
   *identical* copy of `message.usage`. One real transcript here repeats a single
   usage block 152 times. Deduplicate by `message.id` or cost inflates several
   fold. `transcript.test.mjs` locks this down — do not "simplify" it away.
2. **The project directory name is a lossy encoding of the cwd.** `/` becomes
   `-`, so `-Users-me-connor-cates-site` cannot be decoded reliably. The real cwd
   is the `cwd` field on the records themselves. The decoder exists only as a
   last resort and flags itself when used.
3. **Sub-agents have their own transcripts**, at
   `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl`. They parse with the
   same parser. Their cost is reported *separately* from the parent's — the
   transcripts never say whether the parent's reported cost already includes
   them, so adding them together would risk double counting.
4. **`cost-state` records carry Claude Code's own `totalCostUSD`.** That is the
   billing-side truth and it wins over anything computed. When the two disagree
   beyond tolerance, both are kept and the disagreement is surfaced.
5. **A session's last timestamp can lag its file mtime**, because trailing
   bookkeeping records carry no timestamp. Liveness uses whichever is later.
6. **A transcript being written right now ends mid-line.** That is normal, not
   corruption. Count it and move on.
7. **The `local` scope shares a directory with the `project` scope.**
   `settings.local.json` sits in the same `.claude/` as the project's agents and
   commands, so scanning definition directories for both scopes lists everything
   twice and invents an override between a file and itself.
8. **`CLAUDE.md` files compose; they do not override.** Claude Code concatenates
   memory up the tree. Only `agent`, `skill`, `command` and `mcp-server` resolve
   by precedence, so only those can shadow one another.

## Conventions

**Numbers carry their provenance.** Every cost figure is a `Cost` with a `basis`
(`reported` | `exact` | `estimated` | `partial`) and, when two sources disagree, a
`conflict` holding both. The UI renders a marker for anything less than measured.
Never widen a figure's confidence to make a view tidier, and never reconcile a
disagreement by picking a side — surface it.

**The index is a cache, never a source of truth.** A session row is replaced
wholesale from its file, never merged field by field, so a failed or partial read
cannot blank out good data. `pebble index --force` must always be able to rebuild
everything from `~/.claude` alone.

**Adapters are the only thing that knows a vendor.** No route, query, component
or view may mention Claude Code by name. If you find yourself wanting to, the
adapter contract in `packages/core/src/types.ts` is missing something.

**Prices live in exactly one place.** `packages/core/src/pricing.ts`, with
`PRICING_AS_OF` recording when it was last checked. An unrecognized model prices
at its family rate and is reported as an estimate; it is never silently guessed.
When updating it, load the `claude-api` skill rather than recalling rates.

### UI rules

The dashboard is a 16-bit pixel-art office: one room per unit (HQ, the tooling
workshop, each subsidiary), a workstation with a nameplate per department, hot
desks for sessions without one, and agents as characters who walk in at the
door, sit down while their run is live, and walk out when it ends.
`docs/DESIGN.md` is the full version; the rules that get broken most often:

- **No inline styles.** Classes only. The exceptions are custom properties
  carrying a magnitude or position: `Bars` and `Meter`, and the map's art-pixel
  coordinates (`--x`, `--y`, `--w`, `--h`, `--t`, `--z`, `--room-w`,
  `--room-h`). Colour, radius and easing still live in the stylesheet.
- **Pixel art stays pixel art.** Sprites are grids in code
  (`components/sprites.tsx`) rendered as SVG rects with `crispEdges` and a
  `px-*` palette class per cell. No image assets, no sprite library, no smooth
  vector shapes. Don't drift back to rounded or illustrated art.
- **Fonts:** Pixelify Sans for headings and signs, VT323 (~17px) for map
  nameplates and small labels — never shrink these below what a laptop can read, Nunito for anything dense, JetBrains Mono
  for identifiers.
- **Motion is honest.** Characters arrive and leave only when the data changed
  (the client diffs reads); the first-load entrance is the one exception,
  because everyone in it really is live. Under `prefers-reduced-motion` nobody
  walks and every loop stops on a still frame.
- **Every table column sorts.** A column you cannot sort is a bug. Cap rows and
  offer "show more" instead of rendering hundreds.
- **Filter pills, not dropdowns**, for small sets. Filters are visible state.
- **No hero metric cards.** Numbers go inline where they are actionable.
- **No glassmorphism, gradient text, or modals.** Inspect inline instead. The
  map nests floor → room → desk because that hierarchy is the data; don't nest
  containers anywhere else.
- **All colour lives in `styles/tokens.css`** (day and night palettes, `--px-*`
  for sprite pixels). No component or sprite hard-codes a colour.
- **Status is never colour alone.** Every agent state has a pose, a shape and a
  caption in words.
- **Never show fabricated or interpolated data.** If something could not be read,
  say so.

### Code style

- TypeScript, strict, ESM. Relative imports keep their `.ts` extension; `tsc`
  rewrites them on the way out.
- Comments explain *why*, especially where the code is defensive about a vendor
  format. Do not add comments that restate the code.
- Parsing anything from disk must survive garbage: every vendor field is
  optional, every read is wrapped, and failures become an `Issue` rather than an
  exception.
- No new runtime dependency without a reason in `docs/DECISIONS.md`. The current
  list is Hono, React and Vite.

## Delegating work

Keep the main conversation for direction and verification; hand file changes to
one of the agents in `.claude/agents/`:

| Agent | Scope |
|---|---|
| `pebble-core` | `packages/core`, `packages/server`, `packages/cli` |
| `pebble-web` | `packages/web` |
| `pebble-verify` | builds, typechecks, tests, API smoke checks |

Rules that keep this from going wrong:

- Agents do not spawn their own sub-agents or background processes. One level of
  delegation, one orchestrator.
- Agents do not start or restart servers. The main thread owns long-running
  processes so it can see them.
- Browser automation is headless, always. A headed browser steals focus.
- After an agent finishes, the main thread rebuilds, runs `pnpm check`, and
  verifies the endpoints before believing it.

Thought of something while agents are busy? Write a descriptively-named markdown
file into `queue/` (`fix-session-filter-reset.md`, not `task-3.md`).

## Verifying against real data

The parser's correctness is not a matter of opinion — there are real transcripts
on this machine. After any change to the Claude Code adapter:

```bash
pnpm check
node packages/cli/bin/pebble.mjs index --force
node packages/cli/bin/pebble.mjs sessions --limit 10
node packages/cli/bin/pebble.mjs doctor
```

A cost figure that moves after a refactor is either a bug you just fixed or a bug
you just introduced. Find out which before committing.
