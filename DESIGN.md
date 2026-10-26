---
name: cube
description: a bench instrument for running agents — putty enclosure, states in print, one signal orange
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
  ok: "#2e7d4a"
  wait: "#b06f14"
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
silkscreen, one signal color, states printed as words. "Weniger, aber besser" —
when torn between renditions, the quieter, more machined one wins.

cube is rendered as a machine you own: a warm silkscreened bench instrument in
the Braun / Teenage Engineering panel lineage. The screen is the instrument's
front panel — a putty enclosure carrying recessed display wells, raised keys
with real 1px press travel, lowercase silkscreen micro-labels and states,
and exactly one signal orange for the controls that are yours to touch. It is a
deliberate refusal of the category default: this is not a near-black chat app
with a neon accent.

Depth here is physical, never atmospheric. Every surface sits on a numbered
ramp (`--s0` deepest recess through `--s4` reading field) and nothing exists
outside the ramp; wells are sunk with inset shadows, keys sit proud with a
small offset shadow and travel down when pressed. State is printed, never
lit: a quiet word in silkscreen ink (`working`, `suspended`, `turn ended`),
a failure in `--bad` ink, and nothing at all for the ready default. There
are no status lamps, glows, halos or blinking anywhere (the user's call).
The one thing that moves is the **thinking cube** (below): square ink dots
in a cube beside the words of work in progress, never instead of them.
Code lives behind dark glass in both themes, like a display window set into
the panel.

Dark mode is the black edition of the same instrument, not a second design:
the enclosure is anodized (the surface ramp inverts around a reading field
that goes darker than the enclosure), the silkscreen goes pale, the signal
warms up to `#ff5a14`, and the glass stays glass. Motion is mechanical and
small: 120ms state changes, 80ms key travel and 140ms settle-in entrances —
all silenced under `prefers-reduced-motion`. Nothing else repeats: only
the thinking cube moves while work is in progress, and it is still under
reduced motion.

**The sheet (OptChat, cube's home).** The user chose direction **A+ · ark
med marg** for the chat: one quiet sheet on the reading field where the
conversation has the screen, what it started or named stands in a margin
beside the message that says so, and everything else is one step away in an
index. The chat sheds the instrument's physical costume (decks, seams,
rails, raised strips, labels) but keeps its tokens, type and one
signal. **Every other page is on the same sheet** (the user's call, after
threads stopped looking like the chat): the reading field (`--s4`) edge to
edge, the header as one quiet row, hairline frames instead of recessed
wells, soft `--s3` faces for what is selected or yours, a thread's
conversation and composer exactly as the chat's. Its
contract is the chat's surface brief
(`packages/web/.impeccable/surfaces/packages-web-src-components-chatview-svelte.md`)
and the Sheet components below.

**Key Characteristics:**
- Warm putty enclosure on a numbered five-step surface ramp; no surface outside it
- One signal orange, theme-tuned, reserved for what the user can touch
- States in print: quiet words, failure in error ink, ready says nothing; no lamps or blinking
- One sheet: the reading field everywhere; hairline frames and soft faces, not wells and seams; keys keep a soft drop and real press travel
- Dark-glass code windows that stay dark glass in both themes
- Lowercase silkscreen labels (11px, tracked); Archivo for the enclosure, JetBrains Mono for machine truth
- The black edition: dark mode as the same instrument anodized, not redesigned

## Colors

Warm putty neutrals (OKLCH hue 87–95° in the light theme), one signal orange,
two state inks, one error ink, and a single dark-glass material. Frontmatter values are
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
The state inks, used sparingly: a state is a word, and most words stay in
silkscreen ink.
- **OK** (`--ok`, #2e7d4a / #57c97e dark): a done merge and a delivered
  comment's mark in a document. Never a dot.
- **Wait** (`--wait`, #b06f14 / #e5a33c dark): a waiting comment's mark in a
  document. Never a dot, never blinking.
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

### Named Rules
**The Numbered Ramp Rule.** Every background is one of `--s0`–`--s4`; nothing
exists outside the ramp. Audit: in the light theme OKLCH lightness ascends
monotonically s0 → s4 (88.0% → 98.5%); in the black edition the ramp inverts
around the reading field — s4 (#101013) is darker than the enclosure s2
(#17171b), and the order is s0 < s1 < s4 < s2 < s3. Both orderings must hold.

**The One Signal Rule.** One accent. `--signal` marks only what the user can
act on, and each theme pairs it with its own `--signal-ink`. Never use the
signal for state, and never use a state ink on a clickable affordance.

**The Printed State Rule.** A state is a word, never a light. No status
dots, glows, halos, pulses or blinking, anywhere. The thinking cube is the
one sanctioned movement: it stands beside a moving state's words (never
alone, never in a list, never for ready, done or failed), is hidden from
screen readers and is still under reduced motion. Moving states (`working…`,
`running`, `starting the thread's machine`) are quiet silkscreen words; a
failure is the same word in `--bad` ink with its full text where the Full
Failure Rule applies; ready, done and signed in are the default and say
nothing or almost nothing. Each state keeps an accessible name. A mark of
kind is not a state: an artifact's file mark in the chat's margin and index
stays.

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
  language.
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

The app is a full-height flex column (`100dvh`) on the reading field
(`--s4`; `index.html`'s theme colors are the same). A page waiting for its
first answer prints one line, `loading…`, in `--ink-2` in the middle of the
room it will fill; the shell, the view and its conversation each use that
same line, so their waits in turn read as one (no other wording, no blank
step, no surface change between them). The thread list keeps the
centered **47rem** reading measure (`--col`). A thread has the whole sheet
and no menu, destinations or thread list of its own (see "A thread" below):
the chat is the way to every other thread.

The thread list's `new thread` key opens one native dialog, also used by
project detail and the `n` shortcut (in a thread, `n` starts one in its
project). A
project-specific entry preselects its project; the general entry includes
ready projects with no threads. The first message owns the surface, with
project and actual model selectors beneath it and one start action. Enter
starts; Shift+Enter adds a line. Escape closes without discarding the draft.
On phones, the project selector takes its own row. Loading, missing setup and
submission errors stay inside the dialog; uncertain submissions retain their
exact payload for retry.

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

The chat is the exception: one sheet with no header row beyond the wordmark
(the index key) and the 47rem column on the viewport's centreline, the
composer on the same line (both reserve the scrollbar's room on both
edges), nothing beside it. At 76rem and wider a margin hangs
outward to the right, 1.5rem beside the column, as wide as the room there
allows up to 18rem; it never shifts the column or the composer. Below
76rem the margin is not drawn and its thread notes sit under their messages.

At the 40rem mobile breakpoint (and on a touch screen under 30rem tall, a
phone on its side): the conversation keeps the screen. Elsewhere the
destinations fold behind one menu key that names the current page; a
thread's bar is one row of the way back, the title and the `details` key,
whose row beneath holds the model too and folds again when the composer
takes focus. The chat has no strip: its model and memory are in the
index, the whole screen on a phone. While the on-screen keyboard is up
(`data-keyboard` on the root, from `lib/keyboard.ts`), the header, the
chat's wordmark row and its memory step aside, and with under ~220px left a
thread's strip too. On a phone the composer's attach and send keys
are 2.25rem faces with a 2.75rem hit area; the textarea rises to 16px, and the
form stands 1rem off the bottom edge, or `env(safe-area-inset-bottom)` and
0.25rem where that is more, except over a keyboard (0.85rem, no inset). On a
wider screen the sheet's composer stands a breath off the window's bottom
edge that grows a little with its height (1rem to 1.85rem, ~23px at 900px).

### Named Rules
**The Reading Measure Rule.** 47rem remains the measure for prose and thread
lists. Comparison workspaces may use sibling bays, but reading content inside
them keeps its own scroll and never stretches prose across both bays.

**The Sixteen Pixel Rule.** The composer textarea is 16px at mobile width so
iOS Safari does not zoom on focus. Any new text input inherits this rule.

## Elevation & Depth

Depth is physical, never atmospheric. A surface is raised (key shadow), sunk
(well shadow), or flush on the ramp — there are no floating layers and no
ambient glows. The only "elevation" in the classic sense, `--shadow-float`,
belongs to true overlays: the folded menu and the chat's index dialog.

### Shadow Vocabulary
- **Key** (`--shadow-key`: `0 1px 2px rgba(38,32,18,0.1)` light): a short
  soft drop — a key resting on the sheet. No machined inner highlight.
- **Key down** (`--shadow-key-down`): the pressed key — the drop collapsed
  to a 1px blur. Applied with 1px `translateY` on `:active` and on
  held toggles (`.key.held`, which also drops to `--s1`).
- **Well** (`--shadow-well`: inset 1px 3px + inset 1px ring, light): only the
  code window's glass and the diff editor now; lists, boards and the
  comments bank are hairline frames on the sheet.
- **Seams**: the header's machined double seam (1px `--line-2` border plus two
  layered `box-shadow` lines: an `--s4` highlight over a `--line` groove) and
  the composer's answering single inset highlight above its `--line-2` border.
- **Micro-depth**: tool strips carry a 1px `0.06`-alpha drop; tool output and
  the composer textarea carry a shallow inset (`0.08`–`0.1` alpha).

### Named Rules
**The Real Travel Rule.** A key press is physical: `:active` translates the
key 1px down and swaps `--shadow-key` for `--shadow-key-down` at 80ms. Hover
brightens the face (`--s3` → `--s4`) and never moves the key.

**The Hairline Rule.** On the sheet, structure is a 1px `--line`: under a
pane's rail (an artifact's strip, the comments head), around a thread's
details row, beside the comments bank, around a list or board
(well radius). No seams, decks or recesses.

## Shapes

Three radii carry the whole enclosure: **9px keys** (`--r-key`, also user
message strips, tool strips, code windows, the composer textarea), **14px
wells** (`--r-well`; module faces inside a well use `calc(--r-well − 5px)`),
and **7px chips** (`--r-chip`: banners, the not-signed-in warning, framed
transcript images). Small utility radii (3–5px) appear only on the focus ring,
inline code, and hover washes. The one circle is the round send key (2.4rem). There are no pills anywhere. The single
dashed border in the system is the missing-image retry placeholder.

Iconography is one authored stroke family in `Icon.svelte`: 24-box, 2px
stroke, round caps and joins, drawn to match the cube wireframe glyph (the
brand mark, drawn inline in the header and favicon). The set: plus, close,
pencil, trash, chevron, file, refresh, arrow (up), down and search. No icon
libraries, and no unicode glyphs standing in for controls.

## Components

Motion grammar, shared by everything below: state changes at 120ms ease, press
travel at 80ms, entrances via `settle-in` (140ms ease-out, 2px rise — nothing
bounces), and a blanket `prefers-reduced-motion` guard silences all of it.
Nothing loops.

### First-run onboarding
Onboarding is a quiet welcome, not an instrument panel. This surface explicitly
omits cards, recessed wells, glows, raised keys, and the header seam.
Use the existing warm palette and Archivo type on an open, centered reading
column: one question, adjacent login/skip choices, and plain text status. The
primary action is the app's own orange key and secondary actions are plain
keys — the same `.key` system as the rest of the product, so the first run
looks like the app it hands over to. A small
step count lives in the header, while access details sit below a single hairline.
Pending codes, connected accounts, and errors use text, as states do everywhere.
GitHub login from a project uses this same full-screen treatment at the project's
`/github` subroute, not an inline widget. It explains the underlying GitHub CLI
login and returns to the project, rechecking access after successful login.
Repository errors appear once beside the affected repository, not duplicated
in a page banner. Other project and thread controls retain their treatment.
The last setup step may offer one host choice in the same quiet voice (chat
memory: a label, a sentence and a native select, defaulting to the safe
choice); it is never required to finish.

### Header
One quiet row on the sheet: the wordmark, the places as plain 13px words
(the open one on a soft `--s3` face, hover washes the same face), auth at
the end. No deck, seam or signal underline. On a phone the places fold
behind one menu key; the menu is a true overlay (`--s4`, well radius,
`--shadow-float`).

### Settings
One header entry, `settings`, opens host-wide pages: model providers, chat
memory, system. Beside the page sits a **selector bank**: flush on the
sheet, one item per page, each a name (key type) over a silkscreen hint.
The open page's item sits on a soft `--s3` face with its name in 650 and
`aria-current="page"`; the others wash on hover. Boards inside a page are
hairline frames. No signal colour or side stripe
marks the selection. At 46rem and below the bank lies flat above the page as
one row of equal keys carrying short names (the full name stays the link's
accessible name). Each page keeps one headline
(20px/650) and its own controls; one primary key per page at most.

### Keys (buttons)
- **Shape:** key, 6px radius, 1px `--line` border, `--shadow-key` (a soft drop).
- **Default:** `--s3` face, `--ink-2` label (13px/550); hover lifts to `--s4`
  face and `--ink` label. Press: 1px travel + `--shadow-key-down`.
- **Primary:** `--signal` face, `--signal-ink` legend, border darkened to 80%
  signal; hover mixes 8% white in. One primary per screen: "new thread" on
  the list and "save" in project configuration. The thread rail has no primary action.
- **Icon key** (`.key.icon`): square-ish padding, always `title` + `aria-label`.
- **Round key** (`.key.round`): a 2.4rem circular signal key. The composer's
  send key (`.send-key`) is the same circle at one text line's height.
- **Held toggle** (`.key.held`): pressed-in look (down shadow) for an open
  toggle, with `aria-expanded`.
- **Danger hover** (`.key.danger`): `--bad` ink on `--bad-soft` wash.
- **Disabled:** 0.45 opacity, cursor default.

### States
Words in place of lamps (the Printed State Rule). Threads: `starting the
thread's machine`, `waking…`, `waiting for a free slot`, `suspended`, `error`
(in `--bad`); ready prints nothing. Tools and startup steps: a quiet
`.tool-state` word after the summary — `running`, `waiting`, `no result`,
`interrupted`, and `error` / `failed` in `--bad`; done and ok print nothing
(an `sr-only` word keeps the accessible name). While a run is on, the
conversation's `working…` (and `waiting on …` for background agents) has
the thinking cube before it; a thread whose machine starts, wakes or waits
for a slot shows the large cube over those words in its empty conversation.

### Thinking cube
`ThinkingCube.svelte` draws `lib/thinking-cube.ts`: a cube of square dots
(4 per edge at 20px, 6 at 64px) on a 2D canvas, the libraries.dev "thinking
orbs" idea made cube's own: squares, not round dots; a cube, not a sphere;
ink (`--ink-2`), never the signal. Three states, each one movement:
`working`, a slow turn while one third of the cube makes a quarter turn and
clicks back into the lattice, as a puzzle cube does; `starting`, the dots
gather from a loose cloud into the cube, hold and let go (a machine being
put together); `waiting`, a slow turn with a soft band passing through
the layers. 20px beside a line of text, 64px over a centred wait; never in
lists or for ready, done or failed. All cubes share one clock, pause
offscreen and in a hidden tab, and show one still frame (the cube whole)
under `prefers-reduced-motion`. The words beside it carry the state and its
accessible name; the canvas is `aria-hidden`. Projects, repositories and
runners print their status word (`checking`, `ready`, `unreachable` in
`--bad`). The conversation's busy line is `working…`, static. Auth is the
quiet word `signed in` (`ok` on a phone) or the red-ink `connect provider`
chip.

### Thread Module Well
The list is one hairline frame (1px `--line`, well radius, 0.35rem
padding) on the sheet, holding one module per thread, separated by `--line` hairlines. A
module face is the whole link: title, tabular meta (relative time, state
label, project attribution, error preview). The thread list is global by
default and its compact project select writes the filter into the hash URL;
project context never becomes a separate thread silo. Rest face is
`--face-rest`; hover washes in `--s3`; the module's own keys are flush and
wash in `--s3` on approach. Rename swaps the title for an engraved input —
borderless, 2px `--signal` bottom rule. Empty list: centered hint with the one
primary key (the header key is suppressed so there is exactly one way to act).

### Project Switchboard
The project index reuses the module well but adds repository names, repository
and thread counts, checked time, and a flush re-check key bank. Project errors
wrap to their full text inside the row; they are not reduced to a generic
status or clipped preview.

Detail is a vertical repository control board. The first row is permanently
the writable primary checkout at `/workspace`; read-only reference rows print
`../repos/<checkout-name>`. Each row combines its role, URL/base/checkout
fields, and exact evidence: not checked, checking access and branch, resolved
base plus abbreviated OID, or the complete repository error. Saving makes the
configuration dirty and therefore not checked; check and thread creation stay
disabled until the saved project is ready. The bottom action bank preserves
the hierarchy: one orange save action, neutral check/new-thread/thread-link
keys, and a separated red-ink delete action. Orange does not spread to every
important-looking secondary control.

### Thread Repository Control Bank
Every thread names its project and links back to that switchboard. Repository
review is always scoped to the thread's pinned primary checkout. There is no
repository selector: reference checkouts exist for agent context, not as
publish targets. The changes pane distinguishes committed, staged, and unstaged
work. Publication is requested in the conversation and performed through the
worker's scoped host tools; the web UI has no publication panel, fixed runbook,
or push-all control.

### Composer
On the sheet in both the chat and a thread (`.conversation.sheet`): no deck
or seam, the field with the well radius and a soft 1px-offset shadow. Its field and keys sit in the
transcript's reading measure, centred under the text with the same side
padding, so a draft starts where the conversation does. One wide `--s4` field,
radius a key's plus its padding, shallow inset shadow: the text auto-grows to
11rem inside it; focus in the text swaps the field's border to `--signal` (the
one sanctioned replacement of the global 2px signal focus ring). Its keys sit
inside, square and exactly one text line tall (2rem; 2.75rem for a fingertip),
on the draft's last line: where images can be sent, a `+` icon key at the
start opens the file picker (paste and drop attach too; never a worded
"image" key), and the round signal send key at the end. Stop, while a run is
on, is a worded key beside the field at the field's height. Enter sends; Shift+Enter inserts a new
line. The keyboard hint lives in the field's tooltip and accessible description,
not a permanent extra row. A thread's model selection belongs in its conversation pane's top rail
(the chat's is in its index):
the actual model id as a quiet text control, with providers grouped in the
opened list. Toggles in a rail (the now bay's fold) are
quiet text controls too (`.strip-toggle`): the rail's 11px label type, no face,
a hover wash, pressed in with a turned chevron while open. Rails beside each
other share `--rail` height, padding and hairline, so they read as one band. Never substitute an effort label such as "high" for the model.

### Code Window
Dark glass in both themes: `--glass` body inside an inset well shadow plus a
1px `--glass-line` ring, 9px radius. Head: `--glass-head`, lowercase mono
language label and an icon+text copy key in glass chrome (#9aa0ad) that flips
to `--syn-ok` with a check icon for 1.5s. Body: 12.5px mono in `--glass-ink`
with the single `--syn-*` highlight set. Inline code is different — putty
(`--s1` fill, `--line` border, 4px radius), not glass.

### Tool Strip
A meter strip on the reading field: `--s3`, 9px radius, hairline border, mono
tool name + plain primary argument (the command or path — raw JSON only as
fallback, truncated at 300 chars) + its state word unless done + chevron (turns 180° over 120ms when
open). Output sits in a recessed `--s1` window underneath (12px mono,
16rem max-height) inside a native disclosure, so it stays in the DOM. A strip opens while it runs,
waits or failed, or when it returned images; once the reader opens or folds one, that choice holds through
streamed frames and the run's end. Images a tool returned (a screenshot it
read) sit in the same `--s1` window as framed 7px-radius thumbnails (one
alone up to 28rem × 18rem) that open the image viewer; one the host no
longer has is the dashed retry placeholder. Agent prose shows an image only
when it names a path the thread read as one, on its own line, framed the same
way.

### Machine Startup
While a thread's machine starts (and after a start that failed) a panel sits
under the thread strip on the sheet, capped at 45dvh (38dvh on a
phone) so the composer stays on screen: a silkscreen head (`machine startup`,
the running total in tabular mono, a quiet link to the project's hooks and
machine size) over one tool strip per step — mono step name, the detail cut
to one line, its state word (`running`, `failed` in `--bad`, `interrupted`;
ok prints none), the step's time. The running hook's log opens beneath its step in
the strip's recessed `--s1` window and follows its end. A failed step opens
with its whole error (the Full Failure Rule), its memory and the end of its
log; it folds while a later try runs, and the reader's own open or fold
holds. Running out of memory is the one red banner in the panel, with a
`machine size` key to the project page. Once the machine is ready the panel
goes; the machine label in the strip (dotted underline) opens it again, with
a close key.

### Banners
Printed notices, 7px radius, one per tone: error is red ink on `--bad-soft`
with `--bad-line` border; info is silkscreen (`--note-soft` / `--note-line`,
`--ink-2` text). Lifecycle notices (setting up, waking) are info, never error.
The not-signed-in state is a red-ink chip in the header; healthy auth is the
quiet word "signed in" — loud is earned only by failure.

### Files Shelf
A tray pulled out under the header: full-bleed `--s1` with the well shadow,
capped at 40dvh, rows of mono paths with tabular meta, hover washing in 60%
`--s3`.

### Workspace and Git Changes
The thread's right bay is the primary repository's changes surface. The seam
between the conversation and workspace bays is a draggable separator with a
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

### The Sheet (OptChat)
The chat's page is the reading field (`--s4`) from edge to edge: the
wordmark row (a key that opens the index; the auth chip only on failure),
the conversation, the composer. User messages are soft `--s3` faces with the
well radius, no border or shadow, right-aligned; replies are plain prose; a
thread's report is **one folded line**, as a tool line is: the thread's
name, `report`, its state in cube's words (`turn ended`, `stopped`, `failed`,
`failed to start`, `machine failed to wake`; `lib/report-line.ts` reads it
from cubed's own report forms, no model writes it) and its first words.
The chat's own answer is what the reader reads. A press or enter opens it:
its words under its name (linked to the thread while it is open) and
`· report`, set off by one `--line-2` hairline; the reader's choice holds.
A failed report stands open, its state in `--bad` ink (it folds when the
reader folds it): a failure is never hidden by default. New reports come
folded; the margin's way to a report opens it. No message
carries a "you"/"agent" label; each keeps its accessible name. Tool lines
are quiet: no face until opened. The chat's own tools speak in words —
`started 3 threads · 1 not started`, `told <thread>`, `created <title> ·
revision 1` — with the tool's mono name after; other tools keep their raw
primary argument. A **run of tool calls** is one folded line too (the
user's call, 2026-10-26; `lib/tool-groups.ts`): two or more calls with
nothing between them but streamed reasoning fold to `n tools called`, then
`n failed` in `--bad` ink, the run's state while it moves (`waiting`,
`running`, `no result`) and the call worth naming in its tool line's words
(the one that moves, else the first that failed, else the last). It comes
folded, failures too: the line says the failure, and inside, the failed
call stands open. Opened, each call is its own quiet line under one
`--line-2` hairline (`--bad-line` when one failed). Prose, a user message,
a report, a message being sent and a call that returned images end a run;
one call alone stays its own line; nothing moves or reorders. The reader's
choice is kept by each of the run's calls, so it holds as the run grows a
call at a time and when an earlier page reaches back into it. A spawn or a
write folded into a run keeps its margin note by the run's line, its
thread lines under it on a phone, and the note's way back opens the run.
Threads keep their tool lines unfolded. The composer field takes the well radius and a soft
1px-offset shadow, and nothing stands beside it: no key, count or state.
What runs and what failed is said where it belongs, in the margin's notes
and the index.

### The Margin
At 76rem and wider, a margin to the right of the centred column (up to
18rem, never moving it), scrolling with it.
One note per message that started threads (a spawn's result lines), told a
thread that took it (a tell sent or queued into its turn), or named an
artifact (a write or edit result, a `#/a/` link in a reply, a comment
message), each thread and artifact once among the rows shown: an artifact
at its first row, a thread at its newest (its spawn, or the last tell it
took), so a thread comes back beside each tell; a refused, dropped or
failed tell moves nothing. A note is
flush: the 13px/600 title (an artifact's after its `--ink-3` file mark, its
kind) clamped to
two lines, one 12px `--ink-3` line of state in cubed's words (`turn ended`,
`machine failed` in `--bad`, `reading state…` until cube has answered,
`state not read` when it could not, `not known to cube` only once both the
overview and the thread list were read and cube counts it lost); a short
`--line` hairline reaches toward its message while the note stands level
with it (a note moved off its message draws none). A press opens it in place on a
hairline frame: short id, start time, the thread's newest report among the
rows shown with the way to it, then `open thread` or `read` in signal ink.
Four items per note, then `n more`. The margin follows the whole
conversation in reading and tab order, so after each message with a note a
key that takes no room (seen only while focused) leads to it, and an opened
note leads back to its message. Notes go down past a taller one and up
near the end; the opened one stays by its message; the margin never moves
the conversation or lengthens the page. A failed thread whose note is
scrolled away is pinned at the margin's top, with an arrow for the way back.
Below 76rem the same thread notes are one-liners under their spawn, the
state kept whole; artifacts stay links in the text.

### The Index
One dialog rising from the composer, the
system's floating surface: `--s4`, `--line-2` border, well radius,
`--shadow-float`, a putty-washed backdrop. Its head row: a search mark, the
filter field (14px, 16px on a phone; focused, a 2px signal rule under the
row) and a close key (a 2.75rem hit area on touch),
then the chat's threads (failed, moving, the rest; title, state ·
project), archived and lost counts, the newest artifacts (each after its file
mark), then the places (threads, artifacts, projects, settings) and the
chat's model select and memory toggle. Opened by the wordmark, `/` outside a field and
ctrl/⌘ k. A key, `/`, ctrl/⌘ k or a mouse puts focus in the filter; a tap
puts it on the sheet itself, so no on-screen keyboard rises over it (the
filter is a tap away). The arrow keys walk its items, enter in the filter
opens the first match, escape or the close key closes and gives focus back.
Rows and places are 2.75rem on touch.
On a phone (and a phone on its side) the index is the whole screen: no
border, radius or shadow, the filter row on top with its close key, the
results scrolling on their own beneath it. The places (one row of equal
keys) and the chat's model and memory stand at its foot while the lists
scroll under them, so no number of threads puts them out of reach. Its
height and top are the visual viewport's, followed as it changes, so while
the user types into the filter the on-screen keyboard covers neither the
filter nor the results (iOS keeps the layout viewport whole under its
keyboard). While it is up the model and memory step aside and the places
stay; with little room left (`data-keyboard="tight"`, a phone on its side)
the foot goes back to the end of the lists, so a result always shows and
the places are a scroll away. A press on a link while the filter is typed
in keeps focus in the filter, so nothing moves before the link opens; an
item the keys focus scrolls clear of the foot. On a wider screen the places
follow the lists, as the floating index always had them.

### The panel (every place over the chat)
The chat is home and stays mounted. Every other place (threads, a thread,
artifacts, projects, settings) opens over it in one modal panel
(`PagePanel.svelte`, a `<dialog>` shown modal): a sheet from the right on a
wide screen (up to 66rem, the chat showing beside it under a putty wash),
the whole screen at 52rem and below, its height the visual viewport's under
an iOS keyboard. The place keeps its own address (deep links, back and
forward work) and its own header row, which ends with a close key (a
thread's way back starts its bar); the wordmark and `chat` also close it.
Escape closes it unless a field holds the focus (a draft is never lost to
escape); a press on the chat beside it closes it. A thread's panel is
`whole`: the whole screen at every width, with no wash, border or shadow,
entering with `settle-in`, so there is no chat beside it to press. Closing goes to `#/chat` with the
chat exactly as it was (draft, scroll); focus goes back where it was.
While a place is open, the chat's own keys (`/`, ctrl/⌘ k) are off; a place
opened from the chat's index closes the index. One panel at a time: a
place opened from another replaces it; only a true dialog of the place (new
thread, an action's confirmation) stacks above it. This is a bounded step;
the structure around the chat may change again.

### A thread (the whole sheet)
Opened from the chat (a margin note, a report's name, a spawn's line, an
index row or a link), a thread takes the chat's whole sheet: the user's
choice, concept A of artifact a54a8cce. There is no menu, sidebar or
thread list; the chat is the way to other threads. One bar, flush on
`--s4` with no hairline: `‹ chat` (the way back, named "back to the
chat", a 2.75rem hit area on touch) at the start; the title (14.5px/600,
one line, the whole name in its tooltip) on the conversation's centreline,
with a 11px line of state beneath only when there is one to print (a
state, a failed hook, a machine notice); then, at the end, the auth chip
on failure, the model (on a wide screen) and the `details` key. The
details are folded when the thread opens and take one hairline-framed row
in the reading measure: project, base, machine label (the key to the
startup steps), usage, the full reason a wake waits, the model on a phone,
and the archive key. Then the conversation exactly as the chat's (no
"you"/"agent" labels, user words on a soft face, quiet tool lines, a
report's name over its words) and the chat's composer, in the same place.
The title takes focus as the thread opens (a screen reader says where it
is; no keyboard rises on a phone); shift+tab reaches the way back; escape
outside a field, the way back and the browser's back return to the chat
with its scroll and draft, and focus goes back to what opened the thread.
An artifact's page is the same: document and comments bank on one sheet,
a hairline between, sent comments on soft faces, actions on a soft face in
a hairline frame.

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
  theme-colors (#101013 / #fbfaf6 = `s4`, the sheet), the manifest colors (#ece8df, the icons' ground), and
  the raster icons (#cc3f00 on #ece8df, regenerated via
  `packages/web/scripts/make-icons.mjs` with `icons.provenance.json` updated).
- **Do** author new icons in `Icon.svelte`'s 2px round-cap/round-join 24-box
  family; every control's icon is drawn there.
- **Do** print every state as a word with an accessible name; failure in
  `--bad` ink, the ready default silent.
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
- **Don't** add a second accent, use the signal for state, or put a state
  ink on a clickable affordance.
- **Don't** bring back status lamps: no dots, glows, halos, pulses or
  blinking to say a state. The thinking cube is not a lamp: it never stands
  for a state alone and never sits in a list.
- **Don't** theme the code window; glass is one material in both themes.
- **Don't** introduce cool grays into the enclosure: light-theme neutrals live
  at OKLCH hue 87–95°. Audit: a new putty neutral within ~10° of hue 90.
- **Don't** add pills (99px radii) or new circles; the send key is the one
  circle.
- **Don't** float anything but a true overlay (the folded menu, the chat's
  index): `--shadow-float` is theirs alone.
- **Don't** uppercase anything, anywhere.
- **Don't** add font or icon packages beyond the two self-hosted faces
  (Archivo Variable + italic, JetBrains Mono 400/600).
- **Don't** flatten the Braun hierarchy by increasing all secondary contrast,
  or turn orange into a general emphasis color for neutral actions.
- **Don't** expose cubes, a projectless thread path, project-local thread
  silos, or a cross-repository push-all action.
