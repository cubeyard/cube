import type { ThreadSummary } from "./types.ts";

export const lampClass = (thread: ThreadSummary) => thread.state === "error" ? "on-red" : thread.state === "starting" ? "on-amber blink" : "on-green";
export const stateLabel = (thread: ThreadSummary) => thread.state === "error" ? "error" : thread.state === "starting" ? "starting the thread's machine" : null;
/** Composer and transcript copy while a thread's machine boots (minutes the first time). */
export const STARTING_TEXT = "starting the thread's machine…";
/** How the thread's machine was prepared, and a failed hook if any. */
export function machineLabel(thread: ThreadSummary): { text: string; title: string; failed: boolean } | null {
  const vm = thread.vm;
  if (!vm || thread.state === "starting") return null;
  const failed = Object.entries(vm.hooks ?? {}).filter(([, hook]) => hook.status === "failed");
  const seconds = vm.startup?.totalMs ? ` · ready in ${Math.round(vm.startup.totalMs / 1000)} s` : "";
  const source = vm.preparation?.source === "template" ? "from template" : "fresh machine";
  const title = [
    vm.preparation?.source === "template" ? `prepared by template ${vm.preparation.templateId ?? ""}` : vm.preparation?.reason ?? "booted from the base image",
    ...Object.entries(vm.hooks ?? {}).map(([name, hook]) => `${name}: ${hook.status}${hook.exitCode === undefined ? "" : ` (exit ${hook.exitCode})`}`),
    ...(failed.length ? ["logs: ~/.cache/cube/<hook>.log in the machine"] : []),
  ].join("\n");
  if (failed.length) return { text: `${failed.map(([name]) => name).join(", ")} failed`, title, failed: true };
  if (!vm.preparation) return null;
  return { text: `${source}${seconds}`, title, failed: false };
}
