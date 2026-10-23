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
  raised strips) is off this surface; the tokens, lamps, type and the one
  signal stay.
- **One centreline.** The conversation column and the composer share the
  viewport's centreline at every width. The margin hangs outward to the
  right of the column in the room there (up to 18rem); it never centres
  with the column or shifts it left.
- **The margin (≥ 76rem).** Beside the column, scrolling with it: one note
  per message that started threads (a `spawn` result) or named an artifact
  (an `artifact_write`/`artifact_edit` result, a `#/a/<id>` link in a reply,
  an `[artifact <id>]` comment message), each thread and artifact once, at its
  first row shown. Nothing else: no counters, filters, project groups or
  settings. Empty is empty, and the margin's room is kept so the column never
  jumps.
- **Truth only.** A thread's state is cubed's own word from the chat's
  overview (`turn ended`, never `done`); a thread the overview no longer has
  is read from the thread list (`archived`) or says `not known to cube`; an
  unreadable overview says `state not read` with an unlit lens. An artifact
  link cube cannot resolve gets no note. No need-user state is invented: only
  a failure (`failing`) is pinned.
- **A note** is a lamp (a file mark for an artifact), the title and one line
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
- **The index.** The composer's work key (lamps and counts of what moves and
  what failed, else the index mark), the wordmark, `/` outside a field and
  ctrl/⌘ k open one dialog that rises from the composer (a bottom sheet on a
  phone): a filter; the chat's threads, failed then moving then the rest;
  the newest artifacts; the places (threads, artifacts, projects, settings);
  the chat's model and memory. Arrows walk it, enter opens, escape closes and
  gives focus back. It is the one floating surface (`--shadow-float`).
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
- Reports are not marked unread until seen: there is no seen state in cube
  to read, and none is invented in the browser.
- The rest of the app (threads, a thread, projects, settings, artifacts)
  still wears the bench instrument; its move to the sheet is separate work.
