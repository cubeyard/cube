/** The one place cubed chooses between runner protocols, by the protocol a
 * runner was enrolled with: protocol 3 (`cubeyard/node/1`, VM runners,
 * ThreadVms over SSH and cube-gateway) or protocol 4 (`cubeyard/runner/4`,
 * RunnerMachines over one RunnerSession; today `cube-runner host` only).
 * Threads on a protocol-3 runner stay on protocol 3. */
import type net from "node:net";
import { Runner_Kind, Runner_Lifecycle } from "./gen/runner_pb.js";
import type { GuestTransport } from "./guest-ssh.ts";
import { runnerClient, type TrustedRunnerHealth } from "./iroh-node.ts";
import type { Registry, Runner, Thread } from "./registry.ts";
import { closeRunnerSessions, runnerSession } from "./runner-session.ts";
import type { MachineStart, StartOptions, StartupLog, ThreadMachines } from "./vm.ts";
import type { MachineEvidence } from "./vm-diagnostics.ts";

export function runnerProtocol(runner: Pick<Runner, "protocol">): 3 | 4 { return runner.protocol === 4 ? 4 : 3; }

const LIFECYCLES: Record<number, TrustedRunnerHealth["lifecycle"]> = {
  [Runner_Lifecycle.READY]: "ready", [Runner_Lifecycle.DRAINING]: "draining",
  [Runner_Lifecycle.FAULTED]: "faulted", [Runner_Lifecycle.RECOVERY_REQUIRED]: "recoveryRequired",
};

/** A runner's status as placement and the system page read it. */
export async function runnerHealth(runner: Runner): Promise<TrustedRunnerHealth> {
  if (runnerProtocol(runner) === 3) return runnerClient(runner).health();
  const hello = await runnerSession(runner).hello();
  const described = hello.runner!;
  const capacity = described.capacity;
  const lifecycle = LIFECYCLES[described.lifecycle] ?? "faulted";
  return {
    lifecycle, draining: lifecycle === "draining", error: null,
    activeVms: capacity?.machinesActive ?? 0, runningVms: capacity?.machinesRunning ?? 0,
    maxActiveVms: Math.max(1, described.limits?.maxMachines ?? 1),
    retainedVms: capacity?.retained ?? 0, retainedBytes: Number(capacity?.retainedBytes ?? 0n),
    softwareVersion: described.softwareVersion, protocolVersion: 4,
    kind: described.kind === Runner_Kind.HOST ? "host" : "vm",
    platform: [described.platform?.os, described.platform?.arch].filter(Boolean).join("-"),
    capabilities: hello.capabilities,
  };
}

/** ThreadMachines that hands each thread to its runner's protocol. */
export class ProtocolMachines implements ThreadMachines {
  private readonly registry: Registry;
  private readonly p3: ThreadMachines;
  private readonly p4: ThreadMachines;
  constructor(options: { registry: Registry; p3: ThreadMachines; p4: ThreadMachines }) {
    this.registry = options.registry;
    this.p3 = options.p3;
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
  dial(thread: Thread, port: number): Promise<net.Socket> {
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
    await Promise.allSettled([this.p3.close(), this.p4.close()]);
    await closeRunnerSessions();
  }
}
