# OptChat

OptChat is the user's one endless chat with cube, at `#/chat` (the UI's home).
It is an interface, not a worker: it has no machine and no code, file or shell
tools. It starts threads in projects (`spawn`), gives a thread that has reported
more to do (`tell`), lists its threads (`threads`) and what it can start
(`projects`), reports the runners as cubed last heard from them (`runners`,
read-only; see docs/runner-operations.md, "Observing runners"), reads one of
its threads (`history`), diagnoses the machine of one that does not start
(`diagnose`: read only; see docs/runner-operations.md, "Diagnosing a machine
that does not start"), archives its threads that are done to free their
machines (`archive`), reads usage and estimated cost (`usage`: everything,
a project or a thread; read-only, see [usage.md](usage.md)), reads and
saves a project's external hooks in cube's projects (`project_hooks`,
`project_hooks_write`, the project named explicitly; see
[project-hooks.md](project-hooks.md)), writes work
artifacts and reads its own and its threads' (`artifact_write`,
`artifact_read`; see [artifacts.md](artifacts.md)) and reads its own
memory (`zoom`, `date`). It keeps no task list: the chat page shows its
threads, derived from its own spawns (see "Threads beside the chat"), and
no model reads the chat in the background for wishes or todos. Threads do
all the work, each in its own VM, exactly like a thread started from the UI.

The memory follows Victor Taelin's OptChat spec
(<https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449>): the
log keeps every message word for word, a binary tree of one-line summaries is
built over it, and every turn starts a fresh model context made of the system
prompt, the view (the whole chat as 64-128 KB of lines, the older the coarser)
and the new message. Nothing is ever compacted away; the agent zooms into a line
to get its detail back. This follows the spec as of gist revision `3c190e06`
(2026-10-08), which corrected two points of the first version: a pair of lines
is due to merge by how long ago its **last** message was in its own line size,
`(T - last) / 2^l`, and the view merges in **batches**. Each message appends its
line and nothing else changes; once the view passes 128,000 bytes (its rendered
`id+n|text` lines with their newlines), one batch merges the most due pairs,
oldest first among equals, until it is at most 64,000 bytes. So turns between
batches read the last turn's whole view from the prompt cache. A batch merges
only pairs whose parent is built; one that cannot reach 64,000 bytes yet goes
on at each later message or node.

A compaction reads its own view (spec §4): the chat's view merged further, in
the same sawtooth from 32,000 down to 16,000 bytes. It gets each new message's
line as the view does, merges in a batch once it passes 32,000 bytes, and
starts again from the chat's view, merged down to 16,000, whenever that view
merges, so each of its lines is a run of whole view lines. Its size is what
the compactor reads: the built lines' bare text (no ids) with their newlines;
an unbuilt line counts nothing. A compaction's `<chat>` holds the lines before
its message, or up to a merge's last message, and stops at the first unbuilt
line. So compactions read each other's view from the cache, at most 32 KB
instead of the chat's 64-128 KB. A message's node starts once fewer than 8
lines before it are unbuilt, so a turn's messages are compressed side by side;
a merge starts once both its halves are built.

## Where things live

Everything is in one pi-durable SQLite store, `<CUBED_STATE>/optchat/pi.sqlite`,
with Pi as its only writer. cubed's live-instance socket lock (one cubed per
`CUBED_STATE`) keeps it that way.

| spec | cube |
| --- | --- |
| log (`main/*.jsonl`) | the root conversation's own Pi entries; `pi.user` → user, assistant text → talk, tool calls → tool, `pi.tool-result` → echo (capped at 30,000 characters, head and tail; a zoom result, a copy of the chat itself, is logged as a short pointer so its ids and `user:` tags never reach the compactor). Thinking is never logged, nor a failed model attempt (Pi retries it); an aborted reply logs its text but not its unexecuted tool calls. |
| tree (`tree/*.jsonl`) | `optchat.node` entries `{l, i, text}` in a second, ownerless, model-free conversation |
| fresh call per turn | an `optchat.turn` entry with `head: "self"` before the user's message; Pi starts the model context there and keeps every older entry |
| view in block 1 | the turn's view parts are stored in the `cube.optchat.turn` doc; a `beforeRequest` hook renders them as the first text block of the turn's first user message, the same bytes on every request and recovery |
| the input queue | `cube.optchat.pending`: a message or report is accepted there at once and kept until Pi has placed it; all waiting messages become one turn, each still its own user message and its own Pi submission |
| view at load | `cube.optchat.view`, written with every node: the view over the first `total` messages and `batch`, whether a batch is still merging toward 64,000 bytes. A reopen restores both and appends the rest, so it goes on from the view it had. A view stored before batching has no `batch` and was never mid-batch; it restores as it was, and the first batch comes once it passes 128,000 bytes as now measured (ids included, so possibly at the reopen). `compaction` and `compactionBatch` are the compaction view and its batch, restored the same way if it still tiles the log and coarsens the view; a view stored before it lacks them, and the compaction view is merged down from the view at the reopen. A message's own line may be stored unbuilt (the view is written after every node) and restores as such; a merged line must be built |
| compactor usage | `cube.optchat.usage`: the compactor's calls run beside Pi, so its `pi.usage` misses them; each reply's usage (failed ones too) is added there in its own commit, by `provider/model` with a call count |
| subagent reports | when a spawned thread's run settles, how it ended and its last reply go to the chat as `[<first 8 of the thread id>] <report>` (see "Follow-up and unattended work"), with request id `report:<thread>:<run>`, so a report is delivered once across restarts. The transcript marks it with `from` (the short id) and shows it as the thread's, not the user's |

`packages/server/src/optchat-memory.ts` is the pure part: the fold that appends
and, in batches, merges the most due pairs (never splits), the compaction view, the build order (a message once fewer than 8 lines before
it are unbuilt, a merge once both halves are built, the compactor never sees a
placeholder), free nodes,
rendering and zoom. `optchat-compactor.ts` holds the `COMPACT` prompt, the
512-byte `SCALE` line (an invented example in the system prompt) and the
lengths: each answer brings three versions of about 26, 48 and 69 words and
the longest that fits is kept; if none fits, the cut-at-limit feedback asks
again (five answers; then the shortest line is kept). Measured on 30 live
nodes with gpt-6-luna, this took 1.03 calls per node instead of 2.67, with
64% less input and 16% less output. `optchat.ts` is the service: Pi setup, the tools, the turn
loop (a turn waits until every line of the view is a summary), the compactor
pump (eight jobs, a failed node is retried every 10 s, forever) and the thread
watchers. `optchat-threads.ts` connects it to cube's registry and threads.

A message reaches the model in one of three ways. While a tool round runs, it
is a Pi steering input, delivered between tool calls (`steeringMode: "all"`, so
every message steered into a round is placed at its boundary). While the model
generates, it waits for the run to end, so a turn never continues into
another. When the chat is idle, the delivery loop waits until every line of the
view is a summary and takes everything waiting. It then records the turn's view
parts and writes the head entry (request id `<first>:turn`). Every message
but the last is written as a user entry, and the last is the input that starts
the run. Each step is its own Pi submission under the message's request id, so
a restart goes on where it stopped and a resend is refused. Steering, a turn's
submission and stop never run at the same time. The transcript shows waiting
messages as `working` with the compactor's failure, if any, and
`POST /api/optchat/prompt` answers as soon as the message is accepted.

## Follow-up and unattended work

A report tells the chat how a thread's turn ended and what of the thread
still runs. It never says the task is done: an ended turn is not a finished
task, and only the thread's reply says what is left. The forms:

| report | meaning | what comes next |
| --- | --- | --- |
| `ended its turn, waiting on its background agent "…"; another report comes when it finishes: <reply>` | a Claude Code thread ended its turn with a background agent (the Agent tool's default) still running; cubed tracks it | Claude Code takes a turn of its own when it finishes; that turn is a new run (`cube:background:<task>`) and reports again. If the agent finishes before the watcher saw the first run settle, only the new run reports |
| `ended its turn; nothing of it runs now: <reply>` | nothing of the thread runs or is tracked | nothing, until someone tells it |
| `ended its turn; nothing of it runs now and nothing wakes it, though its reply speaks of waiting: it goes on only when told: <reply>` | as above, but the reply mentions waiting (for CI, a review, a command): cube tracks none of those | nothing; it needs a tell to go on |
| `failed: <why>; last reply: …` | the turn failed (provider error, Claude Code exited, cubed restarted mid-turn, its machine failed) or background work was lost | nothing; it needs a tell |
| `stopped[: <why>]; last reply: …` | stopped in cube (a turn, or background agents between turns) | nothing |

The last kind of wait cube cannot see: CI, a reviewer or a command started
outside the thread. Two things keep such work going overnight:

- **Threads are told not to end a turn to wait.** OptChat's task note
  says nothing wakes a thread after its final reply except its own
  background agent finishing, so it waits for CI, reviews or commands in
  the foreground (a command runs at most 10 minutes; it repeats a bounded
  wait such as `timeout 590 gh pr checks <n> --watch`), and says plainly
  what is left when it stops early.
- **OptChat follows up.** Every report starts a chat turn. The system
  prompt tells it what each form means and to tell a thread that stopped
  short to go on when the next step is clear and within what the user
  asked, or else to tell the user what the thread needs.

Bounds, so unattended work does not loop or spend without end:

- `tell` sends at most `TELLS` (8) messages per thread between two messages
  of the user (reports do not count as the user's); then it answers `not
  sent: … tell the user what it needs instead`, and the prompt forbids
  starting another thread to get around that. Only a tell the thread
  accepted counts, and a replayed call counts once.
- Background agents get at most 4 hours from the start of the oldest still
  running (`ClaudeRuntime.backgroundMs`). Then cubed ends Claude Code
  between turns, which ends all of them, and records them as one lost run.
  A running turn is never cut off; the limit is checked again after it.
- Only an agent's task (`task_type` `local_agent`, or an Agent tool call's)
  is waited for; other backgrounded kinds may never notify.
- A finished background agent whose follow-up turn does not start within
  2 minutes fails that run (`claude code was to go on by itself …, but did
  not — send a message to go on`) rather than leaving it working.
- Nothing is auto-resumed by cube besides the turn Claude Code takes for
  its own background agent. A thread interrupted by a cubed restart, a
  provider error or a failed machine reports `failed`, once, and waits for
  a tell.

Restarts and failures:

- **cubed stops or restarts** while a Claude Code turn runs: the turn is
  recorded as failed when the agent opens again (`cubed stopped during this
  turn; …`) and reported once (`report:<thread>:<run>`). Background agents
  end with the Claude Code process: a clean stop records them as a lost run
  at close, a crash at the next open (`cube:background:<task>:lost`). Only
  the newest run of a thread is observed, so when several settle while
  cubed is down (an interrupted turn, then its lost agents) the chat gets
  the newest one's report, once. A Pi run goes on after the restart on its
  own.
- **Duplicate events**: every report has the request id
  `report:<thread>:<run>` and every run its own request id, so a watch
  reconnect, a restart or an archive sends a report once.
- **A thread whose machine is unavailable** reports a failure to start
  once, after the start grace (cubed keeps retrying); see "Archiving".
- **Archive and model change** refuse a thread waiting on background agents
  (archiving would end them): `not archived: it is waiting on its background
  agents; nothing was stopped`. The user's stop in the UI ends them, as a
  stopped run, and the thread can then be archived.

`history` shows the wait (`run: completed (…); still running: background
agent "…"`) and, when the agent is not open in cubed, notes that the agent
ended with it. `threads` shows `completed, waiting on background agent "…"`.
The thread page shows `waiting on a background agent: …` with its stop key.

Limits: cube tracks only Claude Code's own background agents. Pi threads
have none. CI, reviews by other threads or people, and commands outside
the thread are not tracked; a thread must wait for them itself, or OptChat
must tell it to look again. Claude Code's follow-up turn is a Claude Code
behavior cube relies on (headless `-p` stream-json input takes a turn for a
background agent's notification); it is checked against the installed
Claude Code's messages offline only, with a fake `claude`, and a missing
turn fails its run after the grace instead of waiting.

## The view a thread gets

The spec's subagent "is a fresh call whose first message is the view, then
its task" (gist revision `3c190e06`, §6; revision `f51fe5c9`, §9, took the
view "at spawn time (after settle)"). A thread OptChat starts gets that:

- **When.** `spawn` takes one view for all the threads of its call, before
  the first starts: once every line of the view is a summary (the spawning
  turn's own messages included, so the user's words that led to it are
  there), or after `THREAD_VIEW_MS` (30 s) the lines up to the first that is
  not a summary yet. A thread never sees a placeholder.
- **Frozen.** The view is stored with the thread's first message in the
  registry's creation record. Every open of the thread (a restart, a machine
  that comes back, a resume) sends those bytes under the same request id, so
  Pi and Claude Code accept it once; later turns of the chat, merges and new
  views change nothing a thread already has. A later `spawn` takes the view
  as it is then.
- **What it holds.** A block before the task:
  `<optchat-view>`, a fixed guide, the view's lines as `<chat>…</chat>`, then
  `(the lines cover messages 0 to N of the M in the chat; taken <ISO time>)`
  and `</optchat-view>`. The guide is fixed and the time comes after the
  lines, so threads started together share the prefix in the prompt cache.
  The spec keeps dates out of the view; the time is the snapshot's own. The
  guide says the view is context only, that the task decides what to do
  (OptChat may give a thread part of the work), that a line can be asked for
  by its `id+n` in the report, and that the view covers every project, so
  nothing of it, nor what it says of other projects, goes into this
  project's files, commits, pull requests, issues, comments or artifacts.
  Strings that look like secrets are redacted as `diagnose` redacts them
  (`vm-diagnostics.ts`).
- **What it leaves out.** Only the chat's own log is in a view: the user's
  words, OptChat's replies, tool calls and results, and threads' reports.
  Another thread's own steps and messages never are, nor images. A thread
  started from the UI gets no view. `spawn(…, view: false)` starts threads
  with their task only.
- **Shown apart.** The transcript adapters (Pi and Claude Code) take the
  block off the first message: the thread page shows the task with a note
  `with optchat's view of messages 0–N, taken …`, and `history` shows the
  same note instead of the lines, so a view never comes back into the chat.
- **zoom and date.** As the spec's subagents, a thread with a view opens
  its lines: a Pi thread with the host tools `zoom(id, n)` and `date(id)`, a
  Claude Code thread with Read `/cube/optchat/zoom/<id>+<n>` and
  `/cube/optchat/date/<id>` (the mod sends them to cubed's workspace socket,
  authorized by the thread's lease token, like `/cube/artifacts`). Both reach
  only the messages the view covers (`No line … in your view: it covers
  messages 0 to N.`), so the chat after the spawn stays out of reach; tree
  nodes never change once built, so the same zoom answers the same later.
  Only a thread this chat started has them, and the view's range is read
  from its stored first message. `zoom(id, 1)` gives a message whole, other
  projects' included, redacted as the view is. A thread's zoomed lines come
  back through `history` as a pointer, as OptChat's own zoom results are
  logged, so they never come back into the chat. `history` knows them by
  their call (Pi's `zoom`, Claude Code's Read of `/cube/optchat/zoom/…`); a
  result whose call is on an earlier page, by its lines, numbered or not
  (Claude Code prints a Read result with each line after its number and a
  tab). Other Read results show as they are.

`packages/server/test/optchat-thread-view-test.ts` runs it through real
cubed over local guests: one Pi and one Claude Code (the fake `claude`)
thread from one spawn (each zooms, dates and is refused past its view), a
later spawn, `view: false`, a UI thread in another project (no view, no
zoom), `history`, and a restart. `optchat-test.ts` covers the wait that
gives up and the lines it gives then, and zoom and date themselves: halves,
a whole message, redaction, the bound and a thread the chat did not start.

## Reading a thread

`history(id, before?, limit?)` reads one thread the chat started; any other id
is refused as unknown, like `tell`'s. It changes nothing in the thread: it does not open the
thread's agent, take its workspace lease or wait for its machine
(`Conversations.storedHistory`, `thread-history.ts`). Each store is read
through a read-only connection inside one read transaction: a consistent
snapshot with no copy, a WAL read that never waits for a write transaction
(it may wait briefly for a checkpoint or a recovery).
The store is never created, migrated, checkpointed or locked for writing; a Pi
store of another pi-durable schema version than the one the reader knows is
refused, and there is no size bound. A read-only connection to a store closed
cleanly can recreate its empty `-wal` and `-shm` files; nothing is written to
them. Pages are numbered from the first message, so cubed keeps, per store
(the last 32 read), an index of how many messages each stored row shows (and
a Claude Code store's tool names by call): the
first read of a store parses each row once to build it (pausing every 20 ms so
other threads go on), and later reads index only the rows written since. A
page then parses and renders only its own rows and the latest answer's. Rows
are only appended; an index that no longer matches (a Pi entry committed late
under a smaller id, a Claude Code message for an older turn, another file) is
built again, and a failed read drops it. So archived threads, whose stores stay in
`<CUBED_STATE>/threads/<id>`, and threads whose machine failed can be read too.

The answer starts with cubed's own record (archived or the machine's state,
the workspace, a retained disk, whether the agent is open in cubed, the
workspace's writer), then the stored run state and the latest answer, whether
the run's report (`report:<thread>:<run>`, or `report:<thread>:start` when
nothing is stored) is in the chat, waiting, or not sent, and a `note:` for each
disagreement it sees: a failure cubed records beside a run the store shows
(such as `thread workspace already has a writable owner` beside a finished
run), a run unfinished at archive, or a run unfinished with no agent open (a
Pi run goes on when its agent opens again; a Claude Code turn does not). It
shows both sides and settles nothing; it does not fix the activation race that
can produce such a failure. Then a page of messages, numbered from the first,
newest last: 12 by default, at most 40; `before: n` ends the page before
message #n, the number the page's `earlier:` line gives. Thinking and
unfinished output are left out; the messages shown share 24,000 characters (at
most 2,000 each, tool calls and results at most 400), the latest answer is cut
at 4,000. No store: `history: none stored`; a store that cannot be read:
`history: unreadable: <why>`. A stored run read without its agent is the
committed state: a Pi run still streaming shows as `working` without its
partial reply.

`diagnose(id)` gives the same evidence as `GET /api/threads/<id>/diagnostics`,
for a thread the chat started only (any other id is refused as unknown), as
text of about 12,000 characters at most: cubed's record and activation, the runner's
last report and its age, the gateway's link, one guest hello, the runner's
process, QMP, frames, disk and launch line, its newest events, cubed's machine
events and the last lines of the console and qemu logs. Every string is
escaped and redacted (`vm-diagnostics.ts`), so console output never reaches
the model or a terminal raw. It starts, stops and attaches nothing; evidence
it could not collect is named as unavailable, unsupported or none.

## Archiving a thread

An open thread holds one of its runner's machine slots until it is archived.
`archive(ids)` archives threads the chat started (up to 20 per call), so the
user does not have to archive finished ones by hand. Each id must be a thread
of this chat, named by at least its 8-character short id: another chat's,
the UI's or an unknown thread is refused as `no thread`, and a shorter prefix
is refused before anything is looked up.

It is the UI's archive (`DELETE /api/threads/<id>`, `Conversations.archive`),
not a second lifecycle: the agent closes, the machine's release check decides
whether its disk is retained, the machine is released and the slot is free
again. The tool answers one line per id (`archived` or `was already
archived`, with the disk's fate) and the free thread machines afterwards. The
thread's store in `<CUBED_STATE>/threads/<id>` stays, so `history` still reads
it, and usage stays readable too.

- **A working thread is refused**, nothing stopped: `not archived: it is
  working; nothing was stopped`. A Pi thread with a live run, or a Claude
  Code thread whose turn is running, counts as working. There is no force:
  OptChat has no way to stop a thread, and the user stops one in the UI.
- **A machine still starting or reattaching is refused** (`its machine is
  still starting or reattaching; try again shortly`) rather than waited for,
  which could hold the chat's turn for minutes. A machine that failed and is
  being retried by the recovery loop is archived after that attempt, its disk
  retained.
- **Threads that cannot run are archived.** A thread whose machine failed, or
  whose agent cannot open on a ready machine (Claude Code not installed on the
  host, a store cubed refuses), runs nothing; it is archived with its disk
  retained and that reason. Archiving a thread whose release failed or was
  cut short releases it again and keeps the first decision about its disk.
- **Repeats and races.** Archives of one thread run one after another in
  `Conversations` (the same per-thread queue as messages and releases), and
  the second finds the thread archived and changes nothing: not the slots and
  not the retained disk's record. A tool call replayed after a restart says
  `was already archived`. A message to the thread queued before the archive
  either starts a run first (and the archive is refused) or finds the thread
  gone.
- **Its report is kept.** Archiving ends the thread's watch. If the watcher
  had not sent the last settled run's report yet, the archive sends it, under
  the same `report:<thread>:<run>` request id, so it reaches the chat once.

Archived threads cannot be reopened, from OptChat or the UI; `discard` of a
retained disk stays an operator action in the UI. Nothing is deleted besides
what the release itself deletes (a clean machine's disk).

## Threads beside the chat

The chat is an archive, not the way to find what is going on. The chat
page's **threads** panel (beside the conversation on a desktop, folded above
it on a phone) shows every thread this chat started. Nobody keeps it:

- **Where it comes from.** The chat's own spawn records
  (`cube.optchat`'s `threads`, written by `spawn` in the call's commit). A
  thread started from the UI is not the chat's and is not shown; a thread
  the chat started needs no further step to appear.
- **What it shows.** Grouped by project, newest first: each open thread with
  its title and its own state as cubed records it when the panel reads
  `GET /api/optchat/threads` (`working`, `turn ended`, `waiting on a
  background agent`, `failed`, `stopped`, `starting`, `waiting for a
  runner`, `machine error`, …), and the 8 newest archived threads with how
  their last run ended (`archived · stopped`; read once per thread, since an
  archived thread runs no more). Older archived threads are
  counted, as are threads cubed no longer has. States are read like
  `history`: the stored run state, no agent opened, no lease taken, no
  machine waited for; one store slower than 2 s reads as `unknown`.
- **What it does not say.** A turn that ended is not work done; an archived
  thread is not a goal met; nothing reads a pull request, merge, release or
  install. The panel says so in its foot.
- **Refresh.** On open and when the page becomes visible, every 5 s while
  the chat works, once when a turn ends, and every 30 s while a shown thread
  is starting or running. An idle page with no running thread does no
  polling.

OptChat's own `threads` tool lists the same threads with their state.

## Images

The user can attach images to a chat message: paste them into the composer
(a screenshot or a copied image; a paste that carries text stays a text paste),
drop them on it (a dropped file that is no image is refused, never opened in
place of the chat), or pick them with its `image` key. Each one shows as a preview
with a remove key, uploads at once (the same image twice is kept once) and
goes with the next send; a failed upload
holds the send until it is removed, so nothing attached is dropped unseen. In
the transcript a message shows its images as bounded thumbnails; a press opens
the larger image in a dialog, with a link to the full size. They show again
after a reload, from the store; one that does not load shows as
`image unavailable · retry` in the dashed placeholder, which asks again.

- **Where they live.** `<CUBED_STATE>/optchat/media/<sha256>`, written once per
  content (whole, through a temporary file and a rename), mode 0600. A message
  holds only references: the Pi user entry's image parts carry
  `cube-media:<sha256>` as their data, and the pending document their ids.
  The log, the view, the compactor and `zoom` show an image as `[image]`; the
  transcript shows `images: [{id, mimeType}]` on the user message. No base64
  is stored in the Pi store or sent to the browser in a transcript.
- **What reaches the model.** The chat's `beforeRequest` hook reads the
  referenced images from the store and puts them in, as pi-ai image parts, for
  that request only. Every turn is a fresh context, so an image reaches the
  model in the turn whose messages carry it (a message sent with it, or one
  steered into that turn's tool round) and never again; the system prompt says
  so and asks OptChat to say what an image shows that will matter later.
  Threads never get the images; OptChat puts what a thread needs in its task,
  in words. A turn's requests carry at most 8 images and 15 MB of them, the
  newest; an image that cannot go becomes a note the model reads (`an earlier
  image of this turn, not sent`, `missing from cube's store`, `not sent:
  <model> does not take images`), never a silent gap.
- **Models without image input.** A model's own `input` (pi-ai's catalog)
  decides. When the chat's model takes no images, the composer's `image` key
  is off and says why, an upload is refused (422), a message with images is
  refused (422, `not sent: <model> does not take images; …`), and the model
  cannot be changed to such a model while a message with images waits. pi-ai's
  own replacement of images for such models is never relied on.
- **Formats and bounds.** PNG, JPEG, GIF and WebP only, recognized by their own
  headers, whatever the request's type says; SVG, HTML and everything else is
  refused (415), so nothing the browser would run is stored or served. At
  most 3.75 MB an image (its base64 stays under the 5 MB providers take) and
  8000 pixels a side; at most 4 images a message (a repeated one counts once)
  and 8 waiting for the chat at once. The composer checks the type and the size first and redraws a larger
  image at most 2048 pixels a side (PNG, or JPEG when that is still too
  large); the host checks again. An upload body over the limit is refused
  (413) before it is read whole.
- **Unsent uploads.** An upload no message holds is deleted after a day (at
  open, then hourly). At most 64 are kept: beyond that the oldest older than
  ten minutes are let go, and if none is, the upload is refused (429). Sends,
  sweeps and uploads take one lock, so a sweep never deletes an image between a
  send's check and the message that holds it. Images a message holds are kept
  as long as the chat, like the log.
- **Serving.** `GET /api/optchat/media/<sha256>` serves an image only when a
  message of the chat (in the log or waiting) holds it; any other id, a
  malformed one or a path is `404`. The response's type is the one its bytes
  were checked as, with `x-content-type-options: nosniff`,
  `content-security-policy: default-src 'none'; sandbox`,
  `cross-origin-resource-policy: same-origin` (another site cannot embed it)
  and a private immutable cache. Uploads go through cubed's host and origin
  checks and need an `image/*` body type, which a cross-site form cannot send.
  cubed has no user authentication of its own: the media routes are as private
  as cubed is (see SECURITY.md).

`packages/server/test/optchat-media-test.ts` covers the formats, the store,
the hook, turns with a faux model that takes images and one that does not
(an image in its own turn only, steered into a tool round, alone, several, a
resend, the bounds, a stop with images waiting), the sweep and the unsent
bound, a reopen and the routes (with a body over the limit and no length). The composer's paste rule and
checks are in `packages/web/test/images-test.ts`. In headless Chromium (desktop
1440×900 and phone 390×844) a real clipboard paste of a PNG attached it, a text
paste stayed text, the same image pasted again was kept once, a dropped image attached and a dropped text file was refused
without leaving the page, a second image was removed before send, the faux model got
the PNG, the thumbnail showed after a reload, the viewer opened and closed, the
layout kept one composer row without overflow, and a model without image input
turned the key off and explained a paste; in a fresh browser, an image the host
had lost showed as unavailable, opened nothing and asked again on a press. Not verified against a real
provider: what a real model makes of the images, and providers' own size and
count limits beyond the bounds above.

## Caching

`optchat-cache.ts` applies spec §3.3 through pi-ai's published request hooks,
without changing Pi:

- **Blocks.** The view (and the compactor's `<chat>` context, a prefix of
  the compaction view) is sent as text blocks of 4 lines; `<chat>` rides with
  the first and `</chat>` with the 0-3 lines left over. The view leads the
  turn's first user message. The hook puts the system baseline first; Pi
  writes it after that message.
- **Anthropic.** An `onPayload` hook keeps pi-ai's mark on the last system
  block only (it covers the tools and the OAuth Claude Code block), drops the
  tool marks and marks the last whole view block. pi-ai keeps its mark on the
  request's last user block: three marks. Anthropic looks back up to 20
  blocks from a mark for an earlier entry, so the next turn (up to 80 new
  lines) reads the view through this one and writes only the lines after it.
  A view under 4 lines keeps pi-ai's own marks.
- **Single flight.** A call whose marked prefix (model, tools, system, view
  through its mark) another call is writing waits in `onPayload` until that
  call's response starts or the call ends, or until its own abort; so
  compactions started together on one context pay for its write once. Calls
  with other prefixes do not wait.
- **OpenAI / Codex.** Every request carries `sessionId`, which becomes
  `prompt_cache_key` and the `session-id` header. The key is
  `optchat-<uuid>` for the chat and `optchat-<uuid>-compact` for the
  compactor, fixed for the store. Codex already sends `store: false` with the
  reasoning items' encrypted content. Requests share the view's prefix, so
  OpenAI's prefix cache serves them.
- **Retention** is `short` for the chat and the compactor, even when
  `PI_CACHE_RETENTION=long`.

`packages/server/test/optchat-cache-test.ts` runs pi-ai's real Anthropic and
Codex request builders against a captured `fetch` and checks what would be
sent, including the waiting. Hit rates are modelled offline (spec §3.3),
not measured on a live provider.

## Configuration

- The chat's model is chosen on the chat strip (`GET/PATCH /api/optchat/model`);
  a new chat starts on the host's preferred model.
- The compactor's model is chosen under settings › chat memory
  (`#/settings/memory`), apart from the chat's, and offered in the first-run
  setup. The default is "follow the chat model": it works with whatever
  provider the chat uses, so a new install needs no choice; the spec
  recommends a cheap but competent model where one is available.
  - The choice is kept in `<CUBED_STATE>/settings.json` (mode 0600, written
    whole and renamed). Only a model a connected provider offers can be
    saved. If none offers it later, the chat's model is used instead and the
    page says so; nothing is rewritten. If the models cannot be listed at
    all, the saved model is still used and the page says the list failed.
    An unreadable `settings.json` is reported on the page and the default
    applies until a save replaces it.
  - The compactor asks for its model before each node it writes, so a
    change applies to the next node without a restart; a node being written
    finishes with the model it started with.
  - `CUBED_OPTCHAT_COMPACTOR` is no longer read. An install that still sets
    it gets a warning in cubed's log and a notice on the page; the choice
    under settings decides. cubed never edits its environment or the
    host's service files.
- `<CUBED_STATE>/optchat/AGENTS.md`, if present, is the user's instructions,
  appended to the system prompt. It is read on every request; keep it stable
  for the cache.
- A spawned thread runs on the host's preferred model unless the task names
  one; `claude · max` models start Claude Code threads.

Routes: `GET /api/optchat/history`, `GET /api/optchat/stream` (the thread event
model), `POST /api/optchat/prompt {text, requestId, images?}` (`images`: ids of
uploads; with images `text` may be empty), `POST /api/optchat/media` (the raw
image bytes; answers `{image: {id, mimeType, width, height, bytes}}`),
`GET /api/optchat/media/<id>`, `POST /api/optchat/stop`,
`GET /api/optchat/view` (what the model reads: the view and the message count),
`GET /api/optchat/threads` (the threads the chat started, with their state).
The settings page reads `GET /api/settings` (the saved and effective
compactor model, an ignored `CUBED_OPTCHAT_COMPACTOR`, the chat's model,
the available models) and
saves with `PUT /api/settings/compactor {model: {provider, id} | null}`
(400 for a malformed body, 422 for a model no connected provider offers).
The panel also lists the newest
artifacts (`GET /api/artifacts`); comments on the chat's own artifacts reach
it as messages starting `[artifact <id>]` through the same pending queue, as
does the outcome of a merge the user confirmed on its artifact or on the
artifact of a thread it started.

## Deviations from the spec

- **No cache breakpoints on OpenAI.** The spec puts `prompt_cache_breakpoint`
  marks on the view's pieces. pi-ai's Codex request has no such field, so the
  chat relies on OpenAI's prefix caching and a stable `prompt_cache_key`.
- **Steering window.** A message sent during a tool round is steered in. If
  the round's last tool finishes between the check and the submission, Pi
  places it at the final boundary and it continues that run in the old
  context. The window is the gap between two commits; it is not closed.
- **Threads are cube threads.** A thread gets the view as it was when it
  started (see "The view a thread gets"), with `zoom` and `date` over it,
  OptChat's task and a note that its final reply is the report; it does not
  get later views, and OptChat has no `zoom("Name")` of a thread (`history`
  reads one). Each
  settled run of a thread reports on its own; reports are not grouped by spawn.
  Only a thread's latest run is observed: if two runs settle while cubed is
  down, only the second is reported. A thread whose machine fails to start
  reports that once.
  Each open thread holds one of its runner's machine slots (a runner hosts up
  to its `maxActiveVms`), so a spawn beyond the free slots reports "no free
  thread machine" for that task.
- **Stop** aborts a running turn and cancels the wait of every pending
  message. Those messages, and any steered one the abort withdrew before Pi
  placed it, are written to the log as unanswered user messages, as in the
  spec. While the compactor fails, the chat shows `summarizing: <error>` and
  keeps retrying.

## Known gaps

- The transcript endpoint reads the whole history again at every new turn,
  and the run status scans every submission on each SSE frame. A long chat
  makes the transcript slow; the model's side does not grow.
- The `threads` tool reads each thread's transcript to give its run state.
- `history`'s first read of a store after cubed starts (or after the store
  falls out of the last 32) parses every row once to number the messages; on
  a store of hundreds of MiB that takes a few hundred milliseconds, in slices.
  The index lives in memory only. Its read transaction is held for the
  build: the writer goes on, but its WAL is not truncated meanwhile, so an
  agent closing then (archive, shutdown) waits for its final checkpoint up to
  its 5-second busy timeout.
- `archive` handles its ids one after another, and each release waits for the
  runner, so a call with many ids holds the chat's turn until the last is
  released.
- `archive` reads the archived thread's store once more to find a report the
  watcher did not send (a one-message `history` page).
- No HTML browser of the tree and no import of older chats yet.
- An image reaches the model in its own turn only; a later turn cannot look at
  it again (the view and `zoom` say `[image]`), and threads never get images.
- Verified offline with faux models and a local guest only
  (`packages/server/test/optchat-*-test.ts`), never against a real model or VM.
