# Design system

The brief: **a 16-bit office you can look at all day.** HQ is a floor of
pixel-art rooms seen from a 3/4 top-down view, SNES style. Each unit (the head
office, the tooling workshop, each subsidiary) is a room full of desks,
computers and chairs. When an agent is running, its character walks in at the
door, sits down at its desk and works; when the run ends, it gets up and walks
out. It should feel like a warm, friendly retro game while still being an
honest instrument that you can trust about what it knows.

History: the "anti-generic ops dashboard" (limestone and terracotta) gave way
to a soft illustrated "cozy sim" town of buildings, which Connor then asked to
make **more animated, more retro and pixel art** (2026-10-02). The rules about
**honesty and usability** carried over unchanged and are marked ◆ below. Do not
drift back to rounded, illustrated or vector-smooth art: the direction is
pixels.

Everything below is enforced by `packages/web/src/styles/tokens.css`,
`components.css` and `office.css`, and reviewed against this file. A new
colour, font or inline style needs a conversation first; it is not a detail.

## Colour

All colours live in `tokens.css`. **No component or sprite hard-codes a
colour.** Every sprite pixel carries a palette class, and the stylesheet maps
that class to a token.

### Roles

| Token | Role |
|---|---|
| `--c-primary` | Headings, strong text. Plum-walnut ink. |
| `--c-accent` | Interactive: links, selection, pressed pills. Berry. |
| `--c-signal` | Attention and estimates. Honey. |
| `--c-bg` | Page. Parchment, never `#fff`. |
| `--c-live` | An agent is working right now. Leaf. |
| `--c-fault` | Errors, failures, broken links. Brick. |
| `--c-frame` | The chunky pixel border round every panel. |

### Sprite pixels

The office has its own palette, `--px-*`: the outline (dark plum, never pure
black), furniture (desk, chair, CRT, screen off, on and dim, code), paper,
plants, water, walls, sky and stars, five floors (`--px-floor-1a/1b`…`5a/5b`,
cycled per room), plus the skin and hair tones (`--c-skin-*`, `--c-hair-*`) and
twelve **department tints** (`--tint-1..12`, plus `--tint-worker` for hot
desks). A department's tint is its agent's shirt colour, assigned in order of
first appearance across the org, so "Marketing" wears the same colour in every
room. Skin, hair and hairstyle vary by a stable hash so a row of desks reads
as a row of different people. **None of these colours carry meaning.**

The palette is warm and 16-bit: honey wood, sage, berry, sky and butter.
**Avoided deliberately:** neon, cyan-on-black, synthwave magenta, gradient
text, glassmorphism and purple-to-blue gradients. Retro is not cyberpunk.

### Paper keeps its ink

Signs, nameplates, slips and the notice board are paper (`--c-paper`), and
paper stays light at night. Anything printed on paper uses the `--c-*-ink`
tokens (`--c-ink`, `--c-ink-muted`, `--c-accent-ink`, `--c-signal-ink`,
`--c-fault-ink`, `--c-live-ink`). These do not change with the theme, so text
on a nameplate never loses contrast.

### Night

Dark mode is the same office, lamp-lit: plum walls, warm windows with stars in
them, darker floors and brighter glowing screens. It is never pure black. It
follows `prefers-color-scheme` and can be forced with
`[data-theme='light' | 'dark']`. The two dark blocks in `tokens.css` must stay
identical (they were generated from one list; edit both together).

## Type

| Token | Face | Used for |
|---|---|---|
| `--font-display` | Pixelify Sans | Wordmark, headings, room signs, rail items |
| `--font-pixel` | VT323, at `--fs-pixel` (17px) | Nameplates and captions on the map, kickers, small labels |
| `--font-body` | Nunito | Everything dense: body text, tables, the inspector, slips |
| `--font-mono` | JetBrains Mono | Identifiers, paths, commands, model ids, agent ids |

**Readability wins.** The pixel faces are for signs and labels. Dense reading
stays in Nunito, which holds up at 13px in a table. Map labels use VT323: it is
condensed, so a department name fits on a desk at a size a small laptop can
read. It replaced 8px Silkscreen, which Connor found unreadable on a laptop
screen (2026-10-02). VT323 has one weight, so synthesized bold is turned off
globally; mark emphasis with colour or case, never `font-weight`.

◆ Numbers are tabular wherever they sit in a column. The body sets
`font-variant-numeric: tabular-nums` globally, because Nunito's default figures
are proportional.

Fonts load from Google Fonts. The fallback stacks are real stacks, so going
offline degrades the look rather than breaking it.

## Pixel art technique

- **Sprites are grids in code.** `components/sprites.tsx` holds string arrays,
  one character per pixel (`'..oohhoo..'`), with a palette legend at the top of
  the file. `Pixels` renders a grid as SVG `<rect>`s (one per horizontal run)
  with the class `px-<char>`; `office.css` maps each class to a token. Larger
  furniture is drawn from integer-aligned rects with the same classes.
- **Crisp edges, one scale per room.** Every SVG renders with
  `shape-rendering: crispEdges`. Geometry is in art pixels; a room's SVG is
  scaled to its column, and HTML overlays use `--px` (the room's width over its
  art width, via container query units) so they line up with the art. Every
  room has the same art width, so every room has the same pixel scale.
- **Characters** are 12 pixels wide: an 8-row head (three hairstyles, three
  facings) on a 12-row body. Walk cycles are frame strips: four frames facing
  up or down, two facing sideways (mirrored for left). Seated poses are 12 x 24
  and include the chair back, so they sit exactly where the empty chair is
  drawn.
- **Frames animate with `steps()`**: the strip translates by whole frames.
  Movement is a CSS `translate` transition on `--x` and `--y`, one leg at a
  time, at a constant speed.

## The office floor (HQ)

| Thing | Drawn as |
|---|---|
| HQ | The **head office**: a room of hot desks, one per live session plus spares |
| Tooling repo | The **workshop**, the same way, on a concrete floor |
| Subsidiary | A **room**: tiled floor, back wall with a sign, a window and a notice board, a door in the front wall, rows of workstations |
| Department | A **workstation**: desk, CRT, keyboard and chair, with a paper nameplate (department name and status in words) |
| Live session with no department | A **hot desk**. Hot desks are sized to the live count with at least two spare, and the last row is filled with free ones |
| Archived subsidiary | Hidden by default. A "show archived" pill shows it **boarded up**: dimmed, planks over the door and window, desks under dust sheets reading "closed", still inspectable from its sign |

Rooms are packed into columns (one, two or three, by available width): each
room goes into the shortest column so far, so columns stay flush with no
ragged gaps between rooms. On a phone, rooms stack in order and desks go
three to a row.

### Arrivals and departures

- A character is on the map when the data says someone is at that desk: a
  department whose latest run is active, waiting or idle, or a live session at
  a hot desk.
- The client keeps who it last saw seated in each room (it outlives remounts),
  and diffs every new read against it. **New**: the character appears outside
  the door, walks up the corridor, along its row and sits. **Gone**: it stands,
  walks back out of the door and disappears. **Changed status**: it changes
  pose in place.
- On the **first page load**, everyone already live walks in, staggered over
  about two seconds. That is an entrance, and it is honest because they really
  are live. A room seen for the first time later (an archived room just shown)
  is not an arrival: its people are simply there.
- **Never invent an arrival or departure the data did not show.**
- A hot desk keeps its occupant across reloads; a seat someone is walking out
  of is not handed to a newcomer in the same read.

### Desk states

| Status | Pose | Words |
|---|---|---|
| active | Typing (two-frame arms), screen lit with code, blinking cursor, screen flicker, steam off the mug | "working" |
| waiting | Turned round in the chair to face you, a blinking "!" bubble, a "?" on screen | "needs you" |
| idle | Slumped, head down, screen dim, "Z"s drifting up | "idle" |
| done | Empty chair, monitor off | "run done" |
| no runs | Empty chair, monitor off | "no runs" |
| agent not defined | A dust sheet over the desk and a VACANT sign | "vacant" |
| free hot desk | Empty chair, monitor off, faded nameplate | "free" |

The monitor follows whoever is actually in the chair, so it lights up as they
sit down. Every status also has a shape on the nameplate (filled square,
diamond, ring, dashed ring, cross), and the full wording is in the desk's
aria-label and the inspector.

### Attention on the map

| Kind | Where | Drawn as |
|---|---|---|
| approval | The department's desk, and the **mailbox** by the door | Envelope with a wax seal. The mailbox flag goes **up**, with a count of every pending approval in the unit |
| waiting-session | The session's desk | The character's own "!" bubble, or a speech-bubble marker |
| session-errors | The desk, else by the door | A rain cloud with a spark |
| drift | The window corner | A cobweb |
| inbox, proposal | The **notice board** on the back wall | One paper per note (up to four), plus a pinned note or lightbulb sticky with a count |
| charter | Across the back wall | Hazard tape with a "charter unfilled" label and an A-frame sign |
| review-overdue | The back wall | A calendar page |
| missing vault or folder | The sign or the desk | A crack, plus words in the inspector |

Markers are 12 x 12 pixel icons. Several items of one kind at one place
collapse into one marker with a count.

### Interaction

- Clicking a **desk** (or the character sitting at it) or a **room's sign**
  opens the inspector **inline**: a sticky column beside the map on wide
  screens, below the map on narrow ones (scrolled into view). The selected desk
  gets a dashed outline and a hopping "▼" cursor. Clicking again, or "close",
  dismisses it.
- The **notice board** is a quest log: every attention item, urgent first.
  Info-level notes are folded behind "unfold N notes", and the list is capped
  with "show more". Each slip's title selects its place on the map, and the
  slips for the selected place are outlined.
- The **logbook** is the org's merged changelog: a sortable table with
  where-filter pills and "show more".

## Rules that carried over ◆

| Rule | Why |
|---|---|
| ◆ Never show fabricated or interpolated data | An empty desk shows an empty chair and a dark monitor, not a sleeping placeholder. Characters walk in and out only when the data changed. An empty state says what would fill it. Test fixtures live only in scratch harnesses outside the repo, never behind a flag in the shipped build. |
| ◆ Status is never colour alone | Every state has a pose **and** a word, and status dots have distinct shapes (filled, diamond, ring, dashed ring). Pressed pills carry a ✓, and selection is a dashed outline. |
| ◆ No modals | Inspect inline. Collapse, don't pop up. |
| ◆ No inline styles | Classes only. The one exception: passing a magnitude or position to CSS as a custom property (`Bars`, `Meter`, and the map's art-pixel coordinates `--x`, `--y`, `--w`, `--h`, `--t`, `--z`, `--room-w`, `--room-h`). Data-driven looks such as tint, floor and pose are **classes** (`tint-3`, `fl-2`, `st-art--idle`), never `style`, and a colour is never a custom property set from code. |
| ◆ Every table column sorts | `DataTable` makes the header a button. Omitting `key` is an explicit opt-out for display-only columns. Cap rows with "show more". |
| ◆ No view names a vendor | Adapters are the only code that knows a vendor. |
| ◆ No new runtime dependencies | Sprites are pixel grids written in code in `components/sprites.tsx`, rendered as SVG rects: no sprite library, no image assets, nothing fetched. |
| ◆ Filter pills for small sets | Use a `<select>` only for long lists, such as projects and models. |
| ◆ Label everything | Every room sign, desk, mailbox and marker has an aria-label (or `role="img"` and a label) stating the department, agent and status in words. |

## Shape and surface

- **Square and chunky.** Radii are zero. Panels (sections, the map, the
  inspector, the notice board) have a 3px pixel frame drawn as a ring of four
  hard box-shadows, which notches the corners like a 16-bit window, plus a
  stepped drop shadow. Buttons, pills and inputs get the same ring at 2px. The
  ring sits outside the box, so scroll containers leave room for it.
- A top-level section is one framed panel. Nested content sits inside it, not
  in a second frame. The map deliberately nests (floor, room, desk), because
  that hierarchy *is* the information.
- The rail is an RPG menu: a wooden panel, items in the pixel display face, and
  a blinking "▶" cursor beside the current view. On a phone it becomes a wooden
  shelf of menu items.
- The inspector is a status window (a wooden title bar over paper), and the
  notice board is a quest log (a wooden title bar over ruled paper).

## Motion

CSS does the animating; the view only decides who walks where. Characters walk
with frame strips stepped by `steps()` and move by transitions on `--x` and
`--y`. Seated loops: typing arms, a blinking "!", drifting "Z"s. Ambient life
is small and occasional: a blinking cursor and a faint flicker on working
screens, steam off a mug, a plant that sways a pixel every few seconds, a
bubble rising in the water cooler. Nothing bounces or flashes.

Under `prefers-reduced-motion`: **nobody walks**. Characters are drawn already
seated, departures simply vanish, every loop stops on a still frame that means
the same thing, and the menu cursors stop blinking.

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
isn't.** A retro theme is no excuse to make an estimate look like a
measurement.

## The test

Look at the map from across the room. You should be able to say who is
working, who needs you and where the mail is, without reading a word. Then read
the words, and they should say the same thing.
