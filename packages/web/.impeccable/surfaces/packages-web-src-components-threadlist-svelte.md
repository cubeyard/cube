---
version: 1
slug: "packages-web-src-components-threadlist-svelte"
primary_target: "packages/web/src/components/ThreadList.svelte"
related_targets: ["packages/web/src/App.svelte","packages/web/src/components/Header.svelte"]
---

## Scope and mode

The global thread list at `#/threads` (and the empty/default hash) — the app's
home. **Operate**: the visitor is scanning state and resuming work, not being
persuaded. Scanability, project context, and honest status outrank expression.

## Audience, job, task

A returning self-hoster opening the tab after being away. The job is "what is
running, which project owns it, and what came back?" Tasks: scan across every
project, filter to one project, resume work, start from a ready project, rename,
and delete.

## Content and constraints

- One module per thread: lamp, title, explicit `project / name` attribution,
  relative time, state label, actions. Preserve full inline action failures;
  project attribution is not optional metadata that may disappear for space.
- The list polls every 3s; a slow response must never resurrect a deleted row
  (the sequence guard is load-bearing, not an optimization).
- The default is all projects. The project filter is encoded in the hash URL so
  project views can deep-link to the same global list rather than creating
  project-local thread silos.
- The new-thread composer requires a ready project. Error/checking projects stay
  visible but disabled; no repository fields belong in this composer.
- The composer states that the checked repository snapshot is mounted before
  start. With no ready project it routes to project configuration; there is no
  projectless fallback.
- Thread states only — `setting up`, `ready`, `sleeping`, `error`. The backing
  cube is invisible here and in the URL.
- Untitled threads read `untitled`, matching the delete confirmation.
- No auth, no account, no user switcher. Do not imply one.

## Direction and memorable moment

World: the bench instrument (redesign 2026-08-27, seed 1a30da04). The list is a
recessed well in the instrument's putty panel, one module per thread. The LED
lamp is the screen's whole idea: lit green (ready), blinking amber (in motion),
steady red (error), and — the honest detail — an UNLIT dark lens for sleeping.
Lamps warm up in a quick stagger when the panel arrives. Rename and delete are
keys INSIDE the module in a permanently visible, flush hairline-divided bank.
Muted ink and the warm ramp keep it quiet at rest; only the approached key
lifts to the reading surface. The empty state holds the single orange key, and
the list-head key is suppressed while it shows — exactly one way to start.

- Rename is inline: a hover-revealed pencil beside delete swaps the title for
  an input in place (Enter commits, Escape cancels, blur commits). Manual
  titles stick — the first prompt only auto-titles a null title.
- Disk usage deliberately does NOT live on the cards: the 3s list poll must
  stay cheap, and per-thread walks are not. It lives in the thread view's
  files shelf, in thread terms.

## Unresolved

- No free-text search, sort, or pagination. These become real questions past
  roughly 20 threads; do not add them speculatively.
