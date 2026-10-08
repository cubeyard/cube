# Work artifacts

An artifact is a document OptChat or a thread writes for the user to read
beside the chat: a post-merge review, a plan, a report. The user selects text
in it and comments; the comments go back to whoever wrote it, as an ordinary
message. An artifact may also offer typed actions (today only a pull
request merge) that run only when the user confirms them on its page.

The chat stays the only place to talk. An artifact is a linked work surface,
not a task: it records no state of the work, and nothing reads it to decide
what is done. Threads and the chat panel say what runs; an artifact says what
someone wrote.

```text
packages/server/src/
├── artifacts.ts          # the store: artifacts, revisions, comments, batches, action runs
├── artifact-service.ts   # agents' write/read, comment delivery, action preview and run
├── artifact-tools.ts     # artifact_write / artifact_read for OptChat and Pi threads
└── github-pulls.ts       # a pull request's live state and its merge
packages/claude-mod/hooks/tools.ts       # /cube/artifacts/<name>.md for Claude Code threads
packages/web/src/lib/artifact-render.ts  # Markdown, diff and diagram placeholders as data
packages/web/src/lib/mermaid.ts          # diagrams drawn as <img> of their SVG
packages/web/src/lib/anchor.ts           # selections as anchors, found again or outdated
packages/web/src/components/ArtifactView.svelte, ArtifactList.svelte
```

## Who writes and reads what

| agent | writes | reads |
| --- | --- | --- |
| OptChat | its own (`artifact_write`; `project` names whose repositories actions may use) | its own and those of the threads it started (`artifact_read`) |
| a Pi thread | its own (`artifact_write`, body inline or from a workspace file with `path`) | its own |
| a Claude Code thread | its own: `Write /cube/artifacts/<name>.md` (or `.json` as `{title?, body, actions?}`) | its own: `Read /cube/artifacts/<name>.md`, `Read /cube/artifacts` lists them |
| the browser | comments, sends them, confirms actions | everything (cubed has no users; see SECURITY.md) |

An agent revising or reading someone else's artifact is told there is no such
artifact of theirs. A thread's artifacts belong to its project. The Claude
Code mod reaches cubed on the private workspace socket; the thread's lease
token, which cubed holds for that Claude Code child, is the authorization, and
the routes refuse a Pi thread's lease. `/cube/artifacts` is not in the
machine: Edit and Bash do not reach it.

Every write is a whole new revision; older ones stay readable at
`#/a/<id>?rev=<n>`. A write with the same request id (a Pi task, OptChat's
tool call, a Claude Code `tool_use_id`) finds the revision it wrote, so a
replayed call writes once; a write identical to the newest revision writes
nothing. Each revision keeps its provenance: the agent (`optchat`, `pi`,
`claude-code`), the thread, the tool call, OptChat's model, and for a body read
from a workspace file its path and SHA-256. Bounds: title 200 characters, body
256 KiB, 8 actions, 500 revisions an artifact, 500 artifacts an author.

How to write one is in the tools' description (`ARTIFACT_GUIDE`), after
HumanLayer's [show-me skill](https://www.humanlayer.com/blog/show-me-skill):
short text beside compact visuals (a call tree, a file tree, a Mermaid
sequence or state diagram, a diff of the shape that changes, a table,
pseudocode), the smallest view that makes the point. HTML explainers are not
offered: raw HTML is shown as text.

## Rendering

The body is an agent's text and may quote anything, so the page renders it as
data (`renderArtifact`):

- GitHub Markdown; raw HTML is printed as text; links are `http(s)`, `mailto`
  or cube's own `#/…` pages (those open in place); images become links, so the
  browser fetches nothing the document names.
- ` ```diff ` and ` ```patch ` blocks are coloured line by line, as text.
- ` ```mermaid ` blocks are drawn by Mermaid 11 (loaded only on a page with a
  diagram) with `securityLevel: "strict"` and text labels, one at a time, at
  most 20,000 characters each, and shown as an `<img>` of the SVG: an image
  document runs no script, loads nothing and has no links. Mermaid draws in
  a hidden element of the page before the picture is taken, so that moment
  relies on its `strict` level (DOMPurify, no HTML labels, no click
  handlers); what stays on the page is only the image. The source is
  folded under the picture; a diagram that does not parse says why and opens
  its source.
- The OptChat transcript's own Markdown now also links `#/…` pages, so an
  agent's reply can link `[review](#/a/<id>)`.

## Comments

Selecting text in the document shows a `comment` key (or press `c`). A comment
is anchored to the revision on screen (while one is being written that
revision stays on screen; a newer one shows as newer rather than replacing
the text under the selection): the quote, up to 64 characters on each
side, its offsets in that revision's rendered text and the heading it falls
under. Diagrams are not part of that text and cannot be commented on.

Comments are drafts until the user presses **send**: all drafts of the
artifact become one batch whose message is fixed then (each comment's quote,
its context, the heading, the revision it was written on and the current
one), under one request id. Then:

- **OptChat's artifact:** the message joins the chat's own pending queue
  (`OptChat.send`), exactly like a message typed in the chat: between tool
  calls or as the next turn. It renews the thread tells, like any user message.
- **A thread's artifact:** the message is the thread's next prompt
  (`Conversations.submit`, which refuses while the thread works). A working
  thread is never interrupted and nothing is queued into its run: the batch
  stays `queued` with `waiting: the thread is working; sent once its turn
  ends`, and is tried again every 10 s. A thread whose machine is not ready
  keeps the reason. An archived thread's batch is `undeliverable` and says
  so; nothing reaches it.

Every attempt sends the same text under the same request id, which Pi and
Claude Code accept once, so a retry, a restart or a repeated send delivers
the batch once. The page shows each comment's state with a lamp: not sent,
waiting (with the reason), sent, undeliverable.

On another revision a comment is looked for again: its quote where the text
around it fits best (`found here`), or `not in this one` when the quote is
gone or two places fit equally well. A comment is never shown on words it was
not made on.

## Actions

An action is typed data stored beside the body, never part of it. The only
kind is:

```json
{ "kind": "github.merge", "repository": "owner/name", "pull": 7,
  "headSha": "<the full 40-character head commit the document is about>",
  "method": "merge" | "squash" | "rebase", "id": "merge-7", "label": "…" }
```

Unknown kinds and unknown fields are refused, not ignored. When written, the
repository must be a GitHub repository of the artifact's project (a thread's
own project; OptChat names one). The page shows each action as a key with
its exact target. Pressing it checks, without changing anything:

```text
preview(artifact, action, revision)
  revision is the newest            # an older revision's actions never run
  project still has the repository
  no earlier run of it succeeded or runs
  github: open, not merged, not a draft
  github: head == the document's headSha
  github: mergeable (not "not computed yet")
```

The dialog shows the repository and project, the pull request's title and
author, the branches, the reviewed head beside the head now, GitHub's state
and the problems. The merge key is enabled only when there are none, and the
request must repeat the target (`confirm: "owner/name#n"`). The run checks
everything again, records itself once per request id (a second run of a
succeeded action is refused; a request id whose run failed answers that
failure, and the page's next press is a new attempt with a new id) and asks GitHub to merge with `sha` set to the
reviewed head, so GitHub itself refuses if the branch moved in between. The
outcome is kept on the artifact; a run cut off by a cubed restart is marked
failed with a note that whether GitHub merged it is unknown.

The outcome is told, in the same transaction that records it, as one notice
per recipient:

```text
artifact by OptChat   -> OptChat
artifact by a thread  -> the thread (its next prompt)
                      -> OptChat, if OptChat started that thread (checked when it goes;
                         otherwise "skipped"); the thread's answer reaches OptChat as its report
```

A notice is delivered exactly like a comment batch (above): the same text
under `artifact:<id>:action:<run>:<recipient>` on every try, accepted once;
waiting with its reason while the chat is not open or the thread works;
`undeliverable` for an archived or unknown thread. One still waiting after
24 h stops and says why. A failed or cut-off run is told as not done ("Nothing
says it merged"), never as success. The page shows each notice under the run
(`told optchat`, `to the thread: waiting: …`), and `artifact_read` lists them.

The merge uses the host's GitHub token (`gh auth token` or
`CUBED_GITHUB_TOKEN`) from cubed, the authority threads already use through the
gateway. Agents cannot run an action: their tools only declare one.

## Routes

`GET /api/artifacts`, `GET /api/artifacts/<id>` (summary, revisions without
bodies, comments, action runs), `GET /api/artifacts/<id>/revisions/<n>`,
`POST /api/artifacts/<id>/comments {revision, anchor, body, requestId}`,
`DELETE /api/artifacts/<id>/comments/<comment>` (drafts only),
`POST /api/artifacts/<id>/send {requestId}`,
`GET /api/artifacts/<id>/actions/<action>?revision=<n>` (the preview) and
`POST /api/artifacts/<id>/actions/<action> {revision, confirm, requestId}`.
They are as private as cubed is. Pages: `#/artifacts`, `#/a/<id>[?rev=<n>]`;
the chat panel lists the newest five.

The store is `CUBED_STATE/artifacts.sqlite` (WAL, `synchronous=FULL`), product
data beside the registry: Pi's stores keep no copy and no workflow is
journaled there.

## Verified

- `packages/server/test/artifacts-test.ts`: the store (idempotent writes,
  unchanged writes, bounds, anchors, batches, persistence), hostile action
  declarations, and through cubed's routes OptChat, a Pi thread (local guest)
  and a Claude Code thread (the fake `claude` running the mod's tools over the
  socket) writing artifacts; authors kept apart; a workspace path outside the
  workspace and an action on another project's repository refused; comments
  waiting while a thread works and delivered once after; comments to the
  chat; preview, a moved head, a wrong confirmation, an older revision, the
  merge once and a second refused, a failed try not reported as done and a
  new try merging (a fake GitHub); the outcome told to the chat (the failure
  as a failure, the merge as done, once each) and, for a thread the chat
  spawned, to the thread once and to the chat, also once that thread is
  archived; everything across a restart; an archived thread's comments
  undeliverable.
- `packages/server/test/artifact-notices-test.ts`: the service over a real
  store with fakes: notices written with the outcome, waiting while the chat
  is closed or the thread works, once each across concurrent pumps and a
  restart, skipped for a thread the chat did not start, undeliverable when
  archived, a run cut off mid-merge told as unknown after a restart, and the
  24 h bound.
- `packages/web/test/artifact-render-test.ts`: hostile Markdown, links,
  images, diagram sources, diff lines, fence languages; anchors exact, moved,
  outdated and ambiguous.
- `packages/web/test/browser/artifact-browser-test.ts` in headless Chromium at
  1440×900 (light and dark) and 390×844: the review linked from the chat,
  diagrams drawn, hostile content inert (no script, no dialog, no fetch, no
  `javascript:` link), two selection comments sent to the chat, a comment to a
  working thread waiting and then reaching it once, a comment being written
  keeping its revision while the thread writes a newer one, an older
  revision, the merge refused for a moved head, failing once at GitHub and
  then confirmed once, the chat told of the failure and of the merge once each
  and the page saying `told optchat`, no sideways scroll on the phone. `CUBE_SCREENSHOTS=<dir>` keeps the screenshots.

Not verified: a real model writing artifacts, a real Claude Code session
using `/cube/artifacts` (the mod's functions run offline under the fake
`claude`), a merge against GitHub itself (its API is faked; the request shape
follows GitHub's REST documentation), and comment placement on very large or
heavily rewritten documents.

## Known limits

- One action kind. Others (close an issue, re-run CI, archive a thread) need
  their own typed preview and checks.
- No per-user identity: anyone who can reach cubed can confirm an action.
- Comments are not threaded and the author's answer arrives in the chat or
  thread, not on the artifact.
- The page reads the artifact every 4 s while visible; there is no stream.
