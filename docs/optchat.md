# OptChat

OptChat is the user's one endless chat with cube, at `#/chat` (the UI's home).
It is an interface, not a worker: it has no machine and no code, file or shell
tools. It starts threads in projects (`spawn`), gives a thread that has reported
more to do (`tell`), lists its threads (`threads`) and what it can start
(`projects`), reports the runners as cubed last heard from them (`runners`,
read-only; see docs/runner-operations.md, "Observing runners"), reads one of
its threads (`history`), archives its threads that are done to free their
machines (`archive`), reads usage and estimated cost (`usage`: everything,
a project or a thread; read-only, see [usage.md](usage.md)) and reads its own
memory (`zoom`, `date`). Threads do all the
work, each in its own VM, exactly like a thread started from the UI.

The memory follows Victor Taelin's OptChat spec
(<https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449>): the
log keeps every message word for word, a binary tree of one-line summaries is
built over it, and every turn starts a fresh model context made of the system
prompt, the view (the whole chat as about 500 lines, the older the coarser) and
the new message. Nothing is ever compacted away; the agent zooms into a line to
get its detail back.

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
| view at load | `cube.optchat.view`, written with every node: the view over the first `total` messages. A reopen restores it and appends the rest, so it goes on from the view it had |
| compactor usage | `cube.optchat.usage`: the compactor's calls run beside Pi, so its `pi.usage` misses them; each reply's usage (failed ones too) is added there in its own commit, by `provider/model` with a call count |
| subagent reports | when a spawned thread's run settles, how it ended and its last reply go to the chat as `[<first 8 of the thread id>] <report>` (see "Follow-up and unattended work"), with request id `report:<thread>:<run>`, so a report is delivered once across restarts. The transcript marks it with `from` (the short id) and shows it as the thread's, not the user's |

`packages/server/src/optchat-memory.ts` is the pure part: the fold that appends
and merges the most due pair (never splits), the build order (one message at a
time, merges beside it, the compactor never sees a placeholder), free nodes,
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

## Caching

`optchat-cache.ts` applies spec §8 through pi-ai's published request hooks,
without changing Pi:

- **Pieces.** The view (and the compactor's `<chat>` context, which is a
  prefix of it) is sent as text blocks cut at the last line end before 50,000,
  80,000 and 100,000 characters. The view leads the turn's first user message.
  The hook puts the system baseline first; Pi writes it after that message.
- **Anthropic.** An `onPayload` hook marks every piece but the last and drops
  pi-ai's system and tool marks, which the first piece covers. pi-ai keeps its
  mark on the request's last user block. That gives three view marks plus the
  end mark, Anthropic's maximum of four. A view under 50,000 characters keeps
  pi-ai's own marks.
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
sent. Hit rates against a live provider are not measured.

## Configuration

- The chat's model is chosen on the chat strip (`GET/PATCH /api/optchat/model`);
  a new chat starts on the host's preferred model.
- `CUBED_OPTCHAT_COMPACTOR=provider/model` selects the compactor's model
  (default: the chat's own). The spec recommends a cheap but competent model.
- `<CUBED_STATE>/optchat/AGENTS.md`, if present, is the user's instructions,
  appended to the system prompt. It is read on every request; keep it stable
  for the cache.
- A spawned thread runs on the host's preferred model unless the task names
  one; `claude · max` models start Claude Code threads.

Routes: `GET /api/optchat/history`, `GET /api/optchat/stream` (the thread event
model), `POST /api/optchat/prompt {text, requestId}`, `POST /api/optchat/stop`,
`GET /api/optchat/view` (what the model reads: the view and the message count).

## Deviations from the spec

- **No cache breakpoints on OpenAI.** The spec puts `prompt_cache_breakpoint`
  marks on the view's pieces. pi-ai's Codex request has no such field, so the
  chat relies on OpenAI's prefix caching and a stable `prompt_cache_key`.
- **Steering window.** A message sent during a tool round is steered in. If
  the round's last tool finishes between the check and the submission, Pi
  places it at the final boundary and it continues that run in the old
  context. The window is the gap between two commits; it is not closed.
- **Threads are cube threads.** A thread gets OptChat's task and a note that its
  final reply is the report; it does not get the view, `zoom` or `date`. Each
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
- Verified offline with faux models and a local guest only
  (`packages/server/test/optchat-*-test.ts`), never against a real model or VM.
