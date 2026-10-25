# Thread lifecycle

A thread has four lifecycles, each with one source of truth. Code that
changes one names its owner here; a test that checks one is listed under
[Tests](#tests).

| Lifecycle | Truth | cubed keeps | Owner of the transitions |
|---|---|---|---|
| Thread | the registry (`workspaceState`, `archived`) | persisted | `Conversations` (`ensureWorkspace`, `archive`, `release`) |
| Machine | the runner's phase | `vm.suspension`, `vm.placement` (a mirror and a slot reservation) | `RunnerMachines`; the sleep's transitions are `machine-sleep.ts`, written only by `Registry.applySleep` |
| Agent | this process (`agents`, `claudes`, `downs`) | nothing; runs are in the agent's own store | `Conversations` |
| Report | OptChat's Pi store, by request id `report:<thread>:<run>` | persisted | `OptChat` |

## Thread

```text
(new) ─createThread (takes a slot)─▶ allocating ─ready─▶ available
allocating, failed ─a try fails─▶ failed ─a try succeeds─▶ available
available, failed ─archive─▶ releasing ─finishRelease (frees the slot)─▶ archived
releasing ─release fails─▶ failed ("workspace release failed: …") ─retried─▶ archived
```

`archived` is terminal: nothing starts, wakes or calls its machine again;
only its retained disk can be discarded.

## Machine

```text
(none) ─create + start─▶ running ─idle 5 min, nothing busy─▶ suspended
suspended ─a start─▶ waking ─the runner resumes it─▶ running
waking ─runner full─▶ waking + waiting ─a later try─▶ waking
running ─the runner restarts─▶ stopped ─recovery's check─▶ running
running, suspended ─archive─▶ released (deleted, or retained with a reason)
```

cubed records only `suspension` (`suspended`, `waking`, `waking` +
`waiting`); running, starting and suspending live in this process.
`RunnerMachines` reports what happened as one `SleepEvent`, and
`nextSleep` (`machine-sleep.ts`) is the whole table of what follows:

| event | from any sleep, or none | holds a slot |
|---|---|---|
| `suspended` (the runner saved it) | `suspended`, at that time | no |
| `wakeAsked` (a start resumes it) | `waking`, or `waking` + `waiting` with no slot free | without `waiting` |
| `slotTaken` (the runner was full after all) | `waking` + `waiting` | no |
| `wakeDropped` (nothing goes on with the wake) | `suspended`, as saved | no |
| `running`, `resumed` (with its notice) | none: it runs | yes |

`Registry.applySleep` is the only writer: it applies the event in one
IMMEDIATE transaction with the runner's summary, so a sleep cannot be
written in a combination the table lacks (`suspended` with `waiting`), or
without its slot counted. Its notice changes only with `resumed`. No other
registry write sets either: `updateThreadVm` takes neither, and none writes
a whole row from a caller's copy (a title changes by `renameThread`, which
reads the row in its own transaction). `holdsSlot` is the slot rule, and
`HOLDS_SLOT_SQL` the same rule for the registry's counts
(machine-sleep-test, lifecycle-model-test I11). `waking` without `waiting` holds a slot. It is a
reservation, taken like a new thread's (`wakeAsked`, in one
IMMEDIATE transaction that counts every other open thread holding a slot on
the runner): with none free the thread is `waking` + `waiting` and the runner
is not asked, so a wake never takes the slot of a thread whose machine is
not created yet. A runner that refuses a slot all the same (another cubed, a
lowered bound) makes a wake wait the same way, and a new machine wait
(`RunnerWait`, its boot step `interrupted`), not fail. There is no queue:
the first try after a slot frees gets it. The reservation is for a wake this
process runs, never a wish: a `waking` that no
start or wake of this process owns (a restart cut it short) is read back
from the runner (`RunnerMachines.settleWake`) and recorded as the runner's
phase, `suspended` or running. It is not continued.

## Who may start or wake a machine

| Trigger | Starts or wakes |
|---|---|
| a new thread (UI, OptChat `spawn`) | yes, once (`activate`) |
| a message (UI prompt, OptChat `tell`, an artifact comment) | a new one wakes a sleeping machine, and gives a thread whose start failed one more try; a replayed one (a request id the agent already has) wakes nothing |
| a guest call of the agent's run, a portal connection | yes (`awake` → `wake`); on a full runner it waits for a slot up to 30 min, once: after that wait gave up, later calls try once and fail at once until the machine runs or a new message asks again (`renewWake`) |
| an archive's release check | only with a slot free now (`wakeNow`); otherwise the disk is kept unchecked at once, with the reason |
| the recovery loop (`Conversations.boot`, every 30 s) | only by `recoveryStep` (thread-recovery.ts) |
| any read: the thread list, history, stream, model, steps, startup log, diagnostics, OptChat's watcher, `threads`, `history` | never |

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

| condition | API row (`threadRow`) | `threads`, `history` | overview | watcher, agent closed |
|---|---|---|---|---|
| archiving | `ready`, or `error` with its failure | being archived | being archived | `archiving` |
| down | `error` | error: … | agent error | a failure, not retried |
| failed | `error` | error: …, or "waking it failed: …" | machine error | a failure |
| starting | `starting`, or `error` after a failed try | starting its machine … | starting | a failure, if a try failed |
| waiting | `starting` | starting its machine, … | waiting for a runner | a failure, unless it sleeps |
| ready | `ready`, or `error` after a later check | ready …, or its sleep | its stored run | its stored run |
| new | `ready` | not started | not started | its stored run |

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
- `packages/server/test/lifecycle-model-test.ts`: seeded random runs of
  creates (some whose machine can never be made), messages and their
  replays, reads, idle and recovery rounds, restarts (with wakes cut short)
  and archives, checking I1–I6 and I8–I11 after every step (I4
  as: the runner holds no more than the registry counts, the registry no
  more than the slots; I10: the row, `threads`, `history` and the overview
  of each thread whose condition holds still while read; I11: the
  registry's SQL count is `holdsSlot`'s).
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
  caller read the row, and (typecheck) that neither `updateThreadVm` nor a
  whole-row write can set a sleep or its notice.
- Both run over `lifecycle-fixture.ts`: the real Registry and the thread
  runtime createCubed builds (`thread-runtime.ts`: RunnerMachines,
  Conversations and the wake between them), a stand-in `berth vm` with
  berth's slot rules as its runner session, and the real guest helper.
  `cubed-wake-test.ts` runs a wake through createCubed itself over the same
  stand-in. Not runner acceptance: `runner-vm-cubed-suspend-test.ts` runs a
  real `berth vm`.
