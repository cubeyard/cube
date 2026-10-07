# Cube architecture

## Ownership

- **pi-durable Harness + SQLite:** accepted prompts and their request IDs,
  transcript, model stream checkpoints, tool tasks/results, run status and
  resumption policy.
- **cubed:** projects, immutable runner admission, thread metadata, request
  allocation, access boundary, HTTP/SSE and activation of Pi's open operations.
  For a claude-code thread, the Claude Code child process and the thread record
  (accepted prompts, printed messages, session ID); Claude Code owns its session.
- **runner:** one QEMU VM per active thread, up to its `--max-active-vms`
  at once (allocate, start, stop, inspect, release; protocol 3) and the frame pump that carries the VM's Ethernet frames
  to the gateway. It runs no command of its own and cannot read Pi sessions or
  model credentials through the protocol.
- **thread VM:** the workspace (`/workspace`) and, in its guest helper
  `cube-guest`, durable deduplication and result retention for commands and
  writes, and the agent's `cube service` (supervised web servers and their
  registrations).
- **cube-gateway:** started and supervised by cubed; each VM's only network
  (DHCP, DNS, TCP termination, HTTP/HTTPS egress with TLS interception and a
  per-request decision from cubed's egress policy, secret substitution).
- **OptChat:** the user's one endless chat (`optchat*.ts`). A second
  in-process pi-durable Harness on `CUBED_STATE/optchat/pi.sqlite`: its
  entries are the chat's log, a model-free conversation holds the summary tree,
  and each turn starts at a head entry. It has no machine and no code tools; it
  starts, tells and archives ordinary threads. See [docs/optchat.md](docs/optchat.md).
- **web:** rendering and user actions, from the neutral thread event model
  only. SSE reconnect starts with a complete transcript; the browser is never a
  workflow owner.

There is one execution core, in process. No worker transcript hydration, second
agent-run journal or fallback backend. The old virtual-machine/container stack
and its release machinery have been removed. The current cubed-only release path
is described below and does not provision or update runners.

## cubed process lifecycle and updates

A managed installation starts a stable foreground supervisor, which owns one
cubed child and an exclusive installation lock. This is the direct execution
contract; optional systemd-user and launchd-user profiles only invoke the same
launcher. The supervisor passes a private capability over a mode-0600 local Unix
socket, plus a lifeline descriptor that makes cubed exit if the supervisor dies.
The HTTP process can request lifecycle actions but never receives signing keys or
filesystem paths, and a source checkout has no update capability.

Signed, platform-specific manifests bind the version, commit, artifact SHA-256,
size, supervisor floor and state-schema rollback contract. The supervisor stages
an immutable release, rejects unsafe archive paths and escaping symlinks, runs the
candidate's offline self-check, drains cubed, then atomically swaps `current` and
retains `previous`. Readiness checks require the signed version and commit, followed
by a probation interval. Startup recovery and failed readiness restore `previous`.
State and credentials live outside release directories and are never copied or
migrated by the updater. Schema 102 is currently accepted only by releases that
declare exact, rollback-safe schema 102 compatibility.

## Action, result, resume

Thread allocation and its first message are committed in the product registry
before activation. Each thread is one pi-durable Harness over its own storage;
the thread transcript is the Harness's root conversation. The host submits the
first message under a fixed request ID; afterwards Pi owns execution. On startup
cubed opens nonarchived threads and resumes Pi's unfinished tasks. Followup
request IDs are Pi submission request IDs, committed atomically with admission,
so a repeated HTTP action does not append another turn; a busy thread rejects a
new prompt instead of queueing it. The product registry stores no model or tool
progress. The thread's machine binding (runner and VM) and a random storage
identity live in a session-scoped Pi document, `cube.runner`; a changed binding
refuses to open.

Cube opens pi-durable's `SqliteStorage` on its own `node:sqlite` connection in
WAL mode and sets and checks `synchronous=FULL` on every open. pi-durable has no
cross-process storage lock; the thread's workspace lease is that lock.

Pi's tools reach the thread's VM only through the thread `Workspace`. `read`,
`write` and `edit` are pi-durable's own file tools over an `ExecutionEnv`
(`workspace-env.ts`) that maps the virtual root `/workspace` to workspace-relative
guest paths; a write after a read in the same call carries the read content's
`expectedSha`. `bash` is cube's own tool. Every mutation key is derived from the
storage identity and the Pi tool task ID, so a replayed task finds the same
guest operation: a repeated exec retrieves retained work; changed arguments
conflict. `read`, `write` and `bash` are replay-safe; `edit` is not and
is reported as interrupted after a crash. The file tools read whole files of at
most 2 MiB, as the Claude Code mod does; a larger file is refused after its
first page with a hint to use bash.

`codemode` (`codemode.ts`) runs one model-written JavaScript script in
pi-codemode's QuickJS VM, a fresh worker per script whose only capabilities are
the same four tools. It is one pi-durable tool with replay `unsafe`: a script
interrupted by a crash is reported as possibly partially run and never rerun;
its running output names each nested call that had started. Nested calls run one
at a time in call order, and each reaches the Workspace under the codemode task
key plus its sequence number (`pi:<instance>:<task>:code:<n>`), so every nested
call has a stable identity. The host enforces strict limits modelled on cube's
earlier codemode: 64 KiB source, 64 MiB VM memory, a 15-minute wall deadline,
64 nested calls, 1 MiB arguments per call (both stop the script), 4 MiB per
nested result handed to the script and a 256 KiB final result, cut with a
notice. A mutating call stopped while running, or one whose guest outcome is
unknown, makes the result an error that lists it as uncertain; a call that does
not settle within 10 seconds of the script ending blocks the next script until
it does. Nothing is retried automatically. The worker is fault containment for
cubed, not a sandbox; the tools themselves act in the thread's VM.

Stop aborts Pi's tasks and cancels a running guest command; a host shutdown
leaves a direct `bash` command running in its transient systemd unit and the
next process reattaches to it. Codemode's nested commands are cancelled on
shutdown too, because codemode is never rerun. The guest helper never silently
reexecutes Interrupted operations or evicts IDs to create room. A lost response
therefore does not imply a second effect. Runner protocol 3 is VM lifecycle
only; a protocol-2 runner is incompatible and must be re-enrolled; see
[RUNNER.md](packages/node-transport/RUNNER.md) and the
[VM runner plan](docs/plans/2026-10-04-vm-runner.md).

Pi recovery is a durable task state machine, not complete-history replay. Partial
model responses can be interrupted and retried under Pi policy; a provider may
bill both attempts. SIGKILL tests are not proof of power-loss durability.

## Workspace and lease

`Workspace` (`packages/server/src/workspace.ts`) is the one contract for a
thread's workspace: `lease`, `exec`, `operation`, `cancel`, `readFile`,
`writeFile`, `stat`, `capabilities()` and `limits()`. `VmWorkspace`
(`vm-workspace.ts`) implements it over the guest helper `cube-guest` in the
thread's VM, reached with the system OpenSSH client through `cube-gateway dial`
(`guest-ssh.ts`: one ControlMaster per VM, host keys cubed generated and pins,
a client key that may only run the helper). Workspace semantics stay in the
helper (a journal under `/var/lib/cube/ops`, commands in transient systemd units
running as `agent`, atomic writes); cubed only translates, checks capabilities
and limits, and enforces the lease. Every helper operation is idempotent by key,
so a transport failure (a gateway restart) is retried for a bounded time before
it becomes `NODE_UNAVAILABLE` or `COMPLETION_UNKNOWN`. The HTTP routes under `/api/threads/:id/workspace` are a thin
transport over the same interface, and `HttpWorkspace` implements it again for
out-of-process agents. One contract suite runs against both.

Each thread has one writable owner, `pi` or `claude-code`, fixed for the thread.
The lease (`workspace-lease.ts`) has a random token, which is the authorization
for every lease-scoped call, the owner, a fencing epoch and, for remote holders,
a heartbeat deadline. While a lease is held, a dedicated SQLite connection keeps
a write transaction open on the thread's `lease.lock`; a competing process or
instance cannot take it, and process death releases it at once without stale PID
files. Pi holds the lease for its whole Harness lifetime. The epoch is the only
durable lease state: it never decreases and is at least the wall-clock time in
milliseconds, so it stays increasing even if the thread directory is lost. Every
guest mutation carries it, and the guest helper refuses an older epoch than the
newest it has seen. Runner requests carry a separate per-thread VM epoch
(`threads/<id>/vm/epoch`), which the runner fences the same way.

Mutations carry a caller-chosen idempotency key, scoped to the thread's machine
binding and hashed into the guest operation ID. A key already seen is never
executed again; the same key with a different request is `CONFLICT`; a cancel
that overtakes its command records the key cancelled so it never runs. No shell
fallback exists: a guest lacking a workspace capability is incompatible.

## Thread event model

`thread-events.ts` defines what a thread shows, whatever agent runs it: a
`ThreadTranscript` with the thread's `agent`, the workspace's current writable
`owner`, a `status` (`idle`, `working`, `completed`, `failed`, `stopped`) and an
ordered list of events: user message, assistant text (with a reasoning flag),
tool call and tool result (paired by `callId`). An event still streaming carries
`final: false`: the in-flight model partial and a running tool's output.

`ThreadEvents` has the same interface in-process and over HTTP: `read()` and a
serialized, coalescing `watch()`. `PiThreadEvents` renders pi-durable's
conversation view (entries plus `pi.live`); `GET …/history` returns `read()` and
`GET …/stream` (`thread-events-http.ts`) sends one transcript per SSE frame and
ends the stream when the source closes. `HttpThreadEvents` is the client; it is
browser-safe and the web UI uses it directly. An agent adapter is the only code
that knows its agent's shapes; the UI never reads Pi messages.
`ClaudeThreadEvents` renders a claude-code thread into the same transcript.

A send has one rule from the key to the log: once the reader sees a message,
they see it until the log has it. The browser shows its own copy at once
(`packages/web/src/lib/outbox.ts`), stands it aside while the transcript shows
the host's copy, and drops it once the log has the message (an id without
`PENDING_ID`) or a newer run than the one it was sent after has ended. OptChat's
frames merge Pi's transcript with the messages still waiting for their turn;
Pi's transcript can be older than that list (a long chat renders slowly), so
`OptChatEvents` keeps a waiting message a frame showed until the transcript has
it, and keeps the chat working meanwhile.

## Claude Code threads

Claude Code is an alternative thread agent for one purpose: to use the person's
own Claude Max subscription through the unmodified `claude` binary and its own
login (`claude /login` or `claude setup-token`). Choosing a model under
"claude · max" at thread creation makes a `claude-code` thread; the agent is
fixed for the thread, and within it only Claude Code's own models (`fable`, `opus`,
`sonnet`, `haiku`) can be chosen. Claude Code is not a provider in cube's model
settings, and Pi does not offer Anthropic's Claude Pro/Max OAuth login: Pi
reaches Anthropic models with an API key.

`ClaudeAgent` (`claude-agent.ts`) takes the thread's `claude-code` lease for its
lifetime and starts `claude -p --input-format stream-json --output-format
stream-json --verbose --include-partial-messages --setting-sources ""
--strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools <allow-list>
--plugin-dir packages/claude-mod --model <model>` on the first prompt, in a stable per-thread
directory, with `--resume <session-id>` once Claude Code has reported a session.
Prompts go to stdin under their request ID (a repeated ID is accepted once), stop
is a stream-json `interrupt` control request; a child that ignores it is sent
SIGTERM, then SIGKILL. cubed follows the Bash calls in Claude Code's messages
and cancels their guest commands (`claude:<tool_use_id>:bash`) itself when it
kills the child, when the child dies mid-turn and on close, because the mod
never sees an abort then. A model
change closes the idle child so the next prompt resumes with the new
`--model`. An idle child is closed after ten minutes, never while a background agent (Claude Code's Agent tool runs one by default) still runs: ending the child ends it. cubed follows Claude Code's `task_started`/`task_notification` messages; the turn Claude Code takes by itself for a finished background agent is recorded as a run of its own, and background agents that can no longer finish (the child ended, cubed stopped, 4 hours passed) as a failed run, so watchers hear of them once (docs/optchat.md, "Follow-up and unattended work"). cubed never stores Claude
credentials; the child gets an allow-listed environment without any
`ANTHROPIC_*` variable or Bedrock/Vertex switch, so the subscription is used
instead of API billing, and without cubed's other credentials. The user's
settings files and MCP servers are not loaded. `findClaude()` locates the binary (`CUBED_CLAUDE` names
it, or `off`); without one, claude · max is not offered.

The mod (`packages/claude-mod`) is a Claude Code plugin of function hooks. Its
`tool.call` hooks answer Bash, Read, Write and Edit from the thread Workspace,
keyed by `tool_use_id`, in each tool's own output shape; Edit is read, replace,
then a write conditional on the sha it read. Read returns a `.png`, `.jpg`,
`.jpeg`, `.gif` or `.webp` file as an image the model sees when its header is
that format, it does not look truncated and it fits every model provider
unresized (at most 2000 pixels a side and 5 MiB as base64); the mod cannot
decode or resize, so it refuses a larger image and names a bash resize instead.
An image the API still rejects, Claude Code replaces with a note to the model. Tools are an allow-list
(`ALLOWED_TOOLS` in `hooks/tools.ts`, also passed as `--tools`): everything else,
MCP tools and built-ins the list does not know included, is refused because it
would act on the cubed host. It also refuses background Bash, subagents with
worktree or remote isolation and agent types that are not Claude Code's
built-ins, and its
`prompt.context` hook adds the workspace's `AGENTS.md` and `CLAUDE.md`. The mod
reaches cubed on a private Unix socket (`CUBED_STATE/run/workspace.sock`, mode
0600) that serves only workspace routes; the lease token cubed holds for the
child is the authorization. A Claude Code hook's own time is budgeted, so it
waits on a running command with the route's long poll (`?wait=`) instead of
sleeping. `HttpWorkspace` wraps the mod's portable client, so the shared
contract suite covers both.

Durability is weaker than Pi's, and the UI says so: Claude Code keeps its own
session but has no task checkpoints, so a turn cut off by a cubed restart is
marked failed and not continued. Workspace keys still keep the guest from
executing any tool call twice. Repository skills reach Claude Code only as text.

## OptChat

OptChat implements Victor Taelin's OptChat memory over Pi, with cube threads
as its only way to act. A turn waits until every line of the view is a summary,
writes an `optchat.turn` head entry and the turn's view parts, then submits
the waiting messages; a `beforeRequest` hook puts the rendered view in front of it. The
compactor runs beside it in cubed, with cheap model calls that carry no tools
and no ids, and appends each node as an entry. A spawned thread is created
through the registry with a request ID derived from the tool call, so a replayed
`spawn` finds the same thread. Its settled runs come back as `[id] ` messages:
every accepted message waits in a Pi document until Pi has placed it, under its
own request ID. Its `archive` tool calls the same `Conversations.archive` as
the UI, for its own threads only, and refuses a working one. Images the user
attaches are kept in a content-addressed store beside the Pi store; a message
holds references, and the same hook puts the images in for that turn's
requests only. The details, deviations and gaps are in
[docs/optchat.md](docs/optchat.md).

## Usage and cost

Usage is read, never metered: Pi's per-conversation `pi.usage` ledger (written
in the commit that records each response), the `modelUsage` running totals in
the Claude Code results cubed keeps, and OptChat's count of its compactor's
calls. `usage-service.ts` turns them into tokens and estimated cost per thread,
project and model, keeps each one's provenance and pricing basis, and marks
unpriced tokens and unrecorded usage as unknown rather than zero. Billed amounts
are not available. `CUBED_STATE/usage.sqlite` keeps the last reading of each
thread as a derived cache, so an archived thread's usage stays readable and a
Pi store is only opened by its own agent while the thread is open. Routes:
`GET /api/usage`, `GET /api/threads/<id>/usage`; OptChat has a read-only
`usage` tool. See [docs/usage.md](docs/usage.md).

## Product state and limitations

`CUBED_STATE/registry.sqlite` contains projects, globally registered runners,
operator contact observations and retirement audit, thread metadata (with each
thread's machine: its VM id, fixed at creation, and its secret placeholders) and
creation request keys. `CUBED_STATE/threads/<id>/pi.sqlite` is the thread's
pi-durable storage (`claude.sqlite` and the `claude/` working directory for a
claude-code thread); `threads/<id>/lease.sqlite` keeps the thread's lease epoch
and owner, `lease.lock` is only held while a lease is, and `threads/<id>/vm/`
holds the VM's SSH client key, its pinned host key and the VM epoch.
`CUBED_STATE/usage.sqlite` caches the last usage reading of each thread and
of OptChat (derived, rebuildable from the stores above).
`CUBED_STATE/gateway/` holds the gateway's Iroh key and the installation CA;
`CUBED_STATE/run/` the private sockets (`workspace.sock`, `gateway.sock`,
`egress.sock`) and SSH ControlMaster sockets. The state schema is 102 and older
registries are refused, not migrated (see the reset workflow in DEVELOPING.md);
cubed also refuses to open a thread directory that still holds the old Pi store
(`session/` or `owner.sqlite`). One cubed serves one `CUBED_STATE`: a second
refuses to start while the first's workspace socket answers.

A runner has one permanent node/environment admission (runner config version 2)
and belongs to the Cube installation, not a project. It hosts up to
`maxActiveVms` thread machines at once, each its own QEMU, disk, seed, frame
channel and gateway LAN. The runner decides the bound (`--max-active-vms`,
`auto` by default: what fits if every VM uses the installation's per-VM
maximum, 1 to 4) and enforces it under its mutation lock; cubed records it at
enrollment, runner checks and machine starts. An open thread holds one slot on
its runner from creation until its archive finishes, failed or releasing
machines included; the runner row's
`available/allocating/busy/releasing/failed` is a summary of those threads in
the shape a one-machine runner always had, `available` while a slot is free;
the runner journal persists each VM record and reconciles interrupted
transitions without deleting a disk. Thread creation fetches each repository
again and resolves its configured branch, or the default branch the remote
advertises now, to an exact base OID: a new thread starts at the latest
commits, never at the project's last check, and a fetch that fails starts no
thread. Project configuration names branches only, so there is no immutable
ref to keep; the pin is the thread's, fixed at creation. Creation captures the
project revision (a project edited meanwhile fails the creation), each
repository's normalized URL, resolved branch and base OID, allocates a runner
and returns. A replayed creation request returns its thread with its original
pins, and retries, reattach and template reuse check out those pins, never a
newer commit. `ThreadVms` (`vm.ts`) then allocates the VM, starts it with a cloud-init seed (`vm-seed.ts`: the pinned host key,
the restricted client key, the CA, the placeholders and the guest helper),
attaches it to the gateway and waits until the guest helper answers ready (the
thread is `starting` meanwhile). The first activation provisions the pinned
checkouts with an ordinary workspace command under `cube:provision:<n>`:
`/workspace` plus references in `/repos`, fetching only each declared branch
through the gateway, verifying the pinned commit and checking it out detached;
an empty project gets an empty `/workspace`. A failed try is never rerun under
its key, and a force-pushed branch that no longer holds the pinned commit fails
closed. Archive runs the release check (every checkout at its pinned commit, no
changes, branches, stashes or commits of its own, no other command running).
The guest is agent-controlled, so its answer alone never deletes a disk:
`VmWorkspace` records in the thread's lease store that the agent ran a command
or wrote a file before sending it (cubed's own provisioning and checks do not
count). A machine is released and its disk deleted only when that record is
empty and the check is clean; anything else, an unreachable machine, a failed
one or an interrupted one is retained on the runner. While an archive runs,
activation and the recovery loop do not reopen the thread.

On a cubed restart machines keep running; activation starts each again (which
rotates its frame token), attaches it and Pi reattaches to running commands by
key. On a gateway restart cubed re-attaches every VM and the SSH masters
reconnect; running commands survive in their units. On a runner restart the VM
is stopped and marked interrupted; the next activation (or the 30 s recovery
loop) boots it again from the same disk and the guest marks unfinished
operations interrupted.

Registry allocation counts a runner's open threads and inserts the new one in
one `BEGIN IMMEDIATE` transaction, so concurrent requests, also from another
process, cannot take a runner's last slot. It chooses by the runner's last
observation (`runnerFitness`: `ready` if it answered ready within two minutes,
`down` if its last contact failed or it was not ready and its retry, 5 s
doubling to 60 s, is not due, otherwise `unverified`), then the lowest share
of used slots, runners with a failed machine last. A runner that reports no
bound (before 0.7.0) has one slot.

A thread's placement on its runner is `provisional` (no `vm.allocate` for its
machine reached the runner), `requested` (kept before the allocation is sent)
or `allocated` (the runner returned the machine, from `vm.allocate` or
`vm.inspect`). Before anything of a provisional thread is sent, an
`unverified` runner is asked `node.status` (one question per runner at a time)
and a `down` one is not asked. A thread whose runner does not answer, is not
ready or refuses the machine moves, in one registry transaction, to another
runner with a free slot that is not down, provided it is provisional and its
agent storage and lease store do not exist yet. A requested thread moves only
after its runner refused a request fenced by the thread's newest epoch
(`CAPACITY_EXCEEDED`, `DRAINING`) and `vm.inspect` then found no machine, so
no older request can still make one; a lost answer or a runner that does not
answer keeps it there. An allocated thread never moves. A thread that cannot
start for want of a runner waits (`RunnerWait`): its workspace stays
`allocating`, it holds its slot, it reads as starting (`waiting` in the API
and OptChat's thread state give the reason), and the recovery loop tries
again. A thread on a runner that is down sends it nothing until its retry is
due; a template build machine left on a runner the thread moved away from is
deleted once that runner answers. cubed keeps one client per
runner, so the threads' runner calls queue on one Iroh identity. Project deletion never owns or
deletes a runner and remains blocked while any thread history references the
project. Runner contact is authenticated `node.status` evidence. A failed latest
check is `unreachable`; it becomes `stale` only after seven continuous days
without a successful check. Success clears that interval. Retirement is
installation-global and first reserves the runner against allocation. Both
reservation and commit read the global runner/thread allocation snapshot and
require no active allocation. A reachable runner must also report no active
machine and cubed must have no open thread on it; an unreachable runner must be
stale. Changed status or allocation fails
closed. The permanent tombstone removes global capacity while retaining
immutable identity, thread links, reason, probe evidence, runner journals and
retained disks.

The thread's VM is its sandbox, and the boundary is precise. It covers the
agent's processes and files (they live in the guest, as `agent` with sudo
there, and cannot see the runner account, its keys or journal, or another
thread), its network (raw frames to the gateway only: HTTP and HTTPS to public
addresses, never cubed, the runner, the gateway host's own addresses, a LAN or
a metadata service, each request decided by cubed in `egress-policy.ts`;
inbound only cubed's SSH to port 22 and, through the portal, registered
service ports) and
its credentials (placeholders only; the gateway replaces the GitHub
placeholder with the host's token only for github.com and api.github.com over
HTTPS). It does not cover a QEMU escape (QEMU runs as the runner account,
hardened only by `-sandbox on` on Linux, nothing on macOS), so the runner host
as a whole is not a sandbox. It does not stop the agent sending what it can
read to any public HTTPS host, or using the host's GitHub authority on GitHub.
Pi, codemode's worker and Claude Code run on the cubed host, outside any VM.
Keep host Git/model credentials out of runner accounts. Browser access is loopback, an access-controlled
private network, or an authenticated private proxy; Iroh authenticates runner
and gateway communication, not browser users.

## Machine templates and hooks

**Hooks.** A project has two optional external hooks (`hooks.preSetup`,
`hooks.preResume`, at most 16 KiB each, edited on the project page and kept in
the project record). A thread captures them at creation, like its pinned
commits, and its machine's seed writes them to `/etc/cube/hooks/`. Each hook
runs as `agent` in `/workspace` with its output in `~/.cache/cube/<hook>.log`.
The repository's own `.agents/setup` and `.agents/resume` run too; neither
replaces the other:

- **preparation**, once per machine: checkout, then pre-setup, then
  `.agents/setup` (only if pre-setup succeeded);
- **resume**, once per machine boot, before the agent uses the machine:
  pre-resume, then `.agents/resume` (only if pre-resume succeeded). A marker
  on a tmpfs records that the boot resumed; a cubed restart that finds the
  machine running does not resume it again. A machine that boots again under
  an open agent (a runner restart) closes the agent first, as a cubed restart
  would, and reopens it after the hooks.

A failing hook stops its phase but never the thread: the outcome (`ok`,
`failed` with its exit code, `skipped`, `notrun`, `absent`) is recorded in
`thread.vm.hooks` and the thread strip shows failures. A failing checkout
fails the thread as before. Hooks are not secret storage: the agent can read
them and the guest holds only placeholders.

**Templates.** A new thread's machine starts from its project's template on
its runner when there is one: a read-only qcow2 (`templates/<id>/disk.qcow2`,
cube-runner 0.8.0) under the machine's own overlay. Then the machine skips
preparation: the template's checkouts are moved to the thread's pinned
commits (fetch, `checkout -f`, reflogs expired), pre-setup and setup are
`skipped`, and resume runs as on every boot. If the pinned `.agents/setup`
blob differs from the one the template ran (its metadata), pre-setup and
setup run in this machine and the template is removed so the next thread
builds a new one. Without a template the thread's slot is first used by a
**build machine**: the base image, a throwaway identity (its own VM id, keys
and GitHub placeholder, registered so the gateway serves it), the thread's
pinned checkouts, pre-setup and `.agents/setup`. Only if all of that succeeds
does cubed run `cube-guest seal` and power it off: at shutdown the guest
removes its SSH host keys, machine id, cloud-init instance state, the
helper's journal and epoch, `/etc/cube` (keys, placeholders, hooks), the
build's hook logs, DHCP leases, the random seed, `/tmp`, shell history and the
system journal; the freed blocks are discarded (the bulk before power-off,
because the runner counts a stop that takes over 30 s as interrupted). A
clean power-off (not `interrupted`) is required for the runner to publish the
disk (`vm.publish` moves it, read-only); then
the thread's own machine is allocated on it. Anything else deletes the build
machine and the thread starts fresh (a build that failed is not retried for
the same key on that runner for an hour). Toolchains, package caches and the
prepared checkout stay; that is the point.

A seal that could not clean something says so in a marker; the first boot
of each machine made from the template empties the helper's journal anyway
and its helper reports the failure (also when the seal never ran), and cubed
then records it on that thread's preparation and removes the template (checked
once that thread's preparation succeeded).

Isolation: no agent ever runs in a build machine; every machine writes only
its own overlay; each gets a new VM id, MAC, host key, client key,
placeholder, machine id, hostname and instance from its own seed, and the
first boot of a template's machine starts the helper's journal empty. A
template is per project and runner, never shared between projects. Its
content is what the project's pre-setup and setup produced, so it is as
trusted as they are (the seal itself runs inside a machine where the
repository's setup had root through sudo, and each machine's seed rewrites
the helper, keys and `/etc/cube` regardless); a deleted file's bytes may survive in a partly used
qcow2 cluster of the template, which is why only the build machine's
throwaway identity (useless after its release) was ever in it. Agent
sessions live on the cubed host and never enter a guest.

**Key and lifetime.** A template is reused when its key matches: the
project, its repositories (URL, branch, checkout name), the pre-setup hook,
the guest packages and helper, the runner's base image and platform and the
disk size. The commit is not in it (the checkout is refreshed) and neither
are resume hooks (they always run). It is reused for 24 hours
(`CUBED_TEMPLATE_TTL_HOURS`; the age compares the runner's clock at
publication with cubed's, so clock skew between the hosts shifts it), which bounds how stale dependencies that
`.agents/setup` installed can be while the setup file itself is unchanged;
put what must be fresh per thread in a resume hook. Publishing a template
removes the project's older ones on that runner; expired templates and those
of deleted projects are removed when the next machine is allocated there.
The runner deletes a removed template once no VM depends on it (retained
ones included). One build per runner and key runs at a time: a thread that
comes meanwhile starts fresh. `CUBED_TEMPLATES=off` or a runner before 0.8.0
means every machine starts fresh. The startup phases (`allocate`,
`build-*`, `boot`, `prepare`, `resume`) and the total from creation to ready
are logged ("machine ready for the agent") and kept in `thread.vm.startup`.
A machine that does not get there leaves evidence: cubed's machine events
(`threads/<id>/machine-events.jsonl`) and the runner's (`vms/<n>/events.log`,
cube-runner 0.8.3), read with the rest by `GET /api/threads/<id>/diagnostics`
and OptChat's `diagnose` (`vm-diagnostics.ts`, `vm.diagnose`; read only,
escaped and redacted; see docs/runner-operations.md, "Diagnosing a machine
that does not start").

## Services and the portal

`cube service` (the guest helper's CLI, `/usr/local/bin/cube`) runs an
agent's web server as a persistent systemd unit (`cube-service-NAME`)
outside the transient unit of the command that started it, and registers
its port under `/var/lib/cube/services`. Nothing in the guest calls cubed:
cubed reads registrations with the helper's `services` operation. When cubed
resumes a machine it brings the helper to the one it ships (`install`, or a
one-time chunked replacement of a helper from before `install`) and writes
the machine's portal URL template (`portal`).

The portal (`portal.ts`, off unless `CUBED_PORTAL_IP` is set) is a second
HTTP listener on a private address. A request's Host must be exactly
`<service>-<thread label>.<suffix>:<port>` (label: an HMAC of the thread id
under `CUBED_STATE/portal/key`; suffix: by default `<ip>.sslip.io`); cubed
then dials the registered port through the gateway's dial route (which
allows 22 and 1024-65535) and proxies HTTP/1.1 and upgrades. It only reaches
machines cubed already runs, never starts one, serves nothing of cube's and
strips cookie domains. Details, setup and caveats: [docs/services.md](docs/services.md).

## Verification

`pnpm test` runs the offline suites, among them the guest helper's own tests,
the Workspace contract over `VmWorkspace` with the real helper under a
temporary root (a "local guest" with a process launcher instead of systemd),
seed, egress policy and gateway supervision tests, and the process-level smokes
(`scripts/smoke-local.ts`: four Pi SIGKILL boundaries, the product API with
restarts and a claude · max thread through a fake `claude`).
`scripts/test-node-transport.sh` runs the Rust checks and, where KVM, QEMU and a
Debian image (`CUBE_TEST_VM_IMAGE`) are available, the real pieces: the runner
with a guest (`smoke-runner-vm.ts`), cubed's side of it
(`smoke-node-adapter.ts`: protocol-3 client, gateway supervision, the Workspace
contract over SSH, egress, runner SIGKILL, retained release) and the product
end to end (`test-vm-e2e.ts`: Pi tools in the guest, cubed and gateway SIGKILL
mid-command, egress, `gh`/`git push` with secret substitution against a local
GitHub fake, a Claude Code thread, clean and retained archives) and two thread
VMs on one runner (`test-vm-concurrency.ts`: the bound, side-by-side boots and
commands, separate machines, slots returned at archive) and machine templates
(`test-vm-templates.ts`: a build machine, publication, identity and
isolation of machines on one template, invalidation by a changed pre-setup,
resume after a runner restart, a failed build falling back to a fresh
machine). Hook order and failure rules, the template checkout refresh and
stale setup, keys and selection run offline in `vm-template-test.ts` with the
real guest helper. Mocks are not
runner acceptance. `scripts/check-claude-mod.sh` validates and tests the mod
with the installed `claude` CLI without calling a model; the real CLI is never
started by tests. These use controlled models and disposable data, never live
users. Separate-machine Linux/macOS lifecycle and paid-model acceptance remain
separate release checks. The pinned reference snapshots are under `repos/`.
