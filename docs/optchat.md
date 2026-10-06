# OptChat

OptChat is the user's one endless chat with cube, at `#/chat` (the UI's home).
It is an interface, not a worker: it has no machine and no code, file or shell
tools. It starts threads in projects (`spawn`), gives a thread that has reported
more to do (`tell`), lists its threads (`threads`) and what it can start
(`projects`), reports the runners as cubed last heard from them (`runners`,
read-only; see docs/runner-operations.md, "Observing runners"), reads one of
its threads (`history`), reads usage and estimated cost (`usage`: everything,
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
| subagent reports | when a spawned thread's run settles, its last reply goes to the chat as `[<first 8 of the thread id>] <report>`, with request id `report:<thread>:<run>`, so a report is delivered once across restarts. The transcript marks it with `from` (the short id) and shows it as the thread's, not the user's |

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

## Reading a thread

`history(id, before?, limit?)` reads one thread the chat started; any other id
is refused as unknown, like `tell`'s. It changes nothing in the thread: it does not open the
thread's agent, take its workspace lease or wait for its machine
(`Conversations.storedHistory`). A Pi thread's `pi.sqlite` is copied through a
read-only connection (`VACUUM INTO`, a WAL read that never waits for the
running Harness) into a private directory beside it, which pi-durable opens and
which is deleted after the read (`readStorage`); the store itself is never
created, migrated or locked for writing, and one of another schema version is
refused, as is one over 64 MiB, since the copy is synchronous. A Claude Code thread's `claude.sqlite` is read through a read-only
connection, without a size bound. A read-only connection to a store closed
cleanly can recreate its empty `-wal` and `-shm` files; nothing is written to
them. So archived threads, whose stores stay in
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
- `history` copies and reads a thread's whole Pi store on each call and pages
  afterwards; the copy is synchronous and holds cubed's event loop for its
  length (stores over 64 MiB are refused). A copy a crash left behind
  (`.read-*` in the thread directory) is not removed.
- No HTML browser of the tree and no import of older chats yet.
- Verified offline with faux models and a local guest only
  (`packages/server/test/optchat-*-test.ts`), never against a real model or VM.
