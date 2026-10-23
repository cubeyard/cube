import type { ThreadSummary } from "./types.ts";

/** The machine is suspended (idle; it holds no slot) or being woken; a
 * full runner makes it wait, and the label says so (P7-5, B7-2). */
const suspension = (thread: ThreadSummary) => thread.state === "error" ? null : thread.vm?.suspension ?? null;
/** A wake says what it waits for, also while each try starts the machine
 * again (the API says `starting` then), so the label does not flicker. */
export const stateLabel = (thread: ThreadSummary) => {
  if (thread.state === "error") return "error";
  const suspended = suspension(thread);
  if (suspended?.state === "waking") return suspended.waiting ? "waiting for a free slot" : "waking the thread's machine";
  if (thread.state === "starting") return "starting the thread's machine";
  if (suspended) return "suspended";
  return null;
};
/** Whether the strip's label is about the machine's sleep (it stays in
 * print on a phone, with the details closed). */
export const sleepState = (thread: ThreadSummary) => !!suspension(thread);
/** B7-5: what the user should know about the machine (it started again
 * from its disk), shown once it runs. */
export const machineNotice = (thread: ThreadSummary) => thread.vm?.suspension ? null : thread.vm?.notice?.text ?? null;
/** Composer and transcript copy while a thread's machine boots (minutes the first time). */
export const STARTING_TEXT = "starting the thread's machine…";
/** What the composer waits for, or null: a start, a wake, or a free slot
 * (a message then would wait unseen). A suspended machine takes messages:
 * one wakes it. */
export const composerWaiting = (thread: ThreadSummary | null | undefined): string | null => {
  if (!thread) return null;
  const suspended = suspension(thread);
  if (suspended?.state === "waking") return suspended.waiting ? "waiting for a free slot…" : "waking the thread's machine…";
  return thread.state === "starting" ? STARTING_TEXT : null;
};
/** How the thread's machine was prepared, and a failed hook if any. */
export function machineLabel(thread: ThreadSummary): { text: string; title: string; failed: boolean } | null {
  const vm = thread.vm;
  if (!vm || thread.state === "starting") return null;
  const failed = Object.entries(vm.hooks ?? {}).filter(([, hook]) => hook.status === "failed");
  const seconds = vm.startup?.totalMs ? ` · ready in ${Math.round(vm.startup.totalMs / 1000)} s` : "";
  const source = vm.preparation?.source === "template" ? "from template" : "fresh machine";
  const title = [
    vm.preparation?.source === "template" ? `prepared by template ${vm.preparation.templateId ?? ""}` : vm.preparation?.reason ?? "booted from the base image",
    ...(vm.preparation?.sealFailure ? [`the template's seal failed (${vm.preparation.sealFailure}); it was removed`] : []),
    ...Object.entries(vm.hooks ?? {}).map(([name, hook]) => `${name}: ${hook.status}${hook.exitCode === undefined ? "" : ` (exit ${hook.exitCode})`}`),
    ...(failed.length ? ["logs: ~/.cache/cube/<hook>.log in the machine"] : []),
  ].join("\n");
  if (failed.length) return { text: `${failed.map(([name]) => name).join(", ")} failed`, title, failed: true };
  if (!vm.preparation) return null;
  return { text: `${source}${seconds}`, title, failed: false };
}
