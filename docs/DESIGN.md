# Design system

The brief: **a cozy office sim you can look at all day.** HQ is a little town on a
lawn. Each subsidiary is a building, each department a room, and each
department's agent is a character at a desk whose pose is its state. It should
feel like a calm game (warm, soft, illustrated, rounded) while still being an
honest instrument that you can trust about what it knows.

This replaces the earlier "anti-generic ops dashboard" brief (limestone and
terracotta, no cards inside cards). Connor chose the new direction on
2026-10-02. The rules about **honesty and usability** carried over unchanged and
are marked ◆ below. The aesthetic rules are new.

Everything below is enforced by `packages/web/src/styles/tokens.css`,
`components.css` and `office.css`, and reviewed against this file. A new
colour, font or inline style needs a conversation first; it is not a detail.

## Colour

All colours live in `tokens.css`. **No component or sprite hard-codes a
colour.** Every SVG shape carries a class, and the stylesheet maps that class
to a token.

### Roles

| Token | Role |
|---|---|
| `--c-primary` | Headings, strong text. Walnut ink. |
| `--c-accent` | Interactive: links, selection, pressed pills. Dusty berry. |
| `--c-signal` | Attention and estimates. Honey. |
| `--c-bg` | Page. Parchment, never `#fff`. |
| `--c-live` | An agent is working right now. Sage leaf. |
| `--c-fault` | Errors, failures, broken links. Brick. |

### Scenery

The map has its own palette: wood (`--c-wood*`), walls, floor planks, grass,
path, six roof colours (`--c-roof-1..6`, cycled per building), skin and hair
tones, and twelve **department tints** (`--tint-1..12`, plus `--tint-worker`).
A department's tint is its agent's shirt colour, assigned in order of first
appearance across the org, so "Marketing" wears the same colour in every
building. Skin and hair vary by a stable hash so a row of desks reads as a row
of different people. **None of these colours carry meaning.**

### Paper keeps its ink

Signs, slips, nameplates and notes are paper (`--c-paper`), and paper stays
light at night. Anything printed on paper uses the `--c-*-ink` tokens
(`--c-ink`, `--c-ink-muted`, `--c-accent-ink`, `--c-signal-ink`,
`--c-fault-ink`, `--c-live-ink`). These do not change with the theme, so text
on a slip never loses contrast.

### Night

Dark mode is the same world, lamp-lit: deep plum and navy wood, warm window
glow, light parchment for paper. It is never pure black. It follows
`prefers-color-scheme` and can be forced with `[data-theme='light' | 'dark']`.
The two dark blocks in `tokens.css` must stay identical.

**Avoided deliberately:** neon, cyan-on-black, gradient text, glassmorphism,
and purple-to-blue gradients.

## Type

| Token | Face | Used for |
|---|---|---|
| `--font-display` | Fredoka | Wordmark, headings, building signs, room nameplates |
| `--font-body` | Nunito | Everything else, including dense tables |
| `--font-mono` | JetBrains Mono | Identifiers, paths, commands, model ids, agent ids |

Fredoka is rounded and friendly without being a novelty face. Nunito keeps
that softness and stays readable at 13px in a table. Mono is for things that
*are* code, not for looking technical.

◆ Numbers are tabular wherever they sit in a column. The body sets
`font-variant-numeric: tabular-nums` globally, because Nunito's default figures
are proportional.

Fonts load from Google Fonts. The fallback stacks are real stacks, so going
offline degrades the look rather than breaking it.

## The office floor (HQ)

| Thing | Drawn as |
|---|---|
| HQ | The **head office** on the plaza: one desk per live session, as generic workers |
| Tooling repo | A small **workshop** beside it, the same way |
| Subsidiary | A **building** on the street: a scalloped roof, a wooden sign, two floors of rooms, and a ground-floor lobby |
| Department | A **room** with a paper nameplate, a desk, and its agent |
| Live session with no department | A desk in that building's **lobby**, so work is never hidden |
| Archived subsidiary | Hidden by default. A "show archived" pill shows it **boarded up**: desaturated roof, planks across the facade, still inspectable from its sign |

A building is as wide as its rooms need (two rows, 2 to 4 rooms across), and
buildings stand bottom-aligned on a sandy street. At phone width buildings
stack and rooms flow two to a row.

### Character states

| Status | Pose | Words |
|---|---|---|
| active | Typing (arms alternate), screen lit with code lines, steam on the mug | "working" |
| waiting | A "!" speech bubble that gently pulses, a "?" on screen, a thicker room frame | "needs you" |
| idle | Head tilted, eyes closed, "z z" drifting up | "idle" |
| done | Empty desk, chair pushed in, screen off | "empty desk: last run done" |
| no runs | Same empty desk | "empty desk: no runs yet" |
| agent not defined | No desk: boxes and a hanging VACANT sign | "vacant: agent not defined" |

### Attention on the map

| Kind | Where | Drawn as |
|---|---|---|
| approval | Room, or the building's mailbox | Envelope with a wax seal. The mailbox flag goes **up**, with a count |
| waiting-session | The session's desk or room | "!" bubble (the sprite's own bubble when it is already waiting) |
| session-errors | Desk, room, or front door | A small rain cloud with a spark |
| drift | Roof corner | A cobweb |
| inbox | Front door | A paper note pinned to the door |
| proposal | Front door | A pinned sticky note with a lightbulb |
| charter | Roof | Scaffolding across the roof, plus an A-frame sign reading "charter unfilled" |
| review-overdue | Front door | A calendar page |
| missing vault or folder | Sign or room | A crack, plus words in the inspector |

Several items of one kind at one place collapse into one marker with a count.

### Interaction

- Clicking a **room**, a **desk** or a **building's sign** opens the inspector
  **inline**: in a sticky column beside the map on wide screens, below the map
  on narrow ones (scrolled into view). Clicking again, or "close", dismisses
  it.
- The **notice board** lists every attention item, urgent first. Info-level
  notes are folded behind "unfold N notes", and the list is capped with "show
  more". Each slip's title selects its place on the map, and the slips for the
  selected place are outlined.
- The **logbook** is the org's merged changelog: a sortable table with
  where-filter pills and "show more".

## Rules that carried over ◆

| Rule | Why |
|---|---|
| ◆ Never show fabricated or interpolated data | An empty room shows an empty desk, not a sleeping placeholder. An empty state says what would fill it. Test fixtures live only in scratch harnesses outside the repo, never behind a flag in the shipped build. |
| ◆ Status is never colour alone | Every state has a pose **and** a word, and status dots have distinct shapes (filled, diamond, ring, dashed ring). Pressed pills carry a ✓, and selection is a dashed outline. |
| ◆ No modals | Inspect inline. Collapse, don't pop up. |
| ◆ No inline styles | Classes only. The one exception: passing a magnitude or position to CSS as a custom property (`Bars`, `Meter`). Data-driven looks such as tint, roof and pose are **classes** (`tint-3`, `roof-2`, `spr--idle`), never `style`. |
| ◆ Every table column sorts | `DataTable` makes the header a button. Omitting `key` is an explicit opt-out for display-only columns. Cap rows with "show more". |
| ◆ No view names a vendor | Adapters are the only code that knows a vendor. |
| ◆ No new runtime dependencies | Sprites are hand-built inline SVG and CSS in `components/sprites.tsx`: no sprite library, no image assets, nothing fetched. |
| ◆ Filter pills for small sets | Use a `<select>` only for long lists, such as projects and models. |
| ◆ Label everything | Every room, desk, sign and marker has an aria-label (or `role="img"` and a label) stating the department, agent and status in words. |

## Shape and surface

- Rounded everywhere: `--radius` for controls and `--radius-lg` for panels.
- A top-level section is a sheet of paper on the desk: a surface, a soft rule
  and a flat 3px drop shadow. Nested content sits on that paper, not on a
  second sheet. The map deliberately nests (town, building, room, desk),
  because that hierarchy *is* the information.
- Rules inside paper are dashed, like a notebook.
- The rail is a wooden signpost. The current view is a paper sign pointing
  right, and on a phone it becomes a wooden shelf of pill links.

## Motion

CSS only. Gentle and looping, never bouncing. Only the sprites move: typing
arms, a slight head bob, code lines, steam, a pulsing "!" bubble and drifting
"z"s, plus the status dot's slow pulse. Every animated pose has a static pose
that means the same thing, and under `prefers-reduced-motion` all sprite
animation stops and the static pose remains.

## Showing uncertainty ◆

This is the part of the design that carries the most weight, and the theme
does not soften it.

A `CostFigure` renders its `Cost`'s provenance:

| Mark | Meaning |
|---|---|
| none | Reported by the tool, or computed from an exact price match |
| `~` | Estimated: a model was priced at its family's rate |
| `*` | Reported and computed figures disagree. Both are kept, and the reported figure is shown |
| `?` | Incomplete: a model couldn't be priced and is missing from the total |

Rollups use `Money` with `approximate`, which keeps the `~`. Every mark is an
`<abbr>` with its explanation in `title`. A day in the spend chart containing
any such figure is hatched rather than solid. Agent-written amounts (approval
requests) and scorecard values are shown as provisional.

**A number that might be wrong should look different from a number that
isn't.** A cozy theme is no excuse to make an estimate look like a
measurement.

## The test

Look at the map from across the room. You should be able to say who is
working, who needs you and where the mail is, without reading a word. Then read
the words, and they should say the same thing.
