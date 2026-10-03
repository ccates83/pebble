---
name: pebble-ui-review
description: Review a Pebble dashboard change against the project's anti-generic design brief — colour roles, type, density, sortable tables, filter pills, inline styles, and honest rendering of uncertain figures. Use after any change to packages/web, or when asked whether a view looks right.
---

# Reviewing a Pebble view

The brief is an ops dashboard that does not look generated. `docs/DESIGN.md` is
the full version; this is the review pass. Go through it against the actual diff,
not from memory, and report findings with `file:line`.

## Mechanical checks first — grep for them

```bash
# Inline styles. Only Bars and Meter may use style=, and only to pass a CSS var.
grep -rn "style={{" packages/web/src

# Hard-coded colours. Everything comes from tokens.css.
grep -rnE "#[0-9a-fA-F]{3,8}|rgb\(|hsl\(" packages/web/src --include=*.tsx

# A cost rendered without its provenance marker.
grep -rn "money(" packages/web/src --include=*.tsx

# Forbidden decoration.
grep -rniE "backdrop-filter|blur\(|linear-gradient|box-shadow|background-clip: *text" packages/web/src
```

A hit on any of those is a finding unless it is the documented `Bars`/`Meter`
exception or a `--c-*` token definition in `tokens.css`.

## Then read the view

**Tables.** Every column has a sort `key`, or is genuinely display-only (a meter,
a badge cluster). Rows are capped with "show more". Numeric columns are
`numeric: true` so they are right-aligned with tabular figures.

**Filters.** Small sets are `FilterPills` — visible, clickable, showing counts. A
`<select>` is acceptable only for long lists (projects, models). An active filter
must be visible without opening anything.

**Numbers.** Every cost goes through `CostFigure`. Figures that sit in a column
use tabular numerals. Nothing is a hero metric card — numbers are inline via
`Stat`, placed where they would change what you do.

**Containers.** One `.section` per section, and no section inside a section.
Expansion is inline (`Disclose`, or a detail panel), never a modal.

**Empty states.** Each one says what would fill it, in a sentence. "No data" with
no explanation is a finding. Nothing is interpolated or faked.

**Labels.** No unlabelled control. Every icon-only button has a `title`, every
input has a label or `aria-label`.

**Narrow width.** The layout survives at phone width: the rail becomes a
horizontal row, the timeline drops a column, and there is no horizontal page
scroll.

**Motion.** `--ease` only. No bounce. Everything collapses under
`prefers-reduced-motion`.

**Dark mode.** Read the tokens, not just the light rendering. Nothing is pure
black or pure white; both themes are tinted toward the same hue.

## The judgement call

Ask the question the brief ends on: if you showed this view to someone and said
"AI made this", would they believe you immediately? The usual reasons they would:

- A row of identical cards, each an icon above a heading above a line of text.
- One big number in the middle of a panel with a small grey label under it.
- Uniform padding everywhere, so nothing is grouped and nothing is separated.
- Everything centred.
- A gradient doing the job a weight change should do.

Say which specific element does it and what to replace it with. "Looks a bit
generic" is not a finding.

## Report

Severity-ranked, each with `file:line`, what rule it breaks, and the fix. If the
view is clean, say so plainly and name the two or three things you checked most
closely — a review that always finds something is as useless as one that never
does.
