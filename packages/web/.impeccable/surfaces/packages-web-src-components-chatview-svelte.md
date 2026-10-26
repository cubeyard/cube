---
version: 1
slug: "packages-web-src-components-chatview-svelte"
primary_target: "packages/web/src/components/ChatView.svelte"
related_targets: ["packages/web/src/components/ChatMargin.svelte","packages/web/src/components/ChatIndex.svelte","packages/web/src/components/WorkNote.svelte","packages/web/src/components/Conversation.svelte","packages/web/src/app.css"]
---

## Scope and mode

OptChat at `#/chat` (and the empty hash): cube's home. **Operate**: the
visitor talks to the one chat that starts and follows their threads, and
glances at what it set going. Direction chosen by the user: **A+ · ark med
marg** (artifact b246fb07, revision 3), built on A's minimal sheet.

## Audience, job, task

A self-hoster who works by talking to OptChat on a desktop and checks in
from a phone. The job: "say what I want, see what it started where it
started it, and get to anything else in one step." Tasks: write (text,
images), read a long history, follow a thread or artifact from the message
that started or named it without leaving the chat, open the full view,
change the chat's model, read its memory, reach threads, artifacts, projects
and settings.

## Content and constraints (the direction contract)

- **One sheet.** Nothing above the conversation but the wordmark, which is
  the key to the index, and the auth chip only when auth fails. No strip,
  rail, panel, tagline, destinations row or "you"/"agent" labels (each
  message keeps its accessible name). The physical costume (decks, seams,
  raised strips) is off this surface; the tokens, type and the one
  signal stay.
- **One centreline.** The conversation column and the composer share the
  viewport's centreline at every width. The margin hangs outward to the
  right of the column in the room there (up to 18rem); it never centres
  with the column or shifts it left.
- **The margin (≥ 76rem).** Beside the column, scrolling with it: one note
  per message that started threads (a `spawn` result), told a thread that
  took it (a `tell` result `sent to`, `queued for` or `already has it`), or
  named an artifact (an `artifact_write` result, a `#/a/<id>` link in a
  reply, an `[artifact <id>]` comment message), each thread and artifact
  once among the rows shown: an artifact at its first row, a thread at its
  newest (its spawn or the last tell it took; the user's call, 2026-10-26:
  a thread comes back beside each tell). A refused (`not sent`), dropped,
  failed or still running tell moves nothing. Nothing else: no counters, filters, project groups or
  settings. Empty is empty, and the margin's room is kept so the column never
  jumps.
- **Truth only.** A thread's state is cubed's own word from the chat's
  overview (`turn ended`, never `done`); a thread the overview no longer has
  is read from the thread list (`archived`); before cube has answered a note
  says `reading state…`, an unreadable overview `state not read`, both with
  an unlit lens; `not known to cube` only once the overview and the list were
  read, the thread is in neither and the overview counts lost threads. An artifact
  link cube cannot resolve gets no note. No need-user state is invented: only
  a failure (`failing`) is pinned.
- **A note** is the title (an artifact's after its file mark, its kind) and one line
  of state. A press opens it in place: short id, start time, the thread's
  newest report among the rows shown (with the way to it), and the full view
  (`open thread`, `read`). Escape folds it and returns focus to its head.
  Four items per note, the rest behind `n more`.
- **Stability.** The margin never moves the conversation and never makes the
  page longer than it: notes go down past a taller one, up near the end, and
  the opened one stays by its message. Only a note level with its message
  draws the hairline to it. Streaming, a longer state line or an
  opened note leave every message where it was.
- **Pinned.** A failed thread whose note is scrolled away is pinned at the
  margin's top with an arrow saying which way; a press shows its message and
  focuses its note.
- **Narrower (< 76rem, phone).** No margin: the thread notes are quiet
  one-liners under their spawn (state whole, the title gives way), artifacts
  stay the links they are in the text, so nothing shows twice.
- **The index.** The wordmark, `/` outside a field and ctrl/⌘ k open one dialog that rises from the composer (on a phone the whole
  screen, sized to the visual viewport so the keyboard never covers the
  filter or its results while the user types): a filter; the chat's threads, failed then moving then the rest;
  the newest artifacts; the places (threads, artifacts, projects, settings);
  the chat's model and memory. A key or a mouse focuses the filter; a tap
  focuses the sheet, so no keyboard rises; a close key is always there.
  Arrows walk it, enter opens, escape closes and gives focus back. It is the one floating surface (`--shadow-float`).
- **Nothing beside the composer.** No key, count or state before or
  after the field, at any width: what runs and what failed is in the notes
  and the index (removed at the user's request).
- **Reports fold (the user's call, 2026-10-25).** A thread's report is one
  line (name, `report`, cube's state word, first words); opened, it is
  whole. A failure stands open. Grouping consecutive reports, folding
  artifact-comment messages and sending an index search to the chat are
  proposals (artifact e113082c §8), not part of this.
- **Tool runs fold (the user's call, 2026-10-26).** Two or more tool calls
  in a row (only streamed reasoning between them) are one line: `n tools
  called`, `n failed` in error ink, the state while it moves, the call
  worth naming. Folded by default, failures too (the line says them; the
  failed call stands open inside). Prose, messages, reports and a call
  that returned images end a run; one call alone is its own line. A spawn
  in a run keeps its note by the run's line; the note's way back opens it.
- Composer, uploads, history paging and scroll keeping, routes and deep
  links, artifact reading, comments and confirmed merge actions are the
  existing ones, unchanged.

## Out of scope (the user's call)

New chat choice or approval buttons, in-chat setting elements, model-setting
tools, new approval semantics and any new OptChat capability. Existing
artifact actions stay where they are (the artifact page).

## Unresolved

- Thread names with emoji (#239, not merged): when they land, the note, the
  pin, the index row and the report label show the name beside the title,
  from the overview's `identity` and the report's `fromIdentity`.
- The margin follows the whole conversation in the DOM: a skip key after
  each noted message leads to its note and the note leads back, but reading
  straight through, a screen reader meets the notes after the last message.
- `GET /api/artifacts` answers the newest 200: an artifact named early in a
  long history and older than those gets no note.
- Reports are not marked unread until seen: there is no seen state in cube
  to read, and none is invented in the browser.
- The rest of the app (threads, a thread, projects, settings, artifacts)
  still wears the bench instrument; its move to the sheet is separate work.
