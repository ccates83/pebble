# Design system

The brief: an ops dashboard that does not look like it was generated. Dense,
readable at a glance, and honest about what it knows.

Everything below is enforced by `packages/web/src/styles/tokens.css` and reviewed
against this file. If a change needs a new colour, a new font or an inline style,
that is a conversation, not a detail.

## Colour

Four brand roles, two semantic states. All in `tokens.css`; **no component
hard-codes a colour.**

| Token | Role |
|---|---|
| `--c-primary` | Headings, nav, strong text. Warm charcoal. |
| `--c-accent` | Interactive: links, active nav, selected rows, bars. Terracotta. |
| `--c-signal` | Attention: warnings, estimated figures. Ochre. |
| `--c-bg` | Page. Warm limestone — never `#fff`. |
| `--c-live` | An agent is working right now. Moss. |
| `--c-fault` | Errors, failures, broken links. |

The two state colours are not decoration and not a fifth and sixth brand colour.
A status light has to read as a status light, and reusing `--c-accent` for
"running" would make every interactive element look live.

Surfaces, rules and muted text derive from these. Tints are a wash
(`rgb(... / 9%)`) behind a row or pill, never a coloured left border.

Dark mode follows the system, is forceable with `[data-theme]`, and is tinted
toward the same warm hue. Nothing is pure black.

**Avoided deliberately:** cyan-on-near-black, purple-to-blue gradients, neon
accents. Those are the default palette of generated interfaces.

## Type

| Token | Face | Used for |
|---|---|---|
| `--font-display` | Fraunces | The wordmark and section headings only |
| `--font-body` | Public Sans | Everything else |
| `--font-mono` | IBM Plex Mono | Identifiers, paths, commands, model ids |

Not Inter, Roboto, Arial, Open Sans or a system default — those read as "no font
was chosen". Mono is for things that *are* code, not as shorthand for technical.

Numbers use `font-variant-numeric: tabular-nums` wherever they sit in a column.
A column of figures that doesn't line up cannot be scanned.

Fonts load from Google Fonts. The alternative was committing font binaries; the
fallback stacks are real stacks, so offline degrades rather than breaking.

## Layout and density

- If you have to scroll to understand state, you won't check the dashboard.
- Spacing is **varied**: tight within a group, generous between groups. Not the
  same padding everywhere.
- Asymmetric and left-aligned. Centred columns of text read as a landing page.
- One container: `.section`. There are **no cards inside cards**.
- `clamp()` for fluid type and page padding.

## Component rules

| Rule | Why |
|---|---|
| Every table column sorts | A column you can't sort is a bug. `DataTable` makes the header a button; omitting `key` is an explicit opt-out for display-only columns. |
| Cap rows, offer "show more" | Nobody reads row 300, and rendering it costs something. |
| Per-section refresh | Each `Section` can take `onRefresh`. You should be able to re-read one thing. |
| Filter pills, not dropdowns | For a small set, filters should be visible state you can see and click. Dropdowns hide the current filter. A `<select>` is used only for the long lists — projects and models. |
| Numbers inline, in context | **No hero metric cards.** `Stat` is a label and a value on one line, placed where the number is actionable. |
| Collapse, don't modal | The timeline collapses its middle; config overrides are `<details>`. Modals are a way of avoiding a layout decision. |
| Label everything | No unlabelled icon buttons. In six months you won't remember. |
| Show "no data", never fake data | An empty state says what would fill it. Nothing is interpolated. |

## Motion

`--ease: cubic-bezier(0.22, 1, 0.36, 1)` — real objects decelerate. No bounce, no
elastic. The only animation is the slow pulse on an active status dot, because
"something is happening right now" is worth a moving pixel. Everything collapses
under `prefers-reduced-motion`.

## Inline styles

**None**, with one documented exception: `Bars` and `Meter` pass a magnitude to
CSS as a custom property (`--col-pct`, `--fill-pct`). A bar's height comes from
data and cannot live in a class; its colour, radius and transition still do.

Every other styling decision is a class. Inline styles bypass theming, and the
second one always arrives after the first.

## Showing uncertainty

This is the part of the design that carries the most weight.

A `CostFigure` renders its `Cost`'s provenance:

| Mark | Meaning |
|---|---|
| none | Reported by the tool, or computed from an exact price match |
| `~` | Estimated — a model was priced at its family's rate |
| `*` | Reported and computed figures disagree; both are kept, reported is shown |
| `?` | Incomplete — a model couldn't be priced and is missing from the total |

Every mark is an `<abbr>` with the explanation in its `title`. A day in the spend
chart containing any such figure is hatched rather than solid.

The rule behind all of it: **a number that might be wrong should look different
from a number that isn't.** Rendering an estimate identically to a measurement is
the single easiest way for a dashboard to mislead the person who built it.

## The test

Show the interface to someone and say "AI made this". If they believe you
immediately, something above is being broken.
