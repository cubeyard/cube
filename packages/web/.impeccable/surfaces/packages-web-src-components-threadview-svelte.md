---
version: 1
slug: "packages-web-src-components-threadview-svelte"
primary_target: "packages/web/src/components/ThreadView.svelte"
related_targets: ["packages/web/src/components/ChangesPane.svelte","packages/web/src/components/Header.svelte","packages/web/src/components/Icon.svelte","packages/web/src/components/Terminal.svelte","packages/web/src/app.css"]
---

## Scope and mode

The thread view at `#/t/<id>` — where work is watched and reviewed. **Operate**:
the visitor drives the real pi TUI, reviews the primary repository, and
publishes it. The terminal is the product; the shell is the instrument panel
around it.

## Audience, job, task

A self-hoster who handed over a task. The job is "let me continue the pi
session, know its project, and review exactly what the primary repository will
publish." Tasks: use the TUI, open project context, inspect the primary diff,
preflight and hand Ship to the agent, inspect primary-workspace files, and
delete the thread.

## Content and constraints

- Conversation history and interaction belong exclusively to pi's terminal
  session over the pty WebSocket. Do not add a second transcript or composer.
- Every thread summary carries a required project. Print `project / name` as a
  link to its switchboard; never infer an optional or missing project.
- Repository checkouts come from the immutable thread snapshot, not the
  project's current editable configuration. The writable primary is
  `/workspace`; read-only references are `../repos/<checkout-name>`.
- Changes and Ship always act on the primary repository. Reference repositories
  cannot be selected, changed, or published.
- Ship must preserve the primary checkout in the injected runbook. Its
  preflight distinguishes committed files from tracked/untracked working-copy
  files, and complete failures stay inline rather than becoming generic toasts.
- The files shelf explicitly describes the primary workspace; it does not
  pretend to list additional repositories.
- The desktop workspace is split into two equal bays: the pi conversation on
  the left, and a tabbed workspace surface on the right. Their divider is
  draggable and keyboard-adjustable, with its last position remembered in the
  browser. Mobile stacks the bays and removes the inapplicable divider.
- `changes` scopes itself to the primary repository and separates committed,
  staged, and unstaged work. Untracked paths belong to the unstaged group;
  opening an untracked text file reads its checkout content on demand and
  renders the whole file as additions. Binary and oversized files stay
  explicit. One file diff is expanded inline at a time.
- The right-side `terminal` tab reserves the shell surface without pretending
  the shell PTY exists. Until that backend lands it shows a plain not-connected
  state; the left-side pi TUI remains the agent thread, not the future terminal.
- Setup, sleeping, errors, service links, repository controls, and both
  workspace bays must remain operable on a phone without page overflow.

## Direction and memorable moment

World: the bench instrument (seed 1a30da04), extended by the project switchboard
(seed `e0bc0e78`). The terminal is dark glass in both themes. Above it, global
navigation and the thread strip form one compact control rail: status lamp and
title, project label, service links, then the primary `ship` key. The terminal has no redundant pane label,
so this is the only vertical chrome between browser and work. Ship earns the
screen's single signal-orange primary; no repository selector competes with it.
Muted branch/ahead/dirty evidence stays subordinate to the terminal rather than
flattening the Braun hierarchy.

The workspace is now a two-bay instrument. The conversation keeps the dark
glass display on the left. The right bay is a recessed git control bank with a
flush `changes` / `terminal` tab bank in its head rail. File paths and counts
are machine truth in mono; selecting a file pulls its patch editor directly
out beneath the row. The editor follows light/dark mode and omits raw git
headers in favor of line numbers, full-row add/delete washes, and compact
unchanged-line separators. On narrow screens the right bay docks below the thread,
preserving the same material hierarchy and interaction rather than inventing a
mobile-only surface.

- Workspace images render inline: relative and `/workspace/…` srcs resolve
  through `GET /api/threads/:id/files/<path>` (host-side — a sleeping thread's
  images render without waking). A missing file shows the dashed in-system
  placeholder, which retries on click and when a turn ends; the browser's
  broken-image glyph must never show through.
- The **files shelf** remains the full workspace manifest, newest-first with
  sizes and disk usage in thread terms. `.git`/`node_modules` are counted, not
  listed. It is separate from the git changes tab and keeps its header toggle.
- The **Ship panel** repeats the committed boundary beside exact tracked and
  untracked local paths, then hands the commit/fetch/rebase/test/push runbook to
  the live agent and returns progress ownership to the conversation terminal.
- The changes pane polls host-side git every 10 seconds, so it works while the
  thread sleeps. Patch payloads retain the 4 MB server cap; a truncated patch
  keeps the complete file list and says that later inline diffs may be omitted.

## Unresolved

- No stop/cancel for a running turn.
- Full reference-repository browsing is not exposed; references remain
  available to the agent under `/repos`.
- Inline diffs are plain monospace today. Add path-based language detection
  and syntax highlighting later, preserving add/delete row colors, both themes,
  horizontal scrolling, and a fast plain-text fallback for unknown languages.
- The terminal tab still needs a distinct shell PTY inside the thread's
  environment. It must not reuse or replace the host-side pi conversation PTY.
