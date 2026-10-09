/** How a thread's machine start reads: its steps (`vm.steps`) as labels and
 * durations, whether a step has run long, and whether the machine ran out
 * of memory (the one case where cube suggests a larger machine). */
import type { StartupStep, ThreadSummary } from "./types.ts";

const LABELS: Record<StartupStep["name"], string> = {
  lookup: "template",
  "build-boot": "template build · boot",
  "build-prepare": "template build · pre-setup and setup",
  "build-seal": "template build · seal",
  "build-publish": "template build · publish",
  boot: "boot",
  prepare: "prepare",
  resume: "resume",
};
/** A step's running hook writes the log the panel shows live. */
export const LOGGED_STEPS: ReadonlySet<StartupStep["name"]> = new Set(["build-prepare", "prepare", "resume"]);
/** A step running longer than this gets a note pointing at its log. */
export const LONG_STEP_MS = 5 * 60 * 1000;

export function stepLabel(step: StartupStep): string {
  return `${LABELS[step.name]}${step.attempt ? ` · try ${step.attempt}` : ""}`;
}

export function stepMs(step: StartupStep, now: number): number {
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

/** "0.4 s", "12 s", "3 min 05 s". */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** Bytes as GB with one decimal, MB below one GB, KB below one MB. */
export function size(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes >= 1024 * mib ? `${(bytes / (1024 * mib)).toFixed(1)} GB` : bytes >= mib ? `${Math.round(bytes / mib)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The lamp of a step: running blinks amber, ok is green, failed red, an
 * interrupted one an unlit lens. */
export function stepLamp(step: StartupStep): string {
  return step.state === "running" ? "on-amber blink" : step.state === "ok" ? "on-green" : step.state === "failed" ? "on-red" : "";
}

/** The newest step whose command the kernel stopped for want of memory. */
export function outOfMemory(steps: readonly StartupStep[]): StartupStep | null {
  return [...steps].reverse().find(step => (step.memory?.oomKills ?? 0) > 0 || /ran out of memory/.test(step.detail ?? "")) ?? null;
}

/** What the panel says about memory, or null when nothing ran out of it. */
export function memoryAdvice(steps: readonly StartupStep[]): string | null {
  const step = outOfMemory(steps);
  if (!step) return null;
  const used = step.memory ? ` (it used up to ${size(step.memory.peakBytes)}; the machine has ${size(step.memory.totalBytes)})` : "";
  return `the machine ran out of memory during ${stepLabel(step)}${used}. new threads get more memory once the project's machine size is raised.`;
}

/** A note for a step that has run long, or null. */
export function longStep(steps: readonly StartupStep[], now: number): string | null {
  const step = steps.findLast(candidate => candidate.state === "running");
  if (!step || stepMs(step, now) < LONG_STEP_MS) return null;
  return `${stepLabel(step)} has run for ${Math.floor(stepMs(step, now) / 60_000)} min${LOGGED_STEPS.has(step.name) ? "; its log below shows what it is doing" : ""}.`;
}

/** The panel shows itself while the machine starts and after a start that
 * failed; afterwards only when the reader opens it. */
export function startupShown(thread: Pick<ThreadSummary, "state" | "vm">): boolean {
  return !!thread.vm?.steps?.length && (thread.state === "starting" || thread.state === "error");
}

/** The time from the first step to the last one's end (or now). */
export function totalMs(steps: readonly StartupStep[], now: number): number {
  if (!steps.length) return 0;
  const end = steps.some(step => step.state === "running") ? now : Math.max(...steps.map(step => step.endedAt ?? step.startedAt));
  return Math.max(0, end - steps[0]!.startedAt);
}
