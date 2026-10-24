/** The thread side of cubed, wired in one place: each thread's machine
 * (RunnerMachines, on its runner's protocol), the Conversations over the
 * machines, and how a suspended machine wakes (the thread's activation).
 * createCubed and the lifecycle tests both build it here, so the tests run
 * the wiring cubed runs; they give only seams (the runner session, the
 * clock, timings) or, offline, machines of their own (local guests). */
import { Conversations, type ConversationsOptions } from "./conversation.ts";
import { RunnerMachines, type RunnerMachinesOptions } from "./runner-machines.ts";
import { ProtocolMachines } from "./runner-select.ts";
import type { ThreadMachines } from "./vm.ts";

/** What a caller sets of RunnerMachines: all but what the runtime wires. */
export type RunnerSeams = Omit<RunnerMachinesOptions, "registry" | "threads" | "now">;

export interface ThreadRuntimeOptions extends Omit<ConversationsOptions, "directory" | "machines"> {
  /** CUBED_STATE/threads: each thread's Pi store and machine epoch. */
  threads: string;
  /** Machines not on runners (offline tests' local guests); default: RunnerMachines. */
  machines?: ThreadMachines;
  runner?: RunnerSeams;
}

export interface ThreadRuntime { machines: ThreadMachines; conversations: Conversations }

export function threadRuntime(options: ThreadRuntimeOptions): ThreadRuntime {
  const { threads, machines: given, runner, ...conversation } = options;
  const p4 = given ? null : new RunnerMachines({ ...runner, registry: options.registry, threads, ...options.now ? { now: options.now } : {} });
  const machines = given ?? new ProtocolMachines({ registry: options.registry, p4: p4! });
  const conversations = new Conversations({ ...conversation, directory: threads, machines });
  // A suspended machine wakes by the thread's activation: a start, and the
  // resume hooks when its runner started it from its disk (P7-5).
  if (p4) p4.onWake = thread => conversations.activate(thread.id);
  return { machines, conversations };
}
