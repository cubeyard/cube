---
name: cube
description: a bench instrument for running agents — putty enclosure, LED lamps, one signal orange
colors:
  s0: "#dcd7ca"
  s1: "#e4e0d4"
  s2: "#ece8df"
  s3: "#f4f1ea"
  s4: "#fbfaf6"
  ink: "#26231c"
  ink-2: "#55503f"
  ink-3: "#635e51"
  line: "#cdc7b8"
  line-2: "#b3ac9c"
  signal: "#cc3f00"
  signal-ink: "#ffffff"
  lamp-green: "#2e7d4a"
  lamp-amber: "#b06f14"
  lamp-red: "#b13421"
  lamp-lens: "#c9c3b4"
  bad: "#a03522"
  glass: "#17181c"
  glass-head: "#1f2126"
  glass-ink: "#d9dae2"
  glass-line: "#2c2e35"
  glass-chrome: "#9aa0ad"
typography:
  headline:
    fontFamily: "Archivo Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Archivo Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
  body:
    fontFamily: "Archivo Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.6
  key:
    fontFamily: "Archivo Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 550
    letterSpacing: "0.01em"
  label:
    fontFamily: "Archivo Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 550
    letterSpacing: "0.08em"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  key: "6px"
  well: "12px"
  xs: "4px"
components:
  key:
    backgroundColor: "{colors.s3}"
    textColor: "{colors.ink-2}"
    typography: "{typography.key}"
    rounded: "{rounded.key}"
    padding: "0.34rem 0.85rem"
  key-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.key}"
    rounded: "{rounded.key}"
    padding: "0.34rem 0.85rem"
  key-round:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "50%"
    width: "2.4rem"
    height: "2.4rem"
  well:
    backgroundColor: "{colors.s1}"
    rounded: "{rounded.well}"
    padding: "0.35rem"
  composer-input:
    backgroundColor: "{colors.s4}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "0.55rem 0.85rem"
  code-window:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.glass-ink}"
    typography: "{typography.code}"
    rounded: "{rounded.key}"
  tool-strip:
    backgroundColor: "{colors.s3}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.key}"
  user-message:
    backgroundColor: "{colors.s3}"
    textColor: "{colors.ink}"
    rounded: "{rounded.key}"
    padding: "0.55rem 0.9rem"
  banner-error:
    textColor: "{colors.bad}"
    rounded: "{rounded.chip}"
    padding: "0.5rem 0.9rem"
---

# Design System: cube

## Overview

**Creative North Star: "The Bench Instrument"**

**Reference — binding:** Dieter Rams / Braun (the user's stated design idol).
Every component cites Rams-era Braun hardware grammar: machined panels and
seams, flush hairline-divided control banks, small precise radii, restrained
silkscreen, one signal color, states as lamps. "Weniger, aber besser" —
when torn between renditions, the quieter, more machined one wins.

cube is rendered as a machine you own: a warm silkscreened bench instrument in
the Braun / Teenage Engineering panel lineage. The screen is the instrument's
front panel — a putty enclosure carrying recessed display wells, raised keys
with real 1px press travel, LED state lamps, lowercase silkscreen micro-labels,
and exactly one signal orange for the controls that are yours to touch. It is a
deliberate refusal of the category default: this is not a near-black chat app
with a neon accent.

Depth here is physical, never atmospheric. Every surface sits on a numbered
ramp (`--s0` deepest recess through `--s4` reading field) and nothing exists
outside the ramp; wells are sunk with inset shadows, keys sit proud with a
small offset shadow and travel down when pressed. State is never a colored
word — it is a lamp: lit green, blinking amber, steady red, or an unlit dark
lens for sleeping. Code lives behind dark glass in both themes, like a
display window set into the panel.

Dark mode is the black edition of the same instrument, not a second design:
the enclosure is anodized (the surface ramp inverts around a reading field
that goes darker than the enclosure), the silkscreen goes pale, the lamps glow
harder, the signal warms up to `#ff5a14`, and the glass stays glass. Motion is
mechanical and small: 120ms state changes, 80ms key travel, 140ms settle-in
entrances, a 300ms staggered lamp warm-up when the panel arrives, and a 1.2s
lamp blink — all silenced under `prefers-reduced-motion`.

**Key Characteristics:**
- Warm putty enclosure on a numbered five-step surface ramp; no surface outside it
- One signal orange, theme-tuned, reserved for what the user can touch
- LED lamps as the entire state vocabulary — lit / blinking / steady / unlit lens
- Physical depth: raised keys with real press travel, recessed wells, machined seams
- Dark-glass code windows that stay dark glass in both themes
- Lowercase silkscreen labels (11px, tracked); Archivo for the enclosure, JetBrains Mono for machine truth
- The black edition: dark mode as the same instrument anodized, not redesigned

## Colors

Warm putty neutrals (OKLCH hue 87–95° in the light theme), one signal orange,
four lamp pigments, and a single dark-glass material. Frontmatter values are
the light-theme (`:root`) values; the black edition redefines each token in
the `prefers-color-scheme: dark` block of `packages/web/src/app.css`.

### Primary
- **Signal Orange** (`--signal`, #cc3f00 light / #ff5a14 dark): the one
  accent, marking only controls that are yours to touch — the primary "new
  thread" key, the round send key, the focus ring, the text caret, the
  selection wash (`--signal-soft`), markdown links, the rename underline, and
  the cube glyph in the header. Each theme carries its own legend ink
  (`--signal-ink`: #ffffff on the light key, #1c0d03 on the bright dark key).

### Secondary
The lamp pigments. They color lamps and nothing else — never text (the one
exception is error ink, which is `--bad`, a separate notice ink).
- **Lamp Green** (#2e7d4a / #57c97e dark): lit steady — ready, done, signed in.
- **Lamp Amber** (#b06f14 / #e5a33c dark): always blinking — working, setting
  up, a running tool. Static amber does not occur.
- **Lamp Red** (#b13421 / #e5604a dark): lit steady — error, failed, not signed in.
- **Lamp Lens** (#c9c3b4 / #26262c dark): the unlit lamp — a dark lens with an
  inset shadow and a `--lamp-ring` rim. Sleeping threads show this; an off
  lamp is present and readable, not absent.
- **Error Ink** (`--bad`, #a03522 / #e5604a dark): printed red ink for error
  banners, error state labels, the delete key's hover. Paired with
  `--bad-soft` and `--bad-line` alpha washes. Info notices use `--note-soft` /
  `--note-line` silkscreen washes with `--ink-2` text — never red.

### Neutral
- **Surface ramp** (`--s0`–`--s4`): #dcd7ca deep recess, #e4e0d4 well, #ece8df
  enclosure (the body background), #f4f1ea key face, #fbfaf6 reading field.
  Black edition: #08080a, #0f0f12, #17171b, #24242b, #101013.
- **Ink ramp** (`--ink` #26231c engraved, `--ink-2` #55503f, `--ink-3` #635e51
  silkscreen): text from full-contrast reading ink down to printed micro-labels.
- **Hairlines** (`--line` #cdc7b8, `--line-2` #b3ac9c): printed 1px hairlines
  and the darker machined grooves on the header/composer seams.

### Glass
One material for code in both themes, defined once and never re-themed:
- **Glass** (#17181c body, #1f2126 head, #2c2e35 line, #d9dae2 ink) plus one
  `--syn-*` syntax set (keyword #c495e8, string #85cf9f, number #e0b06a, title
  #8fb7f7, type #74cbcb, comment #767c8a, meta #8aa8d0, ok/err #85cf9f/#ef9a8d).
- **Glass Chrome** (#9aa0ad): the language label and copy key in the code
  window head, exposed as `--glass-chrome` with the rest of the fixed glass
  material.

### Diff Editor
Diffs belong to the enclosure theme, not the fixed dark-glass code material.
`--diff-bg`, `--diff-head`, and `--diff-gutter` alias the numbered surface
ramp; `--diff-ink`, `--diff-muted`, and `--diff-line` alias the ink and
hairline ramps. Add/delete ink and washes have explicit light and dark values
(`--diff-add*`, `--diff-del*`) so full-row changes remain legible in both
editions without turning the whole editor dark in light mode.

`--lamp-blue` (#3d6b96 / #6fa3d8) and its `.on-blue` class are declared but
unused by any shipped component; sleeping uses the unlit lens. Blue is
reserved, not part of the active vocabulary.

### Named Rules
**The Numbered Ramp Rule.** Every background is one of `--s0`–`--s4`; nothing
exists outside the ramp. Audit: in the light theme OKLCH lightness ascends
monotonically s0 → s4 (88.0% → 98.5%); in the black edition the ramp inverts
around the reading field — s4 (#101013) is darker than the enclosure s2
(#17171b), and the order is s0 < s1 < s4 < s2 < s3. Both orderings must hold.

**The One Signal Rule.** One accent. `--signal` marks only what the user can
act on, and each theme pairs it with its own `--signal-ink`. Never use the
signal for state, and never use a lamp pigment on a clickable affordance.

**The Lamps-Not-Tints Rule.** State is a lamp, and the four states are
structurally distinct — lit green, *blinking* amber, steady red, unlit lens —
never four tints of one dot. The off state is a physical lens, not absence.

**The One Glass Rule.** Code is one material in both themes. The `--glass*`
and `--syn-*` tokens are defined once on `:root` and never overridden. Audit:
grep the dark media query for `--glass` or `--syn-`; the count must be zero.

## Typography

**UI Font:** Archivo Variable (self-hosted via fontsource, with italic axis;
falls back to system-ui) — the instrument's silkscreen and reading voice.
**Mono Font:** JetBrains Mono, weights 400 and 600 (self-hosted) — machine truth.

**Character:** a grotesk with enough warmth to read as printed-on-plastic
rather than typeset-on-screen, against a crisp terminal mono. Everything is
lowercase as written; nothing in the system uppercases.

### Hierarchy
- **Headline** (700, 20px, −0.01em): the screen title ("threads"). One per screen.
- **Title** (600, 14.5px): thread module titles and the inline rename input;
  truncates to one line. Untitled threads drop to weight 450 and `--ink-3`.
- **Body** (400, 15.5px/1.6): the transcript — agent prose, user messages,
  empty-state copy. Thinking text is 14px italic `--ink-3`.
- **Key** (550, 13px, 0.01em): key cap labels ("new thread", "files").
- **Label / Silkscreen** (550, 11px, 0.08em, `--ink-3`): micro-labels printed
  on the enclosure — state labels (0.06em), files-shelf head, code-window
  language. Header lamp-field labels go one step smaller (10px, 0.1em).
- **Code** (400, 12–12.5px/1.45–1.55 mono): tool heads and output (12px),
  code blocks and inline code (12.5px), the model id and language label (11px).
  Weight 600 marks tool names and syntax `strong` only.

### Named Rules
**The Mono-Means-Machine Rule.** JetBrains Mono renders only what the machine
produced or will consume: tool names, commands, paths, output, code, the model
id. The enclosure's own labels are always Archivo.

**The Silkscreen Rule.** Micro-labels are printed, not shouted: 11px, weight
550, 0.08em tracking, `--ink-3`, lowercase. There is no `text-transform`
anywhere in the system — the lowercase voice is authored into the copy itself.

**The Tabular Meta Rule.** Metadata that updates in place uses
`font-variant-numeric: tabular-nums` (module meta, files meta, markdown table
cells). A timestamp ticking from "2m" to "12m" must not shift the row.

## Layout

The app is a full-height flex column (`100dvh`). The thread list keeps the
centered **47rem** reading measure (`--col`). On desktop, the thread view folds
global navigation and thread controls into one slim top rail; the active
`threads` nav label is redundant there and recedes, while `projects` remains a
direct exit. The pi terminal starts immediately below that rail without a
second header repeating `thread`. Its full-width two-bay workspace starts
evenly split between pi and the tabbed workspace panel, then respects the
visitor's remembered divider position. At 52rem and below, navigation and
thread controls separate again for touch and wrapping, and the bays stack in
the same viewport with the conversation receiving the larger share.

Projects use that same measure rather than introducing a dashboard grid. The
project index is a recessed module well; project detail is one vertical
switchboard: identity, repository board, then a hairline-separated action
bank. Each repository row reserves a fixed role/readout zone beside flexible
fields and prints its own check evidence directly below. At the 40rem
breakpoint, repository fields collapse to one column, evidence remains inline,
and the action bank wraps rather than forcing horizontal overflow.

User messages sit right-aligned against the column's right edge as raised
strips capped at `min(47rem, 85%)`; below a 53rem viewport the centering
margin collapses. The files shelf is a pulled-out tray under the header capped
at `40dvh`. The right workspace bay scrolls independently so expanding a long
diff never moves the conversation. Spacing rhythm is in rem with recurring
steps of 0.55 / 0.7–0.75 / 0.85–0.9 / 1.0 / 1.4 / 2.1.

At the 40rem mobile breakpoint: header and paddings tighten, the model id
disappears, the busy lamp drops its label (the blinking lamp alone carries
"working"), and the composer textarea rises to 16px. The composer form pads
its bottom with `env(safe-area-inset-bottom)`.

### Named Rules
**The Reading Measure Rule.** 47rem remains the measure for prose and thread
lists. Comparison workspaces may use sibling bays, but reading content inside
them keeps its own scroll and never stretches prose across both bays.

**The Sixteen Pixel Rule.** The composer textarea is 16px at mobile width so
iOS Safari does not zoom on focus. Any new text input inherits this rule.

## Elevation & Depth

Depth is physical, never atmospheric. A surface is raised (key shadow), sunk
(well shadow), or flush on the ramp — there are no floating layers and no
ambient glows. The only "elevation" in the classic sense, `--shadow-float`, is
declared but unused: reserved for a true overlay (menu, dialog) that does not
yet exist.

### Shadow Vocabulary
- **Key** (`--shadow-key`: `0 1px 0 rgba(255,255,255,0.7) inset, 0 1px 2px
  rgba(38,32,18,0.22)` light): a top inner highlight plus a short drop — a key
  standing proud of the panel. Also on user message strips.
- **Key down** (`--shadow-key-down`): the pressed key — highlight dimmed, drop
  collapsed to a 1px blur. Applied with 1px `translateY` on `:active` and on
  held toggles (`.key.held`, which also drops to `--s1`).
- **Well** (`--shadow-well`: inset 1px 3px + inset 1px ring, light): recessed
  surfaces — the thread-list well, the files shelf, the code window (combined
  with its glass ring).
- **Seams**: the header's machined double seam (1px `--line-2` border plus two
  layered `box-shadow` lines: an `--s4` highlight over a `--line` groove) and
  the composer's answering single inset highlight above its `--line-2` border.
- **Micro-depth**: tool strips carry a 1px `0.06`-alpha drop; tool output and
  the composer textarea carry a shallow inset (`0.08`–`0.1` alpha).

### Named Rules
**The Real Travel Rule.** A key press is physical: `:active` translates the
key 1px down and swaps `--shadow-key` for `--shadow-key-down` at 80ms. Hover
brightens the face (`--s3` → `--s4`) and never moves the key.

**The Machined Seam Rule.** Seams belong to the full-width decks only — the
header's double seam and the composer's inset highlight. In-flow components
get hairlines and ramp steps, never seams.

## Shapes

Three radii carry the whole enclosure: **9px keys** (`--r-key`, also user
message strips, tool strips, code windows, the composer textarea), **14px
wells** (`--r-well`; module faces inside a well use `calc(--r-well − 5px)`),
and **7px chips** (`--r-chip`: banners, the not-signed-in warning, framed
transcript images). Small utility radii (3–5px) appear only on the focus ring,
inline code, and hover washes. Circles are reserved for lamps (8px, 6px mini)
and the round send key (2.4rem). There are no pills anywhere. The single
dashed border in the system is the missing-image retry placeholder.

Iconography is one authored stroke family in `Icon.svelte`: 24-box, 2px
stroke, round caps and joins, drawn to match the cube wireframe glyph (the
brand mark, drawn inline in the header and favicon). Eight icons ship: plus,
send, pencil, trash, chevron, check, copy, file. No icon libraries, and no
unicode glyphs standing in for controls.

## Components

Motion grammar, shared by everything below: state changes at 120ms ease, press
travel at 80ms, entrances via `settle-in` (140ms ease-out, 2px rise — nothing
bounces), lamps warm up once on arrival (`lamp-on` 300ms, staggered 60ms per
module up to 300ms), `lamp-blink` at 1.2s ease-in-out (50% → 0.3 opacity), and
a blanket `prefers-reduced-motion` guard silences all of it.

### First-run onboarding
Onboarding is a quiet welcome, not an instrument panel. This surface explicitly
omits cards, recessed wells, lamps, glows, raised keys, and the header seam.
Use the existing warm palette and Archivo type on an open, centered reading
column: one question, adjacent login/skip choices, and plain text status. The
primary action is the app's own orange key and secondary actions are plain
keys — the same `.key` system as the rest of the product, so the first run
looks like the app it hands over to. A small
step count lives in the header, while access details sit below a single hairline.
Pending codes, connected accounts, and errors use text rather than status lamps.
GitHub login from a project uses this same full-screen treatment at the project's
`/github` subroute, not an inline widget. It explains the underlying GitHub CLI
login and returns to the project, rechecking access after successful login.
Repository errors appear once beside the affected repository, not duplicated
in a page banner. Other project and thread controls retain their treatment.

### Keys (buttons)
- **Shape:** raised key, 9px radius, 1px `--line` border, `--shadow-key`.
- **Default:** `--s3` face, `--ink-2` label (13px/550); hover lifts to `--s4`
  face and `--ink` label. Press: 1px travel + `--shadow-key-down`.
- **Primary:** `--signal` face, `--signal-ink` legend, border darkened to 80%
  signal; hover mixes 8% white in. One primary per screen: "new thread" on
  the list, "save" in project configuration, and "ship" in a thread.
- **Icon key** (`.key.icon`): square-ish padding, always `title` + `aria-label`.
- **Round key** (`.key.round`): the 2.4rem circular signal send key.
- **Held toggle** (`.key.held`): pressed-in look (`--s1` face, down shadow) for
  the open files-shelf key, with `aria-expanded`.
- **Danger hover** (`.key.danger`): `--bad` ink on `--bad-soft` wash.
- **Disabled:** 0.45 opacity, cursor default.

### Lamps
8px circles (6px `.mini` in tool strips). Base is the unlit lens (`--lamp-lens`
with inset shadow + `--lamp-ring` rim); `.on-green` / `.on-amber` / `.on-red`
light the lamp with a 5px `color-mix` glow; `.blink` adds the 1.2s pulse.
Thread mapping: busy or setting-up → amber blink; error → red; sleeping →
unlit lens; ready → green. Tool mapping: running → amber blink; done → green;
failed → red. Header lamps ride in a `.lamp-field` with a 10px silkscreen
label; the busy lamp exists only while working (`display: none` otherwise).

### Thread Module Well
The list is one recessed well (`--s1`, 14px radius, `--shadow-well`, 0.35rem
padding) holding one module per thread, separated by `--line` hairlines. A
module face is the whole link: lamp, title, tabular meta (relative time, state
label, project attribution, error preview). The thread list is global by
default and its compact project select writes the filter into the hash URL;
project context never becomes a separate thread silo. Rest face is
`--face-rest` (transparent on putty, a
0.035 white lift on the black edition so panel anatomy survives anodizing);
hover washes in 55% `--s3`. Rename swaps the title for an engraved input —
borderless, 2px `--signal` bottom rule. Empty list: centered hint with the one
primary key (the header key is suppressed so there is exactly one way to act).

### Project Switchboard
The project index reuses the module well but adds repository names, repository
and thread counts, checked time, and a flush re-check key bank. Project errors
wrap to their full text inside the row; they are not reduced to a generic
status or clipped preview.

Detail is a vertical repository control board. The first row is permanently
the writable primary checkout at `/workspace`; reference rows print
`../repos/<checkout-name>`. Each row combines a state lamp, URL/base/checkout
fields, and exact evidence: not checked, checking access and branch, resolved
base plus abbreviated OID, or the complete repository error. Saving makes the
configuration dirty and therefore not checked; check and thread creation stay
disabled until the saved project is ready. The bottom action bank preserves
the hierarchy: one orange save action, neutral check/new-thread/thread-link
keys, and a separated red-ink delete action. Orange does not spread to every
important-looking secondary control.

### Thread Repository Control Bank
Every thread names its project and links back to that switchboard. Repository
review in the web panel is scoped to the thread's pinned primary checkout.
There is no repository selector in that panel. The agent can edit, review and
publish reference checkouts separately using explicit repository IDs. One signal-orange `ship` key pulls down an in-flow preflight
panel with branch/base/ahead/working-copy readouts, committed paths on one side,
and tracked/untracked local paths on the other. The distinction is load-bearing:
the live diff is committed truth now; local paths cannot be pushed until the
agent commits them.

Confirming Ship sends the durable Ship runbook through the existing pi TUI — it
does not bypass the agent with browser-side Git mutations. The agent gets narrow
host tools for authenticated base sync, non-forced base push, and final thread
archive while ordinary commands and credentials stay inside their established
security boundaries. Progress and conflict questions remain in the terminal;
the panel reports handoff rather than inventing completion. There is no combined
diff or push-all control.

### Composer
Full-bleed `--s2` deck with the answering seam. Textarea: `--s4` field, 9px
radius, shallow inset shadow, auto-growing to 11rem; focus swaps the border to
`--signal` (the one sanctioned replacement of the global 2px signal focus
ring). Send is the round signal key.

### Code Window
Dark glass in both themes: `--glass` body inside an inset well shadow plus a
1px `--glass-line` ring, 9px radius. Head: `--glass-head`, lowercase mono
language label and an icon+text copy key in glass chrome (#9aa0ad) that flips
to `--syn-ok` with a check icon for 1.5s. Body: 12.5px mono in `--glass-ink`
with the single `--syn-*` highlight set. Inline code is different — putty
(`--s1` fill, `--line` border, 4px radius), not glass.

### Tool Strip
A meter strip on the reading field: `--s3`, 9px radius, hairline border, mini
lamp + mono tool name + plain primary argument (the command or path — raw
JSON only as fallback, truncated at 300 chars) + chevron (rotates −90° when
closed). Output sits in a recessed `--s1` window underneath (12px mono,
16rem max-height), visible by default; collapse animates via CSS grid rows
(1fr ↔ 0fr at 120ms), so the output stays in the DOM.

### Banners
Printed notices, 7px radius, one per tone: error is red ink on `--bad-soft`
with `--bad-line` border; info is silkscreen (`--note-soft` / `--note-line`,
`--ink-2` text). Lifecycle notices (setting up, waking) are info, never error.
The not-signed-in state is a red-lamp chip in the header; healthy auth is a
green lamp with a 10px "auth" label — loud is earned only by failure.

### Files Shelf
A tray pulled out under the header: full-bleed `--s1` with the well shadow,
capped at 40dvh, rows of mono paths with tabular meta, hover washing in 60%
`--s3`.

### Workspace Tabs and Git Changes
The thread's right bay starts with a flush raised-key bank containing
`changes` and `terminal`. The active tab is pressed into `--s1`; the future
terminal tab shows an honest disconnected state until its own shell PTY lands.
The seam between the thread and workspace bays is a draggable separator with a
quiet physical grip. Pointer dragging and arrow keys adjust it, Enter restores
the equal split, and the browser remembers the position. It disappears when
the bays stack on narrow screens.

Changed files are compact editor modules: disclosure chevron, strong basename,
muted directory, tabular `+`/`−` counts, and a one-letter git status. Committed,
staged, and unstaged groups retain Git's layers instead of flattening them; an
untracked path belongs to unstaged, and one path may appear in both staged and
unstaged when only part of its work is staged. Opening a file reveals a
theme-aware inline unified view with line-number gutter, full-row add/delete
washes, and compact `n unchanged lines` separators derived from hunk
coordinates. Raw patch plumbing (`diff --git`, index hashes, file markers, and
hunk headers) never reaches the rendered rows. One file is open at a time; wide
code scrolls inside its keyboard-focusable diff region. Opening an untracked
text file reads it on demand and presents its complete contents as a new-file
addition; binary and oversized files report why they cannot render.

### Named Rules
**The Actions-In-The-Module Rule.** A module's controls live inside it, on its
right edge as a flush, hairline-divided `--s3` control bank. The bank remains
quiet through the warm ramp and muted ink, not by disappearing or boosting
every secondary control; hover lifts only the approached key to `--s4`.

**The Full Failure Rule.** Repository preparation and scoped publish failures
print the backend's complete actionable text inline with `overflow-wrap:
anywhere`. Never replace it with a toast, a generic “failed,” or ellipsis-only
disclosure.

**The Primary Argument Rule.** A tool strip shows the one thing that tells the
story — the command or the path — never raw JSON when a primary argument exists.

## Do's and Don'ts

### Do:
- **Do** route every color through a token.
- **Do** define both theme values for any new token — except glass and syntax,
  which are defined once and never re-themed.
- **Do** keep the out-of-CSS literals in sync when tokens change: `index.html`
  theme-colors (#17171b / #ece8df = `s2`), the manifest colors (#ece8df), and
  the raster icons (#cc3f00 on #ece8df, regenerated via
  `packages/web/scripts/make-icons.mjs` with `icons.provenance.json` updated).
- **Do** author new icons in `Icon.svelte`'s 2px round-cap/round-join 24-box
  family; every control's icon is drawn there.
- **Do** give every state a lamp and choose its rendering structurally: lit,
  blinking (amber only), or unlit lens.
- **Do** keep transitions at 120ms ease (80ms for press travel) and entrances
  at 140ms `settle-in`; the blanket reduced-motion guard covers new motion.
- **Do** give icon-only keys both `title` and `aria-label`, and give any
  rest-quiet affordance the full triple: hover, `:focus-within`, `hover: none`.
- **Do** set `overflow-wrap: anywhere` on anything rendering machine output.
- **Do** write all interface copy lowercase; the silkscreen voice is authored,
  not transformed.
- **Do** preserve the quiet warm ramp as hierarchy: full ink is earned by
  reading content and approached controls; secondary metadata remains muted.
- **Do** keep threads global and visibly project-attributed, with repository
  preparation in projects and diff/push/PR scoped to the primary checkout.

### Don't:
- **Don't** paint any background outside `--s0`–`--s4`.
- **Don't** add a second accent, use the signal for state, or put a lamp
  pigment on a clickable affordance.
- **Don't** render state as tints of one dot — sleeping is an unlit lens, and
  amber never appears without `.blink`.
- **Don't** theme the code window; glass is one material in both themes.
- **Don't** introduce cool grays into the enclosure: light-theme neutrals live
  at OKLCH hue 87–95°. Audit: a new putty neutral within ~10° of hue 90.
- **Don't** add pills (99px radii) or new circles; circles are lamps and the
  send key only.
- **Don't** float anything: no drop-shadow overlays until a true overlay
  surface exists to claim the reserved `--shadow-float`.
- **Don't** light the reserved `--lamp-blue` without a genuine fifth
  structurally-distinct state; it ships unused.
- **Don't** uppercase anything, anywhere.
- **Don't** add font or icon packages beyond the two self-hosted faces
  (Archivo Variable + italic, JetBrains Mono 400/600).
- **Don't** flatten the Braun hierarchy by increasing all secondary contrast,
  or turn orange into a general emphasis color for neutral actions.
- **Don't** expose cubes, a projectless thread path, project-local thread
  silos, or a cross-repository push-all action.
