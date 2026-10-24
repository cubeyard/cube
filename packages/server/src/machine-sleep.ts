/** A thread machine's sleep (`ThreadVm.suspension`, S-7a, P7-5): the one
 * place its transitions and its slot rule live (docs/thread-lifecycle.md).
 * `RunnerMachines` reports what happened as a `SleepEvent`; only
 * `Registry.applySleep` writes the result, in its IMMEDIATE transaction, with
 * the runner's summary. The persisted shape is the one cubed always wrote. */

/** Absent: the machine runs (or cubed has not suspended it). `suspended`:
 * saved to a file on its runner, no QEMU, holding no slot (B7-2).
 * `waking`: cubed resumes it and holds its slot; with `waiting`, it waits
 * for a free slot (a full runner) and holds none. */
export type MachineSleep =
  | { state: "suspended"; at: number; memoryBytes?: number }
  | { state: "waking"; at: number; memoryBytes?: number; waiting?: string };

/** What happened to the machine:
 * - `suspended`: its runner saved it (`machine_suspend` answered);
 * - `wakeAsked`: a start resumes it; the registry decides, in the same
 *   transaction as a new thread's placement, whether its slot is free;
 * - `slotTaken`: the runner was full after all (RESOURCE_EXHAUSTED): it
 *   waits, saying `waiting`, and holds no slot;
 * - `wakeDropped`: nothing goes on with the wake (a start that does not
 *   wait, or a `waking` no one owns after a restart): suspended again;
 * - `running`: its runner holds it, not suspended (a wake read back, or a
 *   start that found it running);
 * - `resumed`: `machine_start` resumed it (or started it from its disk:
 *   `notice` says so, and null clears an older one). */
export type SleepEvent =
  | { type: "suspended"; at: number; memoryBytes?: number }
  | { type: "wakeAsked"; waiting: string }
  | { type: "slotTaken"; waiting: string }
  | { type: "wakeDropped" }
  | { type: "running" }
  | { type: "resumed"; notice: { text: string; at: number } | null };

/** The sleep after `event`. `slotFree`: the runner has a slot for this
 * machine besides every other open thread's that holds one (asked only by
 * `wakeAsked`). A machine with no record yet (the runner holds it suspended
 * while the registry said it runs) counts as suspended since `now`. */
export function nextSleep(sleep: MachineSleep | undefined, event: SleepEvent, context: { now: number; slotFree: boolean }): MachineSleep | undefined {
  const saved = { at: sleep?.at ?? context.now, ...sleep?.memoryBytes ? { memoryBytes: sleep.memoryBytes } : {} };
  switch (event.type) {
    case "suspended": return { state: "suspended", at: event.at, ...event.memoryBytes ? { memoryBytes: event.memoryBytes } : {} };
    case "wakeAsked": return { state: "waking", ...saved, ...context.slotFree ? {} : { waiting: event.waiting } };
    case "slotTaken": return { state: "waking", ...saved, waiting: event.waiting };
    case "wakeDropped": return { state: "suspended", ...saved };
    case "running":
    case "resumed": return undefined;
  }
}

/** Why the machine waits for a free slot on its runner, or undefined. */
export const slotWait = (sleep: MachineSleep | undefined): string | undefined => sleep?.state === "waking" ? sleep.waiting : undefined;

/** Whether an open thread's machine holds one of its runner's slots: not a
 * suspended one (B7-2: it frees its slot; waking it needs one again), nor
 * one waiting for a free slot. One being woken holds it already: its QEMU
 * may be starting, and no other placement may count on that slot. */
export const holdsSlot = (sleep: MachineSleep | undefined): boolean => !sleep || (sleep.state === "waking" && sleep.waiting === undefined);

/** `holdsSlot` over a thread row's JSON `data`, for the registry's counts.
 * lifecycle-model-test (I11) and machine-sleep-test check that both agree. */
export const HOLDS_SLOT_SQL = `(json_extract(data, '$.vm.suspension') IS NULL
  OR (json_extract(data, '$.vm.suspension.state') = 'waking' AND json_extract(data, '$.vm.suspension.waiting') IS NULL))`;
