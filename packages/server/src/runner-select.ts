/** The one place cubed tells runner protocols apart, by the protocol a
 * runner was enrolled with. cubed runs protocol 4 (`cubeyard/runner/4`,
 * RunnerMachines over one RunnerSession: `berth vm` and `berth host`) only.
 * A runner enrolled with protocol 3 (`cube-runner`, retired) keeps its
 * registry row, its threads and their history, but is never contacted or
 * placed on again: its threads' machines refuse to start, archive without
 * contacting it, and leave any disk on that runner's host
 * (docs/runner-operations.md). */
import type { Duplex } from "node:stream";
import { Runner_Kind, Runner_Lifecycle } from "./gen/runner_pb.js";
import { GuestTransportError, type GuestTransport } from "./guest-transport.ts";
import { placement, type Registry, type Runner, type Thread } from "./registry.ts";
import { closeRunnerSessions, runnerSession } from "./runner-session.ts";
import type { TrustedRunnerHealth } from "./runner-types.ts";
import type { MachineStart, StartOptions, StartupLog, ThreadMachines } from "./vm.ts";
import type { MachineEvidence } from "./vm-diagnostics.ts";

export function runnerProtocol(runner: Pick<Runner, "protocol">): 3 | 4 { return runner.protocol === 4 ? 4 : 3; }

/** What a protocol-3 runner's thread says instead of contacting it. */
export const PROTOCOL_3_RETIRED = "this thread's runner uses protocol 3 (cube-runner), which cube no longer runs; "
  + "its history stays readable, its machine is not started again, and any disk it kept stays on that runner's host";

/** What a check of a protocol-3 runner records instead of contacting it. */
export const PROTOCOL_3_UNSUPPORTED = "UNSUPPORTED: protocol 3 (cube-runner) is no longer supported; cubed does not contact this runner";

const LIFECYCLES: Record<number, TrustedRunnerHealth["lifecycle"]> = {
  [Runner_Lifecycle.READY]: "ready", [Runner_Lifecycle.DRAINING]: "draining",
  [Runner_Lifecycle.FAULTED]: "faulted", [Runner_Lifecycle.RECOVERY_REQUIRED]: "recoveryRequired",
};

/** A runner's status as placement and the system page read it. A
 * protocol-3 runner is refused without contact. */
export async function runnerHealth(runner: Runner): Promise<TrustedRunnerHealth> {
  if (runnerProtocol(runner) === 3) throw new Error(PROTOCOL_3_UNSUPPORTED);
  const hello = await runnerSession(runner).hello();
  const described = hello.runner!;
  const capacity = described.capacity;
  const lifecycle = LIFECYCLES[described.lifecycle] ?? "faulted";
  const bounds = described.limits;
  const limits = bounds && bounds.maxVcpus > 0 && bounds.maxMemoryMib > 0
    ? { limits: { maxVcpus: bounds.maxVcpus, maxMemoryMiB: bounds.maxMemoryMib, maxDiskGiB: bounds.maxDiskGib } } : {};
  return {
    lifecycle, draining: lifecycle === "draining", error: null,
    activeVms: capacity?.machinesActive ?? 0, runningVms: capacity?.machinesRunning ?? 0,
    maxActiveVms: Math.max(1, described.limits?.maxMachines ?? 1),
    retainedVms: capacity?.retained ?? 0, retainedBytes: Number(capacity?.retainedBytes ?? 0n),
    softwareVersion: described.softwareVersion, protocolVersion: 4,
    kind: described.kind === Runner_Kind.HOST ? "host" : "vm",
    platform: [described.platform?.os, described.platform?.arch].filter(Boolean).join("-"),
    capabilities: hello.capabilities,
    ...limits,
  };
}

/** The machines of threads on a protocol-3 runner: nothing is contacted.
 * A start, a guest call, a diagnosis and a discard are refused with
 * PROTOCOL_3_RETIRED; a release (the end of an archive) succeeds at once
 * and counts the disk of a machine that was allocated as kept. */
export class RetiredProtocolMachines implements ThreadMachines {
  guest(): GuestTransport {
    return { call: () => Promise.reject(new GuestTransportError(PROTOCOL_3_RETIRED)), close: () => Promise.resolve() };
  }
  start(): Promise<MachineStart | void> { return Promise.reject(new Error(PROTOCOL_3_RETIRED)); }
  release(thread: Thread): Promise<{ retained: boolean }> {
    return Promise.resolve({ retained: !!thread.vm && placement(thread) !== "provisional" && !thread.vm.discarded });
  }
  discard(): Promise<void> { return Promise.reject(new Error(PROTOCOL_3_RETIRED)); }
  running(): boolean { return false; }
  diagnose(): Promise<MachineEvidence> { return Promise.reject(new Error(PROTOCOL_3_RETIRED)); }
  async startupLog(): Promise<StartupLog | null> { return null; }
  async close(): Promise<void> {}
}

/** ThreadMachines that hands each thread to its runner's protocol. */
export class ProtocolMachines implements ThreadMachines {
  private readonly registry: Registry;
  private readonly p3 = new RetiredProtocolMachines();
  private readonly p4: ThreadMachines;
  constructor(options: { registry: Registry; p4: ThreadMachines }) {
    this.registry = options.registry;
    this.p4 = options.p4;
  }
  private pick(thread: Thread): ThreadMachines {
    const runner = this.registry.runner(thread.id);
    return runner && runnerProtocol(runner) === 4 ? this.p4 : this.p3;
  }
  guest(thread: Thread): GuestTransport { return this.pick(thread).guest(thread); }
  start(thread: Thread, options?: StartOptions): Promise<MachineStart | void> { return this.pick(thread).start(thread, options); }
  async invalidateTemplate(thread: Thread, templateId: string): Promise<void> { await this.pick(thread).invalidateTemplate?.(thread, templateId); }
  release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> { return this.pick(thread).release(thread, retain); }
  discard(thread: Thread): Promise<void> { return this.pick(thread).discard(thread); }
  running(thread: Thread): boolean { return this.pick(thread).running?.(thread) ?? false; }
  suspended(thread: Thread): boolean { return this.pick(thread).suspended?.(thread) ?? false; }
  async suspendIfIdle(thread: Thread, busy: () => Promise<string | null>): Promise<boolean> {
    return (await this.pick(thread).suspendIfIdle?.(thread, busy)) ?? false;
  }
  async wake(thread: Thread): Promise<void> { await this.pick(thread).wake?.(thread); }
  touch(thread: Thread): void { this.pick(thread).touch?.(thread); }
  wakeInFlight(thread: Thread): boolean { return this.pick(thread).wakeInFlight?.(thread) ?? false; }
  async wakeNow(thread: Thread): Promise<string | null> { return (await this.pick(thread).wakeNow?.(thread)) ?? null; }
  async settleWake(thread: Thread): Promise<void> { await this.pick(thread).settleWake?.(thread); }
  dial(thread: Thread, port: number): Promise<Duplex> {
    const machines = this.pick(thread);
    if (!machines.dial) return Promise.reject(new Error("this thread's runner has no portal (dial)"));
    return machines.dial(thread, port);
  }
  diagnose(thread: Thread): Promise<MachineEvidence> {
    const machines = this.pick(thread);
    if (!machines.diagnose) return Promise.reject(new Error("this thread's runner reports no diagnostics"));
    return machines.diagnose(thread);
  }
  async startupLog(thread: Thread): Promise<StartupLog | null> { return (await this.pick(thread).startupLog?.(thread)) ?? null; }
  async close(): Promise<void> {
    await this.p4.close();
    await closeRunnerSessions();
  }
}
