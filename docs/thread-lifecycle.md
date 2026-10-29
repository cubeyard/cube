# Thread lifecycle

A thread has four lifecycles, each with one source of truth. Code that
changes one names its owner here; a test that checks one is listed under
[Tests](#tests).

| Lifecycle | Truth | cubed keeps | Owner of the transitions |
|---|---|---|---|
| Thread | the registry (`workspaceState`, `workspaceError`, `retry`, `archived`) | persisted | `Conversations` (`ensureWorkspace`, `archive`, `release`); the phase's transitions are `thread-phase.ts`, written only by `Registry.applyPhase` |
| Machine | the runner's phase | `vm.suspension`, `vm.placement` (a mirror and a slot reservation) | `RunnerMachines`; the sleep's transitions are `machine-sleep.ts`, written only by `Registry.applySleep` |
| Agent | this process (`agents`, `claudes`, `downs`) | nothing; runs are in the agent's own store | `Conversations` |
| Report | OptChat's Pi store, by request id `report:<thread>:<run>` | persisted | `OptChat` |

## Thread

```text
(new) ─createThread (takes a slot)─▶ allocating ─ready─▶ available
allocating, failed ─a try fails─▶ failed ─a try succeeds─▶ available
available, failed ─archive─▶ releasing ─released (frees the slot)─▶ archived
releasing ─release fails─▶ failed ("workspace release failed: …") ─retried─▶ archived
allocating ─its model or commits step fails (no machine yet: gives up its slot)─▶ failed ─retaken (a slot free behind the queue)─▶ allocating
```

`archived` is terminal: nothing starts, wakes or calls its machine again;
only its retained disk can be discarded.

Conversations reports what happened as one `PhaseEvent`, and `nextPhase`
(`thread-phase.ts`) is the whole table of what follows:

| event | the phase after it |
|---|---|
| `ready` (made and prepared) | `available`, no error, its base |
| `failed` (making or releasing it failed) | `failed`, the failure's words |
| `tryFailed` (a start or release try failed) | `retry` counts it: how many in a row, since when, the last words |
| `trySucceeded` | no `retry` |
| `releaseBegan` (an archive decided the disk) | `releasing`, no error, no `retry` (the release's own tries count from here) |
| `released` | `archived`, its slot free |
| `retaken` (a thread whose commits failed took a slot again for its next try) | `allocating`, no error; `retry` stays |
| any, once `archived` | unchanged |

`Registry.applyPhase` is the only writer: it applies the event in one
IMMEDIATE transaction with the runner's summary and writes nothing when
nothing changes. The row keeps the fields and words cubed always wrote
(thread-phase-test).

## Machine

```text
(none) ─create + start─▶ running ─idle 5 min, nothing busy─▶ suspended
(none) ─create, runner full─▶ queued ─its turn, a slot free─▶ running
running ─a thread waits for a slot on its runner; idlest, nothing busy─▶ suspended
suspended ─a start─▶ waking ─the runner resumes it─▶ running
waking ─runner full─▶ waking + waiting ─its turn, a later try─▶ waking
running ─the runner restarts─▶ stopped ─recovery's check─▶ running
running, suspended ─archive─▶ released (deleted, or retained with a reason)
```

cubed records only `suspension` (`suspended`, `waking`, `waking` +
`waiting`, `queued`); running, starting and suspending live in this process.
`RunnerMachines` reports what happened as one `SleepEvent`, and
`nextSleep` (`machine-sleep.ts`) is the whole table of what follows:

| event | from any sleep, or none | from `queued` | holds a slot |
|---|---|---|---|
| `queued` (a new thread, its runner full) | `queued`, since now | as it was | no |
| `suspended` (the runner saved it) | `suspended`, at that time | `suspended` | no |
| `wakeAsked` (a start resumes it, or makes a queued thread's machine) | `waking`, or `waking` + `waiting` with no slot free for it | none (it starts), or as it was | without `waiting` |
| `slotTaken` (the runner was full after all) | `waking` + `waiting` | as it was | no |
| `wakeDropped` (nothing goes on with the wake) | `suspended`, as saved | as it was | no |
| `running`, `resumed` (with its notice) | none: it runs | none | yes |

A sleep with `waiting` (`queued`, or `waking` + `waiting`) is in its
runner's queue, in the order of its `since`: when it began to wait, kept
until the wait ends (a `waking` + `waiting` written before the queue has
none, and its `at` stands in).

`Registry.applySleep` is the only writer: it applies the event in one
IMMEDIATE transaction with the runner's summary, so a sleep cannot be
written in a combination the table lacks (`suspended` with `waiting`), or
without its slot counted. Its notice changes only with `resumed`. No other
registry write sets either: `updateThreadVm` takes neither, and none writes
a whole row from a caller's copy (a title changes by `renameThread`, which
reads the row in its own transaction). `holdsSlot` is the slot rule, and
`HOLDS_SLOT_SQL` the same rule for the registry's counts
(machine-sleep-test, lifecycle-model-test I11), but for one row: an
accepted thread whose `model` or `commits` step failed before it had a machine
(`failed` with `allocation.latest`) holds no slot and no place in the queue,
during its retries and after they stop, and its failure starts the queued
threads of its runner at once. Its next try takes a slot only if one is
free behind every thread waiting (`Registry.retakeSlot`, `retaken`);
otherwise it stays `failed`, counts no try, and the recovery loop asks
again. `waking` without `waiting` holds a slot. It is a
reservation, taken like a new thread's (`wakeAsked`, in one
IMMEDIATE transaction that counts every other open thread holding a slot on
the runner and every thread waiting since before it): with none free for it
the thread is `waking` + `waiting` and the runner is not asked, so a wake
never takes the slot of a thread whose machine is not created yet, nor of
one that waited longer. A runner that refuses a slot all the same (another
cubed, a lowered bound) makes a wake wait the same way, and a new machine
wait (`RunnerWait`, its boot step `interrupted`), not fail.

The queue is these rows, first come first served, new threads and wakes
alike (machine-sleep-test T7, lifecycle-model-test I13). It is each
runner's own, not the pool's: a queued thread stays on its runner, and a
slot that frees on another runner goes to a thread there (a new one
included) while the older one waits for its own (machine-sleep-test T8);
on one runner, as on a Mac, the two are the same. `createThread`
places a thread with no slot free (the threads waiting count as holding
theirs) on the least loaded runner as `queued` (a named runner: on it), in
the same transaction, instead of refusing it; only a pool with no runner
refuses. A queued thread's machine is not made and its runner not asked
until `Conversations.ensureWorkspace` gets its slot (`wakeAsked`);
`RunnerMachines` refuses to make it before (`RunnerWait`). The recovery
loop asks for the slot each round; a slot that frees (an idle round's
suspend, a release) goes to the queue at once (`Conversations.admit`); a
waking thread's own wake asks again every `retryMs`, and one that gives up
leaves the queue (`wakeDropped`). While threads wait on a runner, the idle
round (`suspendIdle`) suspends that runner's machines idlest first, without
the 5 minutes, until each has a slot: one at a time, with every guard of
the 5-minute rule (`busy`, commands, the portal, a registered service, the
32 minutes after a cubed restart, the runner's own refusal). It runs too as
a thread begins to wait. On a runner with no thread waiting nothing
changes. A message or a steer to a queued thread is refused with the
wait's words (no failure, its place kept); archiving one asks its runner
nothing (thread-queue-test). The reservation is for a wake this
process runs, never a wish: a `waking` that no
start or wake of this process owns (a restart cut it short) is read back
from the runner (`RunnerMachines.settleWake`) and recorded as the runner's
phase, `suspended` or running. It is not continued.

## Who may start or wake a machine

| Trigger | Starts or wakes |
|---|---|
| a new thread (UI, OptChat `spawn`) | yes, once (`activate`); on a full runner it is queued and starts in its turn |
| a thread waiting for a slot on the runner | suspends the idlest idle machine there at once (the idle round), never a busy one |
| a message (UI prompt, OptChat `tell`, an artifact comment) | a new one wakes a sleeping machine, and gives a thread whose start failed one more try; a replayed one (a request id the agent already has) wakes nothing |
| a guest call of the agent's run, a portal connection | yes (`Conversations.wake`, the guest transport's `before`; the portal's `wake`); on a full runner it waits for a slot up to 30 min (`PATIENCE.wakeMs`), once: after that wait gave up, later calls try once and fail at once until the machine runs (whoever starts it) or a new message asks again |
| an archive's release check | only with a slot free now (`wakeNow`); otherwise the disk is kept unchecked at once, with the reason |
| the recovery loop (`Conversations.boot`, every 30 s) | only by `recoveryStep` (thread-recovery.ts) |
| any read: the thread list, history, stream, model, steps, startup log, diagnostics, OptChat's watcher, `threads`, `history` | never |

Conversations own every start and wake. A wake is the thread's activation;
a machine still asleep after it with no slot to wait for (an archive holds
the thread, a release is unfinished, or the activation's start failed) is
started directly, and that start's error answers the call. `RunnerMachines`
does the runner operations (start or resume, suspend, release) and never
decides to wake. One clock (`PATIENCE`, 30 min) bounds both waits for a
runner: a new thread's start on a VM runner that does not answer, and a
wake on a full runner. A wake's 30 minutes count from the end of cubed's
restart protection (`PATIENCE.restartMs`, the 32 minutes in which a machine
running from before may not be suspended, machine-idle.ts
`RESTART_GUARD_MS`): a wake on a full runner just after a restart keeps its
place until a slot can be freed at all, and waits at most 62 minutes, not
a time in which it cannot succeed (thread-queue-test Q7). A new thread in
the queue has no bound: it holds nothing and asks its runner nothing. A
close ends a wake that waits; a wake of a machine that runs asks the
runner nothing (cubed-wake-test).

A resume that restored the snapshot is the boot that was saved, also when
this process never saw that boot run (a cubed restart since the suspend):
an agent already open on it goes on, its run included (thread-queue-test
Q5, lifecycle-model-test seed 13; review B1). A machine its runner started
from its disk instead (`SnapshotDropped`) booted again, and its open agent
is closed and reopened. When a run of it waits for this very start (a
guest call's wake), the start first ends every wait for that wake, unsent,
whatever the call and whether or not it carries an abort signal (a new
workspace's `hello`, `exec`, `cancel`, Claude Code's close), then stops the
run (a Pi run ends `stopped`, a Claude Code turn `failed`), since the close
would wait for it and its commands went with the old boot; calls made from
then on reach the running machine under its current epoch (Q6, Q6b after a
restart, queue-claude-test C2; a restored snapshot: Q5, C1). A guest
call's wait for a wake also ends when the call itself is aborted.

`recoveryStep` is the recovery loop's rule:

- archived: nothing;
- after a failed try (`thread.retry`: how many in a row, when, why) the
  next waits 30 s, doubling to 30 min; a success clears the count;
- a release left unfinished: the release, only, for as long as it fails
  (an obligation, never given up);
- the start of a thread not ready yet whose VM runner does not answer
  waits: the thread says so. After 30 min of that (counted in this
  process, so a restart counts again) each try is a failed one, with the
  pauses and the limit below. A ready thread (checked, or reopened after a
  restart) and a thread on a host runner wait as long as it takes, and a
  wait for a slot on a full runner is not bounded: a slot frees when work
  ends;
- after 8 failed starts in a row (about an hour) the loop stops starting
  the thread; it shows as an error saying so, also after a restart, and a
  new message tries once more;
- a sleeping machine (`suspension` set): nothing while a start or wake of
  this process owns it; otherwise woken only when the agent has a stored
  run that did not finish (a Pi submission still queued or placed with no
  agent open: its run went out while the machine slept, then cubed
  stopped) and its pause is over and its starts did not stop; otherwise a
  `waking` is read back (also one a failed wake left), a `suspended` stays;
- a ready thread: its machine is checked (and started again when its
  runner restarted);
- a thread not ready yet: its machine is started or prepared.

An open agent's run wakes its machine itself, by its guest calls; a Claude
Code turn cut off by a stop is not continued at the reopen, so it needs
no wake.

## Archive timing

Each archive (the UI's, OptChat's `archive`, an API call: all go through
`Conversations.archive`) logs one line in cubed's log (journald), with its
outcome and the time of each phase it ran, in milliseconds:

```text
info threads archive thread=<id> outcome=archived disk=deleted reason=clean ms=454 queueMs=0 settleMs=0 agent=open agentMs=0 closeMs=1 wakeMs=0 checkMs=445 checkExecMs=143 checkWaitMs=300 releaseMs=6
```

`journalctl -u cubed | grep "threads archive"` lists them;
`grep thread=<id>` one thread's.

| field | what it covers |
|---|---|
| `outcome` | `archived`, `already` (archived before), `refused` (working, or its background agents run: nothing stopped), `failed` (at `warn`, with why) |
| `disk`, `reason` | `deleted` or `retained`, and the release check's (or the refusal's, the failure's) words, cut at 200 characters. Only on an archive that ended |
| `ms` | the whole archive, from the call to its answer |
| `queueMs` | waiting for another command on the thread (an earlier archive, a message) |
| `settleMs` | waiting for an activation under way (a start, or the reattach after a cubed restart) |
| `agent`, `agentMs` | the working check: `open` (asked), `opened` (opened for the check, e.g. after a restart), `unopened` (it could not open: the disk is kept), `down` (not opened) |
| `closeMs` | closing the thread's agents |
| `wake`, `wakeMs` | a sleeping machine: `woken` for the check (its runner's resume) or `kept unchecked` (no slot: no check, disk kept) |
| `checkMs`, `checkExecMs`, `checkWaitMs` | the release check: its command's `exec`, then the wait for its end (the script's run in the machine and the polls that saw it end) |
| `releaseMs` | `RunnerMachines.release`: a build machine's removal, then the runner's `machine_delete` (stopping the machine, removing or keeping the disk) |

A phase that did not run is not in the line. The runner does not report
how its `machine_delete` splits between stopping and removing, so
`releaseMs` is one number, and `wakeMs` includes the runner's restore.
OptChat's own work between the threads of one `archive` call (its store
commits, the stored-run read) is not in these lines: it is the gap between
one line and the next of the same call. An archive's line says where that
archive's time went; it does not say why a batch was slow (the 2 min a
batch of 20 took once is not explained by anything measured so far).

## Invariants

- I1 A read changes nothing on the runner.
- I2 A request id (a new thread, a message) is accepted once, and its
  replay changes nothing on the runner.
- I3 An archived thread's machine is never asked to run again.
- I4 The runner never holds more machines than the registry counts, and the
  registry never counts more than the runner's slots.
- I5 After a restart's first recovery round, no `waking` is left without
  an owner.
- I6 A restart wakes exactly the sleeping threads with a stored run that
  did not finish.
- I8 A start that keeps failing is tried at most 8 times by the recovery
  loop, plus once per new message; a release is retried until it succeeds.
- I9 An archive answers within seconds; it never waits for a slot.

- I10 Every reader of a thread says the same failure, state and wait.
- I12 The start failure cubed last told is the thread's start failure now.

`RunnerMachines.start` refuses an archived thread, whoever asks.

## Reading a thread

A reader does not rank a thread's facts itself. `threadCondition`
(thread-condition.ts) is the one ranking, over the row and what this process
knows (`Conversations.condition`: an archive, an activation, an open
agent, the last try's failure, a down agent, a wait for a runner):

```text
archived ▸ archiving (an archive, or an unfinished release) ▸ down ▸ starting
  ▸ failed (no agent goes on, or a wake failed) ▸ ready (agent open)
  ▸ waiting (for a runner) ▸ new ▸ ready
```

A failure is the last try's in this process, or else the row's
(`workspaceState` `failed`, which outlives a restart), also while a thread
is being archived. `down` says only why the agent is down: a failure or a
wait of its machine changes nothing until cubed restarts, so the watcher
reports it without "cubed keeps retrying".

A failure is data, `Failure { kind, text }` (thread-failure.ts): `allocation`
(making or preparing the machine), `release`, `start` (a later start, check
or wake, or a runner that stopped answering) or `down`. Its kind decides:
a `release` is retried until it succeeds (`releaseUnfinished`), and the web
prints an `allocation`'s error with its startup step (the row's
`failureKind`). Its text is what readers show, in the words cubed always
wrote. A row keeps only the text (`workspaceError`, `retry.error`), so an
older cubed reads it as before; `readFailure` is the one place stored text
becomes a kind again (thread-failure-test).

`starting`, `failed`,
`waiting` and `ready` carry the machine's sleep. Each
reader renders the condition with an exhaustive switch:

| condition | API row (`threadRow`) | `threads`, `history` | overview | start failure told (agent closed) |
|---|---|---|---|---|
| archiving | `ready`, or `error` with its failure | being archived | being archived | `archiving` |
| down | `error` | error: … | agent error | a failure, not retried |
| failed | `error` | error: …, or "waking it failed: …" | machine error | a failure |
| starting | `starting`, or `error` after a failed try | starting its machine … | starting | a failure, if a try failed |
| waiting | `starting` | starting its machine, … | waiting for a runner | a failure, unless it sleeps |
| ready | `ready`, or `error` after a later check | ready …, or its sleep | its stored run | its stored run |
| new | `ready` | not started | not started | its stored run |

The last column is `startFailureOf`: the fact Conversations tells OptChat
(`onStartFailure`) after each transition of the thread, when it changed. An
open agent has none unless it is down.

`ThreadReader` holds `condition`, not the facts it ranks, so code given a
reader cannot rank them again. The web labels the row's `state` with the
machine's sleep (packages/web/src/lib/thread-state.ts).

## Tests

- `packages/server/test/thread-lifecycle-test.ts`: `recoveryStep` over
  every kind of thread; deterministic restarts (R0–R2b); one slot: a wake
  waits for a new thread's slot (R4), archiving a sleeping thread on a full
  runner (R5), a runner fuller than the registry knows (R6); a failing
  start's 8 tries, its stop across restarts and a message's one more try
  (R7); a failing release retried until it succeeds (R8); a replayed
  message (R9); a failing wake (R10), which OptChat's reads and watcher
  report as failed (R13), also after a restart, one episode of failed
  tries in a row at a time (R13b); a run's guest calls on a full runner
  wait once, not once each (R11); a runner that does not answer (R12,
  R12b, R12c).
- `packages/server/test/thread-queue-test.ts`: Q5 to Q7 above; with no thread waiting
  nothing is suspended early; a new thread on a full runner is queued and
  the idlest machine suspended at once for it (Q1); an agent at work, a
  running command, a portal connection and a registered service are not
  (Q2); a wake waiting since before a new thread goes first, and the new
  thread is not starved (Q3); a queued thread refuses a message with its
  wait, keeps its place across a restart, is archived without its runner,
  and the oldest gets the freed slot (Q4).
- `packages/server/test/lifecycle-model-test.ts`: seeded random runs of
  creates (some whose machine can never be made), messages and their
  replays, reads, idle and recovery rounds, restarts (with wakes cut short)
  and archives (queued threads too), checking I1–I6 and I8–I14 after every
  step (I13: no slot goes to a thread while one that waited longer still
  waits; I14: no create fails while a runner exists; I4
  as: the runner holds no more than the registry counts, the registry no
  more than the slots; I10: the row, `threads`, `history` and the overview
  of each thread whose condition holds still while read; I11: the
  registry's SQL count is `holdsSlot`'s).
- `packages/server/test/archive-timing-test.ts`: one archive line each,
  with the phases it ran and no others, for a clean (deleted), a dirty
  (retained), a closed agent's, a woken and a kept-unchecked sleeping
  machine's, a queued second, a refused and a failed archive.
- `packages/server/test/thread-phase-test.ts`: every `PhaseEvent` against the
  table above, `archived` terminal, and through a real Registry the fields
  each event writes (those the old writers wrote), the slot freed on
  `released`, no write when nothing changes; (typecheck) no other writer.
- `packages/server/test/start-failure-publication-test.ts`: an archive
  tells a failing thread's start failure ended as it begins, before its
  release finishes; a listener that subscribed later in the same process is
  told a failure that came back; while a wake waits for a slot, what a
  listener was told is the start failure now between the wake's rounds.
- `packages/server/test/wake-guards-test.ts`: an idle round while a wake's
  start is under way suspends nothing; a call to a sleeping machine answers
  within a bound (the wake's own activation's guest calls do not wait for
  the wake).
- `packages/server/test/thread-failure-test.ts`: each failure kind's words,
  read back to its kind, in a row an older cubed reads; an older row's
  failed release still retried.
- `packages/server/test/thread-condition-test.ts`: every kind of
  condition, in the literal words of each reader (the API's row, `threads`,
  `history`, the overview and the watcher), with the cases where they
  disagreed before; `thread-down-test.ts` the same for a down agent through
  createCubed.
- `packages/server/test/machine-sleep-test.ts`: every `SleepEvent` from
  every sleep against the table above, the SQL slot rule against
  `holdsSlot` and the runner's summary through a real Registry, the
  persisted shape both ways, that a rename keeps a sleep written after its
  caller read the row, (typecheck) that neither `updateThreadVm` nor a
  whole-row write can set a sleep or its notice, and the queue's order
  across new threads, wakes and a reopened registry (T7).
- Both run over `lifecycle-fixture.ts`: the real Registry and the thread
  runtime createCubed builds (`thread-runtime.ts`: RunnerMachines,
  Conversations and the wake between them), a stand-in `berth vm` with
  berth's slot rules as its runner session, and the real guest helper.
  `cubed-wake-test.ts` runs wakes through createCubed itself over the same
  stand-in: a new message renews a run that gave up, a machine that ran
  (whoever started it) renews it too, a wake of a running machine is a
  no-op, an archive or a close ends a wake that waits. Not runner acceptance: `runner-vm-cubed-suspend-test.ts` runs a
  real `berth vm`.
