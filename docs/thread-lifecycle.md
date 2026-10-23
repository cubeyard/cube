# Thread lifecycle

A thread has four lifecycles, each with one source of truth. Code that
changes one names its owner here; a test that checks one is listed under
[Tests](#tests).

| Lifecycle | Truth | cubed keeps | Owner of the transitions |
|---|---|---|---|
| Thread | the registry (`workspaceState`, `archived`) | persisted | `Conversations` (`ensureWorkspace`, `archive`, `release`) |
| Machine | the runner's phase | `vm.suspension`, `vm.placement` (a mirror and a slot reservation) | `RunnerMachines` |
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
`waking` without `waiting` holds a slot (`HOLDS_SLOT`). It is a
reservation for a wake this process runs, never a wish: a `waking` that no
start or wake of this process owns (a restart cut it short) is read back
from the runner (`RunnerMachines.settleWake`) and recorded as the runner's
phase, `suspended` or running. It is not continued.

## Who may start or wake a machine

| Trigger | Starts or wakes |
|---|---|
| a new thread (UI, OptChat `spawn`) | yes, once (`activate`) |
| a message (UI prompt, OptChat `tell`, an artifact comment) | yes (`submit` → `wakeFor`) |
| a guest call of the agent's run, a portal connection | yes (`awake` → `wake`) |
| an archive's release check | yes |
| the recovery loop (`Conversations.boot`, every 30 s) | only by `recoveryStep` (thread-recovery.ts) |
| any read: the thread list, history, stream, model, steps, startup log, diagnostics, OptChat's watcher, `threads`, `history` | never |

`recoveryStep` is the recovery loop's rule:

- archived: nothing;
- a release left unfinished: the release, only;
- a sleeping machine (`suspension` set): nothing while a start or wake of
  this process owns it; otherwise woken only when the agent has a stored
  run that did not finish (a Pi submission still queued or placed with no
  agent open: its run went out while the machine slept, then cubed
  stopped); otherwise a `waking` is read back, a `suspended` stays;
- a ready thread: its machine is checked (and started again when its
  runner restarted);
- a thread not ready yet: its machine is started or prepared.

An open agent's run wakes its machine itself, by its guest calls; a Claude
Code turn cut off by a stop is not continued at the reopen, so it needs
no wake.

## Invariants

- I1 A read changes nothing on the runner.
- I2 A request id (a new thread, a message) is accepted once.
- I3 An archived thread's machine is never asked to run again.
- I4 The runner never holds more machines than its slots.
- I5 After a restart's first recovery round, no `waking` is left without
  an owner.
- I6 A restart wakes exactly the sleeping threads with a stored run that
  did not finish.

## Tests

- `packages/server/test/thread-lifecycle-test.ts`: `recoveryStep` over
  every kind of thread; deterministic restarts (R0–R2b).
- `packages/server/test/lifecycle-model-test.ts`: seeded random runs of
  creates, messages, reads, idle and recovery rounds, restarts (with wakes
  cut short) and archives, checking I1 and I3–I6 after every step.
- Both run over `lifecycle-fixture.ts`: the real Registry, RunnerMachines
  and Conversations, a stand-in `berth vm` with berth's slot rules, and the
  real guest helper. Not runner acceptance:
  `runner-vm-cubed-suspend-test.ts` runs a real `berth vm`.
