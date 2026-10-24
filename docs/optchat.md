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
artifacts and reads and revises its own and its threads' (`artifact_write`,
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
| log (`main/*.jsonl`) | the root conversation's own Pi entries; `pi.user` → user, assistant text → talk, tool calls → tool, `pi.tool-result` → echo (capped at 30,000 characters, head and tail; a zoom result, a copy of the chat itself, is logged as a short pointer so its ids and `user:` tags never reach the compactor). A user message (a report too) or a reply over 30,000 characters is never cut: it is logged as several messages in a row, pages split after a newline where there is one (spec §1). Only entries from `cube.optchat.log`'s `pagedFrom` on are paged: it is set at the first open that pages (0 for a new chat), so a chat logged before keeps its ids and its long messages whole; `zoom(id, 1, at)` reads such a message a page at a time. Thinking is never logged, nor a failed model attempt (Pi retries it); an aborted reply logs its text but not its unexecuted tool calls. |
| tree (`tree/*.jsonl`) | `optchat.node` entries `{l, i, text}` in a second, ownerless, model-free conversation |
| fresh call per turn | an `optchat.turn` entry with `head: "self"` before the user's message; Pi starts the model context there and keeps every older entry |
| view in block 1 | the turn's view parts are stored in the `cube.optchat.turn` doc; a `beforeRequest` hook renders them as the first text block of the turn's first user message, the same bytes on every request and recovery |
| the input queue | `cube.optchat.pending`: a message or report is accepted there at once and kept until Pi has placed it; all waiting messages become one turn, each still its own user message and its own Pi submission |
| view at load | `cube.optchat.view`, written with every node: the view over the first `total` messages and `batch`, whether a batch is still merging toward 64,000 bytes. A reopen restores both and appends the rest, so it goes on from the view it had. A view stored before batching has no `batch` and was never mid-batch; it restores as it was, and the first batch comes once it passes 128,000 bytes as now measured (ids included, so possibly at the reopen). `compaction` and `compactionBatch` are the compaction view and its batch, restored the same way if it still tiles the log and coarsens the view; a view stored before it lacks them, and the compaction view is merged down from the view at the reopen. A message's own line may be stored unbuilt (the view is written after every node) and restores as such; a merged line must be built. `entry`, `shape` and `shapeTotal` are the last Pi entry the view covers, a hash over how many messages each entry gave up to it and how many that was: a reopen whose log numbers its messages otherwise (a change to how entries are read) is refused with `the chat's log numbers its messages differently from its memory`, rather than putting every summary on the wrong message. A cubed before pages keeps these three while it grows `total`; when `total` differs from `shapeTotal`, such a cubed wrote the view since and numbered the log without pages, and the reopen is refused (`an older cubed numbered the chat's log without pages`) only if an entry logged in pages gives a different count without them. A view stored before `shape` is not checked; one stored before `shapeTotal` is checked against `total` |
| compactor usage | `cube.optchat.usage`: the compactor's calls run beside Pi, so its `pi.usage` misses them; each reply's usage (failed ones too) is added there in its own commit, by `provider/model` with a call count |
| compactor answers | `cube.optchat.spend`: for each node not built yet that the compactor answered, its answers left (of 15) and the `provider/model` that spent the last. An answer is taken from them, and marked `out`, in one commit before it is sent (a failed commit sends nothing); its reply's commit, with the usage, clears the mark and gives the answer back if the reply spent nothing; the record goes in the commit that stores the node. A restart reads it back, so it is no new budget |
| calls out at a stop | `cube.optchat.cut` and `cube.sends` (pi-sends.ts): the model calls that were out when cubed stopped (a close past its grace, a crash, a kill, a failed save), by `provider/model`, the compactor's in `cut` and the chat's in `cube.sends` (with those a close cut before it, in `cut`). Their cost is unknown: whatever usage came is counted as it came, and the usage report shows them as calls without a usage report. None is sent again on its own (below). `tools`: the tool calls still running at a close's cut, by name; what they did is unknown and not undone, and the usage report names them |
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
64% less input and 16% less output. Only an answer of exactly three lines,
or of one line (the spec's own task), counts, and none may end in a colon:
a heading before the versions or a version broken over two lines is never
kept as the node; the model is told and asked again within the five
answers. Each answer is capped at `outputTokens(node)` output tokens: pi-ai's
`medium` thinking budget (8192, the effort the compactor asks for) plus room
for three lines of the node's size at two bytes a token, at least 1024; 9216
for 512-byte nodes, where pi-ai would otherwise send the model's maximum
(128,000 on recent models) for three short lines. Adaptive thinking and
OpenAI's reasoning spend the cap as one; on a thinking budget (older Claude,
Bedrock) pi-ai adds 8192 on top. A ChatGPT sign-in (Codex, or `openai`
signed in) refuses the field, so pi-ai sends none there; there cube's own
guard (`optchat-output.ts`) counts the answer as it streams (text, thinking
summaries and tool call arguments, at two characters a token) and stops the
call at the same cap as a `length` stop, which is never used. What such a
provider thinks without streaming it is bounded by `reasoning: "medium"`
only. `max_tokens` is not part of the cached prefix.

The chat's own requests are capped too (O1): `CHAT_OUTPUT_TOKENS` (32,000)
for an answer, its tool calls and adaptive thinking together, where pi-ai
would send the model's maximum (128,000 on recent models); on a ChatGPT
sign-in by the same guard. No call is capped above its model's own maximum
(16,384 on `gpt-4o`, say). A turn whose answer reaches it ends there, as
Pi stores a `length` stop. A call the guard stopped has no usage from its
provider (Codex reports usage only at the end), so it is counted in
`cube.optchat.cut`'s `capped` and the usage report shows it as a call
without a usage report, not as zero. `optchat.ts` is the service: Pi setup, the tools, the turn
loop (a turn waits until every line of the view is a summary), the compactor
pump (eight jobs) and the thread watchers. `optchat-threads.ts` connects it
to cube's registry and threads.

A node the compactor fails on ends one of these ways:

| failure | examples | the node | the next turn |
| --- | --- | --- | --- |
| its input's doing: asked again, it fails alike | an empty answer; an input too long for the model (pi-ai's `isContextOverflow`); a refusal or safety stop, told by the provider's stop reason (`refusal`, `content_filter`, `SAFETY`, …) whatever its explanation says, so one that mentions "500" or "timeout" is not taken for an outage; an error stop on a reply the model began (its usage is not zero); five answers none of them in the form | its source cut short, after one call (five for the form): `(no summary, cut short: zoom it) ` and the start of the message, or of both halves of a merge, within 512 bytes; stored with `cut: <why>` and logged as a warning. The log keeps the message whole | runs |
| not its input's doing | an outage, a rate limit (pi-ai's `isRetryableAssistantError`), or an error no reply carried (a bad key, a quota, a model that is gone) | asked again every 10 s until it answers; never cut | waits, and the chat shows `summarizing: <error>`; a change of the compactor model applies to the next try |
| out of output: every answer stopped at the cap (`length`, thinking only or lines cut off), not an overflow | a model that thinks past 9216 tokens | an answer that ran out is never used; the model is told to think briefly and asked again within the five answers. If none gave lines, the node is asked again every 10 s; never cut | waits, and the chat shows `summarizing: the compactor ran out of output …` |
| its answers spent: 15 answers since the node's last release, whatever ended each round | answers that ran out, answers not in the form, or either followed by a rate limit or an outage | held: no timer and no call, never cut. A new message of the user (typed in the chat, or a batch of the user's comments on one of the chat's artifacts) gives it one more round of at most 5 answers; another compactor model (saved in settings, or the chat's model it follows) gives a new one, also at open. A step that comes while the node's last answer is still out counts the same once that answer is in. A thread's report, the notice of a merge the user confirmed (sent as a report), a repeated request, a restart or waiting gives none | waits, and the chat shows `summarizing: no summary for a message yet (<last error>); change the compactor model or send a message to try again` |

A `length` stop that is a context overflow is the input's doing like any
other: Bedrock's `model_context_window_exceeded` (pi-ai maps it to
`length`), or a `length` stop with no output and the window full (pi-ai's
`isContextOverflow`, as Xiaomi's), is cut after one call. A thinking-only
`length` stop, or an empty one far from the window, is not.

An answer is a reply that spent output: every reply the model gave, and an
error stop after it began writing (its usage or content shows it). An
outage or rate limit before any output costs nothing and is not counted, so
it is asked again every 10 s as before; once a node's answers are spent,
not even that is sent. So the compactor spends at most 15 capped answers on
a node, then at most 5 per message of the user or change of model, each
for at most the eight nodes being written at once: at most 40 answers per
message, about 370k output tokens at 9216 (nearly twice that on a thinking
budget, where the cap is 17408). On a ChatGPT sign-in (Codex, or `openai`
signed in) the same figure holds for what the model streams (cube's guard
stops it at the cap); reasoning it does not stream is bounded by its effort
only.
Nothing asks again on its own.

An answer is taken from the node's before it is sent, in a commit that
also marks it out; a failed commit sends nothing. So no crash or failed
save gives an answer back: one out at a stop is counted, its cost unknown,
and its node held (see "A paid call is never sent again on its own"). A
reply whose commit fails is not used: the round ends, and the answer stays
marked out until the node's next answer counts it. A grant (a message of
the user, another model) is stored best effort: a failed one holds the
node again after a restart, which only costs a message.

A close (cubed stops, updates or restarts) starts no new node, no turn, no
new request of a running turn, no tool call and no further answer of a
summary's round: the request and tool hooks and every tool's guard hold
each back, unstarted, until Pi closes (a replay at its execute phase too),
and the reopened run starts it, once. It then waits up to 10 s
(`CLOSE_GRACE_MS`) for what is already out: the nodes being built, a chat
request sent and not yet stored, and the tool calls executing or not yet
stored. Each that comes back is stored with its usage (a node with its
view, a tool with its result), so a reopen sends and runs none of them
again. A node whose answer came back but needs another (format feedback,
or more room after a `length` stop) is not asked again while closing: its
round so far (the messages of its next answer, the versions seen, the
answers that ran out of room) is stored with its answers left in
`cube.optchat.spend`, and the reopened chat asks that next answer under the
same model, once, exactly as the uninterrupted round would; a crash before
the hold restarts the round as before.

Only what is still out after the grace is cut off; each such call is
logged and counted (above): a model call is not sent again on its own
(below), a tool call is run again once. A tool cut off returns at once, so Pi's join is
not held by work that ignores the abort; that work may still go on and is
not undone (`spawn` stops at its next task and its git fetch stops on the
abort, so no thread starts after it; a `tell` or `archive` under way
finishes in cubed). So every tool is read-only or keyed (`TOOL_REPLAY`):

| tool | a second run |
| --- | --- |
| `zoom` `date` `projects` `runners` `threads` `history` `diagnose` `usage` `project_hooks` `artifact_read` | reads again |
| `spawn` | `optchat:<call>:<task>`: the registry's creation table finds the same thread |
| `tell` | `optchat:<call>`: Pi's submissions and Claude Code's table take it once; counted once against the tells |
| `archive` | the call's task: its stored lines (see "Archiving") |
| `project_hooks_write` | `<chat>:hooks:<task>`: saves nothing and answers the stored text (docs/project-hooks.md) |
| `artifact_write` | `<chat>:artifact:<task>`: finds the revision it wrote |

A tool missing from the table is refused when the chat builds its tools.
The close then gives the cut-off calls up to 2 s (`CLOSE_SETTLE_MS`) to
settle their usage, and Pi's own close (it aborts and joins every task) up
to 2 s (`CLOSE_JOIN_MS`); past that cubed's close goes on without it. So
the chat's close ends within 14 s whatever a tool or a provider does
(`optchat-close-test` measures it with a tool and a provider that never
end). That is OptChat's part only. cubed's whole close (`createCubed`'s
`close`) is bounded by one deadline, `CLOSE_MS` (25 s), under the
supervisor's SIGKILL 30 s after its SIGTERM (`cubed-supervisor.ts`,
`CUBED_UPDATE_STOP_TIMEOUT_MS`): each step (the HTTP server, the portal,
model sign-ins, OptChat, the threads, the gateway, egress, the workspace
socket) takes at most its cap and what is left, and the close goes on past
it and logs which step was late, so the stores (usage, artifacts, the
registry) are always closed. The threads (`Conversations.close`) get what
OptChat leaves, at most 9 s: they send no new request (held back, sent
once after the reopen), and a request or a context summary already out
gets up to 5 s to come back and be stored (Pi's own close aborts what is
still out), after the machines' close, which gets 1 s; a command
OptChat cut off (a `tell`, an `archive`) gets up to 2 s, and the agents'
own closes the rest. Past those bounds a request still out is counted at
the next open and not sent again, so its run stops and the user's next
message goes on; a guest command goes on and the next cubed reattaches to
it; a tell or an archive is keyed. `cubed-close-test.ts` closes a real
cubed whose chat close, machines close, thread agent and command all
hang: it ends in about 22.5 s with its stores closed, the threads having
had at most their 9 s and the drain its share. `cubed-drain-test.ts`
closes a real cubed while a thread's request is answered 1.5 s later: the
close waits for it, and after the reopen it is stored, sent once and not
counted.
`scripts/gate-close.ts` has the real supervisor SIGTERM a real cubed
process (`serve`'s own lifecycle, `serveUntilStopped`, a faux model and
local guests) with a guest command running, and with a request out at a
provider that never answers: cubed exits by itself (about 1 s and 9 s), the
request is not sent again and its run says why, and no command runs twice;
its `--control <main>` run is SIGKILLed at 30 s. `serve` reads the
supervisor's lifeline as a socket: a file read of that pipe held the
process until the SIGKILL after every close. The
service managers wait longer than the supervisor: the systemd user unit
(`scripts/cubed/service.sh`) sets `TimeoutStopSec=45`, the launchd agent
`ExitTimeOut` 45, and Homebrew's service `stop_timeout 60` (it runs cubed
without the supervisor, so cubed's 25 s is the bound there). None of these
service timeouts is measured here.

**A paid call is never sent again on its own** (`pi-sends.ts`). Provider
calls are not idempotent, and whether one that was out when cubed stopped
was billed or answered is unknown. So each is recorded before it leaves,
in a durable commit; a failed commit sends nothing:

| call | recorded before it is sent | at the next open, if it was out |
| --- | --- | --- |
| the chat's request | a memo on Pi's generation task (`cube.sent.<attempt>`, the epoch of the open that sent it), last in the request hook | counted once in `cube.sends` (epochs fence a stop during the open), and its generation aborted before Pi schedules anything: the turn ends unanswered and the chat shows `the chat's last request was out when cubed stopped, so it was not sent again …: send a message to go on` |
| a compactor answer | the node's answer taken and marked `out` in `cube.optchat.spend` | counted once in `cube.optchat.cut` and its node held, as one with its answers spent, saying `its summary was out when cubed stopped …`, until a message of the user or another compactor model asks it again |

A close past its grace counts what it cuts off in the same way, in one
commit, and the reopen holds those the same way; a crash, a kill and a
failed save have no grace and go the same way. A request held back
before its record (the close gate) was never sent, and is sent once after
the reopen, as before. A stop between the record and the send counts a
request that never left and drops it: the safe direction. Pi's own
retries of an answered error (its `attempt`, durable in its checkpoint)
and the compactor's answer budget (taken before each send) hold across
restarts. Not exactly-once: nothing is without provider idempotency.
Thread agents (`durable-agent.ts`) record their requests the same way: a
request out at a stop is counted in the thread's `cube.sends` (its usage
report partial) and its run stopped, never sent again; its next message
goes on. The same commit appends a data-only entry (`cube.send-dropped`,
which no request carries), so the stopped run says why to the thread's
readers (live, stored and its history) and in OptChat's report (`stopped:
cubed stopped while this run's model request was out, so it was not sent
again …: send a message to go on`), until the thread's next message. Pi's own context compaction of a thread sends its summary request
right after entering its `summarize` phase, with no hook to record it in:
a compaction found there at an open is counted (once per task and attempt)
and aborted, and Pi asks for no new summary on its own after it. Tools are not changed: every OptChat tool is read-only or keyed
(`TOOL_REPLAY`), a thread's file and bash tools are keyed workspace
operations, and Pi reports a call of a tool that is neither as
`interrupted` rather than running it again.

So a refusal costs one call and an outage no summary. A failure that is
the input's doing but reaches the compactor as a setup error (a 4xx no
reply carried) still holds the chat until the compactor model changes.

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
  says nothing wakes a thread after its final reply, so it waits for CI,
  reviews or commands in
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
  own, unless its model request was out at the stop: then it is stopped,
  not sent again (see "A paid call is never sent again on its own").
- **Duplicate events**: every report has the request id
  `report:<thread>:<run>` and every run its own request id, so a watch
  reconnect, a restart or an archive sends a report once. A report the
  chat could not take (its send failed) is read from the thread's store
  and sent again in a later round; a thread archived (in the UI, say)
  before a round saw its last run settle reports that run from its store.
- **A thread whose machine is unavailable** reports a failure to start
  once, after the start grace, saying whether cubed keeps retrying; see
  "Archiving". A sleeping machine whose wake fails reports each episode
  of failed tries in a row once (`report:<thread>:failure:<first try>`),
  also after a restart.
- **The chat's own observation starts nothing**: neither a thread's
  watcher, nor `threads`, nor `history` starts its machine, wakes a
  suspended one or opens its agent. With the agent open in cubed, the
  watcher watches the agent's own events. Without it (the machine is
  starting, suspended or being woken), each round (15 s) the watcher reads
  the stored run (a one-message `history` page) and reports it if it
  settled and was never reported (the request id keeps that to once; an
  idle thread is not taken for a reported one); once the agent is open,
  the next round watches it. Machines start for explicit work (`spawn`,
  `tell`, the user's message, an archive's check of the disk when its
  runner has a slot free, a portal connection) and in cubed's recovery
  loop, by its one rule (`recoveryStep`, docs/thread-lifecycle.md): it
  wakes a sleeping machine only for a stored Pi run that did not finish,
  and a wake no one in this cubed owns (one a restart cut short) is read
  back from the runner as suspended or running, never continued. Reading a thread in the UI opens its agent
  but does not start or wake its machine. `threads` lists a sleeping
  thread as "its machine is suspended" or "being woken", with its stored
  run state; one whose last wake failed as "waking it failed: …" (the
  overview: `machine error`), also after a restart, and the watcher
  reports that failure once per episode.
  These reads (`readThreads` in optchat-threads.ts) get only a
  `ThreadReader` (conversation.ts): cubed's own state, an agent already
  open and the thread's store. They have no way to start or wake a
  machine, open an agent or wait for a start.
- **Archive and model change** refuse a thread waiting on background agents
  (archiving would end them): `not archived: it is waiting on its background
  agents; nothing was stopped`. The user's stop in the UI ends them, as a
  stopped run, and the thread can then be archived.

`history` shows the wait (`run: completed (…); still running: background
agent "…"`) and, when the agent is not open in cubed, notes that the agent
ended with it. `threads` shows `completed, waiting on background agent "…"`.
The thread page shows `waiting on a background agent: …` with its stop key.

Limits: cube tracks only Claude Code's own background agents, and a
thread starts none now: Claude Code threads have no subagents (see
ARCHITECTURE.md, "Claude Code threads"). The tracking stays for sessions
that started one before, so their records and results still report. Pi
threads have none. CI, reviews by other threads or people, and commands outside
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
store of a pi-durable schema version the reader does not know (it knows 1
and 2: entries are the same in both, and an archived thread's store stays
at 1) is refused, and there is no size bound. A read-only connection to a store closed
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
last report and its age, what the runner last reported of the guest, berth
vm's machine diagnosis (the machine, QEMU, QMP, guest, egress, Iroh paths,
its newest events), cubed's machine events and the last lines of the console
and qemu logs. Every string is
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
  not the retained disk's record. A tool call replayed after a close or a
  restart answers as its first run did: each thread's line is kept under
  the call's task in `cube.optchat` (`archives`, the newest 64 calls), and a
  thread it had sent to archive and finds archived reads `archived`. A message to the thread queued before the archive
  either starts a run first (and the archive is refused) or finds the thread
  gone.
- **Its report is kept.** Archiving ends the thread's watch. If the watcher
  had not sent the last settled run's report yet, the archive sends it, under
  the same `report:<thread>:<run>` request id, so it reaches the chat once.

Archived threads cannot be reopened, from OptChat or the UI; `discard` of a
retained disk stays an operator action in the UI. Nothing is deleted besides
what the release itself deletes (a clean machine's disk).

## Threads beside the chat

The chat is an archive, not the way to find what is going on. Its page
shows every thread this chat started twice over, each from the chat's own
records: in the **margin**, a note beside the message whose spawn started
it (on a phone and below 76rem, a line under that message), and in the
**index** (the composer's work key, the wordmark, `/` or ctrl/⌘ k), the
open ones listed failed first, then moving, then the rest. Nobody keeps
either:

- **Where it comes from.** The chat's own spawn records
  (`cube.optchat`'s `threads`, written by `spawn` in the call's commit). A
  thread started from the UI is not the chat's and is not shown; a thread
  the chat started needs no further step to appear.
- **Where a note stands.** At the row whose spawn result names the thread
  (`[id] started in <project>…`), among the rows shown; an artifact's note at
  the first row that wrote it (`artifact_write`), linked it
  (`#/a/<id>`) or brought its comments (`[artifact <id>]`). A link to an
  artifact cube cannot show gets no note, and an artifact the chat never
  named gets none (the index lists it). A thread the overview no longer has
  is read from the thread list (archived). Until cube has answered a note
  says `reading state…`, and `state not read` when the overview could not be
  read; `not known to cube` only once the overview and the thread list were
  both read, the thread is in neither and the overview counts threads cubed
  no longer has.
- **What it shows.** Each open thread with
  its title and its own state as cubed records it when the page reads
  `GET /api/optchat/threads` (`working`, `turn ended`, `waiting on a
  background agent`, `failed`, `stopped`, `starting`, `waiting for a
  runner`, `machine error`, …). Archived threads are not listed, only
  counted (`3 archived not shown`), as are threads cubed no longer has; a
  thread archived while the page is open leaves the list on the next read.
  Archiving keeps what it kept before, and OptChat's `threads` and `history`
  tools still read archived threads. States are read like
  `history`: the stored run state, no agent opened, no lease taken, no
  machine waited for; one store slower than 2 s reads as `unknown`.
- **What it does not say.** A turn that ended is not work done; an archived
  thread is not a goal met; nothing reads a pull request, merge, release or
  install. Only a failure is pinned (at the margin's top, while its note is
  scrolled away); nothing is called "needs you".
- **Refresh.** On open, when the page becomes visible and when the index
  opens; every 5 s while the chat works, once when a turn ends, every 10 s
  while a thread moves and every 30 s otherwise (with the artifacts). A
  hidden page does no polling.

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
  newest; a message steered in during a tool round that would take the turn
  past that waits for the next turn instead (see Known gaps). An image that
  cannot go becomes a note the model reads (`an earlier
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
  writes it when the run starts, after that message, or after every message
  of a batch (several messages that waited for one turn). A later system
  message, after the model's first step, is an update and stays where Pi
  wrote it.
- **Anthropic.** An `onPayload` hook keeps pi-ai's mark on the last system
  block only (it covers the tools and the OAuth Claude Code block), drops the
  tool marks and marks the last whole view block. pi-ai keeps its mark on the
  request's last user block: three marks. Anthropic looks back up to 20
  blocks from a mark for an earlier entry, so the next turn (up to 80 new
  lines) reads the view through this one and writes only the lines after it.
  A compactor request keeps no mark after the view, as in uniichat: its task
  is its own and read again only by its own retry, so it goes uncached
  instead of being written at the write price. A view under 4 lines keeps
  pi-ai's own marks (a compactor's request but its end's).
- **Single flight.** A call's prefix is keyed after what precedes the view
  (model, tools and system, or Codex's instructions) and at each view
  block's end through its last whole one; marks are not part of a key. A
  call writes its last key, and the first too while that is not cached
  (Anthropic writes an entry at the system mark), so a call of a view under
  one block waits for it as well. A call whose prefix, or a start of it,
  another call is writing waits in `onPayload`
  until that call's response begins on its prompt, or the call ends, or its
  own abort; then it writes only the rest. Begins means `message_start` on
  Anthropic and the first `response.output_item.added` on the Responses
  APIs (uniichat's `begun`): not the headers, not `response.created` (sent
  when the request is accepted, before the prompt is read) and not an
  `error` event, after which nothing counts as written. A prefix whose writer began counts as
  written for the short retention (5 minutes), so a call of it does not
  wait. So compactions started together pay once for what they share, as
  uniichat's `AskAI.wait`. This holds for Anthropic and for OpenAI
  Responses and Codex (SSE and WebSocket), which pi-ai reports stream events
  for; other APIs do not wait.
- **OpenAI / Codex.** Every request carries `sessionId`, which becomes
  `prompt_cache_key` and the `session-id` header. The key is
  `optchat-<uuid>` for the chat and `optchat-<uuid>-compact` for the
  compactor, fixed for the store. Codex already sends `store: false` with the
  reasoning items' encrypted content. Requests share the view's prefix, so
  OpenAI's prefix cache serves them. Since pi-ai 1.4.0, a model it flags
  with `supportsAdditionalTools` and `supportsMidConvoSystemMessages` (the
  platform's GPT-5.4+ and GPT-6, Codex) gets its tools as an
  `additional_tools` item at the head of the input instead of the top-level
  `tools`: the prefix is that item, the system prompt, then the view. It is
  the same on every turn; the upgrade changed it once, so each cache was
  written again once (`optchat-cache-test.ts`, `optchat-gpt6-test.ts`).
- **Explicit breakpoints (OpenAI platform, GPT-5.6+).** For a model pi-ai
  flags with `supportsExplicitPromptCacheMode`, the last whole view block
  carries `prompt_cache_breakpoint: {mode: "explicit"}`, and a compactor
  request sets `prompt_cache_options.mode: "explicit"`, which drops the
  implicit breakpoint OpenAI would put at the request's end: its task is not
  written, as on Anthropic (uniichat sets the mode exactly when the end is
  unmarked). A turn keeps the implicit breakpoint at its end. A ChatGPT
  sign-in on the platform gets neither (pi-ai leaves `prompt_cache_options`
  out for it). The chat and the compactor pass no key, so whether a call is
  a sign-in is decided on the credential the registry resolves for it
  (`Models.getAuth`, as pi-ai's `applyAuth`), by pi-ai's own rule; one that
  does not resolve gets neither. Codex and Azure flag no model and get no
  breakpoints.
- **Reasoning context (OpenAI).** Where pi-ai sends `reasoning`, a GPT-5.6+
  model on the platform (provider `openai` at `api.openai.com`) or Codex
  (`openai-codex`) is sent `reasoning.context: "all_turns"`
  (uniichat sends it), so a message steered into a tool round keeps the
  run's earlier reasoning in context and in the prefix. The SDK's
  `Reasoning.context` says 5.6+ default to `all_turns` and earlier models to
  `current_turn`; older models are not sent the field until a live check
  shows they take it. An API-compatible third party with the same model ids
  (GitHub Copilot, opencode, Cloudflare AI Gateway) is sent what pi-ai builds.
  A request refused with an error naming `reasoning.context` or the value
  `all_turns` (Codex keeps only the message) is sent again once without it,
  and that model is not sent it again while cubed runs. Any other refusal is
  not sent again.
- **GPT-6 on the platform (R-1).** For a model pi-ai flags
  `supportsMidConvoEffort` (gpt-6-sol, gpt-6.1-sol, gpt-6-luna, gpt-6-astra)
  with an `sk-` key, pi-ai 1.4.0 fixes `reasoning.effort` at `medium` and
  sends the thinking level as a trailing `configuration_update` input item,
  so a level change alters only that last item. OptChat adds `all_turns`
  beside them, its own `prompt_cache_key` and the view's breakpoint; a
  ChatGPT sign-in gets the level as `reasoning.effort` and no configuration
  item. `optchat-gpt6-test.ts` pins this payload, its prefix across levels
  and the refusal paths offline. Whether OpenAI accepts `all_turns` together
  with `configuration_update` is **not tested** against the provider: a
  refusal that names neither `reasoning.context` nor `all_turns` gets no
  fallback, so every GPT-6 turn would fail the same way until the model is
  changed. That is a live check (two calls, within P1), not offline
  correctness.
- **Retention** is `short` for the chat and the compactor, even when
  `PI_CACHE_RETENTION=long`.

`packages/server/test/optchat-cache-test.ts` runs pi-ai's real Anthropic,
Codex, OpenAI and Azure request builders against a captured `fetch` and
checks what would be sent, including the waiting, the begun events, the
breakpoints, `all_turns` and its fallback. `optchat-cache-path-test.ts` runs the real
OptChat over pi-ai's Anthropic builder against a fake Anthropic that caches
by the rules uniichat's `cache.test.ts` models, and checks the bytes sent:
a turn's steps only append; a turn starts with the last turn's view through
its mark, byte for byte, unless a batch merged it (and then only merged
lines change); a reopen at rest, with summaries running or between a
turn's steps changes nothing of it; new instructions rewrite the request
once; turns carry three marks, compactions two; no two calls write the same
prefix at once, across reopens too, and no request is sent twice.
`optchat-close-test.ts` closes with summaries and a chat request out:
within the grace they are stored with their usage and the reopen sends
none again, and the tool and next step of the turn are not started while
closing, then once after the reopen; a tool running at the close and ending
in the grace is stored and runs once in all; a summary whose answer needs
feedback sends no follow-up while closing, then that follow-up once after
the reopen, byte for byte as the uninterrupted round, with the same line;
past the grace (forced), each cut-off call or tool is counted; a model
call is not sent again (a summary waits for the user's next message, which
asks it once; the chat's request ends its turn, counted once across
reopens) and a tool is run again at most once; a `spawn` cut off starts no task after the cut and
makes each thread once across the reopen; a tool and a provider that never
end and ignore the abort do not hold the close past its bound.
`optchat-replay-test.ts` runs every exposed tool twice under the same call
and task ids, as a replay does: each read-only one changes nothing, each
keyed one does its effect once (a hooks write leaves the user's edit made
in between) and both runs answer the same, byte for byte. `optchat-cache-test.ts` cuts off a Codex call
waiting in single flight while its session's WebSocket is cached and idle:
it sends nothing.
`optchat-view-fault-test.ts` makes the stored view's
commits fail after their nodes are stored, then reopens: the turns after it
send the views the uninterrupted chat sends. Hit rates are modelled offline (spec §3.3), not measured on
a live provider.

## Failing closed

- **A request whose view or images cannot be built is not sent.** Pi
  skips a `beforeRequest` hook that throws and sends the messages it built
  itself, without the view and the images: another prefix and another
  cost. It rethrows only when the generation's invocation was aborted. So
  the chat's hook catches its own failure (images, the turn's document, the
  view's rendering), aborts its generation with `Harness.abortTask`, waits
  for that abort and only then throws. The turn ends unanswered, as a stop
  does: nothing retries it, the next message starts a new turn, and a
  reopen does not send it. The failure is logged (`request not sent`) and
  shown as the chat's failure until the hook next builds a request (and
  hands it to Pi to send). If the abort's commit fails, the Session fails
  and its end aborts the generation; a close aborts it too. One exception:
  a close that seals admission before the abort commits leaves the turn's
  task live, so the reopened chat builds the request again and sends it
  once if it builds (it was never sent before), or refuses it again. Not a
  duplicate, but a reopen can send a request that was refused. The close
  does not wait for the refused request or count it as a call cut off.
- **Pi's reports.** Both Harnesses (the chat's and each thread's) pass
  `onReport`: a hook's or listener's throw, a task Pi cannot run
  (`task_too_old` after a rollback), a failed cleanup. Each is one warning
  line with the error's name, code and message, redacted (`pi-report.ts`)
  and bounded to 1000 characters; never its stack, cause or other fields,
  which can carry a provider request's headers or body.
- **A failed Session.** A failed Storage call ends Pi's Session
  (`harness.closed` settles `failed`): every task is aborted and every
  later call rejects. The chat watches it and goes down at once: it closes
  without the grace (nothing it waits for could be stored), cuts off the
  compactor's calls, starts no turn, node or retry, releases its provider
  sessions and shows `the chat stopped: its history could not be saved`.
  A thread's agent does the same: it is logged, its provider sessions are
  released, and its thread shows why (its row is an error, a reader of its
  transcript and a message are answered with why, and OptChat's thread
  record carries it). Neither reopens by itself, a thread's agent not even
  when its machine boots again (a runner restart or a guest crash): they
  stay down until cubed restarts (the conservative choice for D2′; nothing
  is sent while down). That restart's open counts the request that was out
  at the failure and does not send it again (above). A thread's archive
  still runs its release check, and the release ends the mark.

`pi-sends-test.ts` SIGKILLs a child cubed (the chat, the compactor, a
thread agent) while its request is out at a faux provider and reopens the
store: each is counted once, across a second open and a crash during the
open, and none is sent again; the chat's next message, the user's message
that releases the node and the thread's next message are answered. It also
fails the storage commit of each record (nothing is sent; the Session goes
down) and the chat's record before storage (refused, nothing sent).
`optchat-fail-closed-test.ts` makes the view's rendering and the image
check throw and checks that nothing is sent, now, with the next turn or
after a reopen, and that the log has no secret and no stack; fails the
abort's commit (the chat goes down, nothing sent) and holds the abort off
across a close (not waited for or counted; the reopen sends it once); then
fails the chat's storage with a request out and with a compactor call held,
and checks that nothing more is sent, the provider sessions are released
before any close, and the close ends without the grace. `pi-upgrade-test.ts`
pins Pi's side: the abort-then-throw primitive, and a thread agent's reports
and failed Session. `thread-down-test.ts` fails a thread's Session through
`Conversations` and checks what its row, its readers and OptChat's record
show, and that neither reboots of its machine (also one during the
failure) nor recovery rounds send its request again; then archives it.

## Configuration

- The chat's model is chosen in the chat's index (`GET/PATCH /api/optchat/model`);
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
- A spawned thread goes to the runner pool (its `berth vm` runners; refused
  when none has a free slot) unless the task names a `runner`
  (its node id, from `runners`); then it starts on that runner and never
  moves, and waits while it is down (on a `berth vm`, one whose machine
  was never ready stops after about 90 min of that, saying so, and a
  message tries again; docs/thread-lifecycle.md). That is the only way onto a host
  runner (`berth host`, unsandboxed), which OptChat names only when the user
  asks for it. A protocol-3 runner (`cube-runner`, retired) takes none.
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
(400 for a malformed body, 422 for a model no connected provider offers);
a save looks at the nodes held with their answers spent again, and at a
node whose last answer was out during the save once that answer is in.
The index also lists the newest
artifacts (`GET /api/artifacts`); comments on the chat's own artifacts reach
it as messages starting `[artifact <id>]` through the same pending queue, as
does the outcome of a merge the user confirmed on its artifact or on the
artifact of a thread it started.

## Deviations from the spec

- **No cache breakpoints on Codex, Azure or OpenAI before GPT-5.6.** The
  spec puts `prompt_cache_breakpoint` marks on the view's pieces. They are
  sent where pi-ai flags a model as taking them (the platform's GPT-5.6+).
  Codex CLI sends none and pi-ai flags no Codex or Azure model, so there the
  chat relies on prefix caching and a stable `prompt_cache_key`.
- **`reasoning.context` on models before GPT-5.6.** Not sent to `gpt-5.5`
  and older (a Codex model configured under such an id, since pi-ai 1.4.0
  lists none; the platform's `gpt-5.5` and older): whether they take it is
  unverified offline. Their
  default is `current_turn`, so a message steered into a tool round on such
  a model may read less of the round from the cache than in uniichat (not
  measured). Enabling it needs one authorized live check per API (a short
  call with the field: accepted or a 400).
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
  spec. While the compactor fails on something not its input's doing, the
  chat shows `summarizing: <error>` and keeps retrying (see the compactor
  above); the spec tries a failed call again at the next message.
- **The compactor's prompt** is its own system prompt (`COMPACT`), not the
  turns' (spec §7, mistake 6: it costs the compactor the turns' cache entry);
  it shows an invented 512-byte example line (`SCALE`) instead of the
  spec's ruler of dashes, with a warning not to copy it, and asks for three
  lengths in one answer. A message's step lets `<chat>` recover detail its
  input lost, where the spec gives that only to merges; its context has no
  ids. These are deliberate and measured only as above (calls and bytes per
  node), not for misattribution.
- **Tool calls are capped** at 30,000 characters like tool results
  (since `50929859`); the spec caps only results and pages any other long
  text.
- **A node cut short.** The spec does not say what a node becomes when the
  compactor never gives a line; cube, like Taelin's uniichat, cuts its
  source to the node size, and marks it so the view says to zoom.

## Known gaps

- A turn's images are bounded (8, 15 MB). A message that would take the
  running turn past them is not steered in: it waits for the next turn, with
  every message after it, so each request of a turn carries the images its
  last one did and its prefix stays the same, and the model gets every image,
  one turn later. A turn's own first messages can be over the bytes bound
  already (8 images of up to 3.75 MB); then its oldest go as notes from its
  first request on, the same in each, and any message with images steered
  after waits. A turn started before an upgrade to this has no record of its
  images: a message with images waits for the next turn.
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
- A refusal written as an ordinary one-line answer (OpenAI sends refusals
  as text) is kept as the node, as in uniichat: it cannot be told from a
  summary.
- Rolling cubed back to a version before pages, after a message over
  30,000 characters was logged in pages, makes the older version number the
  log otherwise than its tree; it has no check and would put summaries on
  the wrong messages. Roll back only a chat without such a message, or
  with a new `CUBED_STATE`. The supervisor rolls back on its own when a new
  version fails probation, so this is not always the user's choice: a long
  message sent in that window is enough. The next newer cubed then refuses
  to open the chat (`an older cubed numbered the chat's log without
  pages`) and nothing in the product repairs it; a chat with no long message
  opens as before.
- The view is stored only after a node is built, partial batches go on at
  every node as well as every message, and a turn takes every waiting
  message whole with no size bound (audit 3fc4ae39, F6-F8).
- Verified offline with faux models and a local guest only
  (`packages/server/test/optchat-*-test.ts`), never against a real model or VM.
