/** Thread machines on protocol-4 runners (runner-session.ts). The only
 * protocol-4 runner today is `cube-runner host`: a thread's machine is the
 * directory DIRECTORY/<vm id> on that host, its commands run unsandboxed
 * as the user who started the runner, and the runner reports the guest's
 * readiness in its watch (cubed never polls the guest's hello for it).
 *
 * A thread is on such a runner only because it was started there by name:
 * it never moves, and while the runner is down it waits (RunnerWait). */
import path from "node:path";
import { MachineStatus_Phase, Runner_Kind, type Machine } from "./gen/runner_pb.js";
import type { GuestTransport } from "./guest-ssh.ts";
import { createLogger, type Logger } from "./log.ts";
import { placement, type Registry, type Thread } from "./registry.ts";
import { RunnerError, runnerSession, type MachineRef, type RunnerSession } from "./runner-session.ts";
import { currentMachineEpoch, nextMachineEpoch, RunnerWait, type MachineStart, type StartOptions, type ThreadMachines } from "./vm.ts";
import { MachineEvents, type MachineEvidence } from "./vm-diagnostics.ts";

/** How long a machine's guest has to report ready in the runner's watch. */
const READY_TIMEOUT_MS = 2 * 60 * 1000;

export interface RunnerMachinesOptions {
  registry: Registry;
  /** CUBED_STATE/threads: each thread's epoch lives in `<id>/vm`. */
  threads: string;
  log?: Logger;
  /** Tests: the session for a runner admission. */
  session?: (admission: { configPath: string; configHash: string }) => RunnerSession;
}

export class RunnerMachines implements ThreadMachines {
  private readonly options: RunnerMachinesOptions;
  private readonly log: Logger;
  private readonly events: MachineEvents;
  /** The runner boot each thread's machine was last started in. */
  private readonly boots = new Map<string, string>();
  private readonly starting = new Map<string, Promise<MachineStart>>();

  constructor(options: RunnerMachinesOptions) {
    this.options = options;
    this.log = options.log ?? createLogger("runner-machines");
    this.events = new MachineEvents(options.threads);
  }

  private session(thread: Thread): RunnerSession {
    const admission = this.options.registry.runner(thread.id);
    if (!admission) throw new Error("thread runner allocation is missing");
    return (this.options.session ?? runnerSession)(admission);
  }
  private ref(thread: Thread): MachineRef {
    if (!thread.vm) throw new Error("thread has no machine");
    return { owner: thread.id, id: thread.vm.vmId };
  }
  private directory(thread: Thread): string { return path.join(this.options.threads, thread.id, "vm"); }
  private fence(thread: Thread) { return { epoch: BigInt(nextMachineEpoch(this.directory(thread))) }; }

  guest(thread: Thread): GuestTransport {
    const directory = this.directory(thread);
    return this.session(thread).guest(this.ref(thread), () => Math.max(1, currentMachineEpoch(directory)));
  }

  start(thread: Thread, options: StartOptions = {}): Promise<MachineStart> {
    const pending = this.starting.get(thread.id);
    if (pending) return pending;
    const starting = this.boot(thread, options).finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, starting);
    return starting;
  }

  /** A failure that only means the runner is not there now: the thread waits. */
  private waitFor(thread: Thread, error: unknown): unknown {
    if (!(error instanceof RunnerError && error.code === "UNAVAILABLE")) return error;
    const node = this.options.registry.getRunner(thread.runnerId)?.nodeId ?? thread.runnerId;
    return new RunnerWait(`waiting for runner ${node}: it does not answer; this thread was started on it by name and stays there `
      + "(a host runner runs only while someone runs cube-runner host)", { cause: error });
  }

  private async boot(thread: Thread, options: StartOptions): Promise<MachineStart> {
    const session = this.session(thread);
    const ref = this.ref(thread);
    const node = session.nodeId;
    try {
      await session.hello();
      if (session.runner?.kind !== Runner_Kind.HOST) {
        throw new Error(`runner ${node} is a protocol-4 VM runner; this cubed runs threads only on protocol-4 host runners`);
      }
      let machine: Machine;
      let created = false;
      try { machine = await session.machine({ case: "machineGet", value: { ref } }); }
      catch (error) {
        if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw error;
        options.onBoot?.();
        this.options.registry.beginStartupStep(thread.id, { name: "boot", detail: `a directory on host runner ${node}, unsandboxed` });
        this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional"], "requested");
        created = true;
        machine = await this.step(thread, () => session.machine({ case: "machineCreate", value: { ref, fence: this.fence(thread), spec: { source: { case: "base", value: true } } } }));
        this.events.record(thread.id, "created", `machine ${ref.id} on host runner ${node}`);
      }
      this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional", "requested"], "allocated");
      if (machine.status?.phase === MachineStatus_Phase.RETAINED) throw new Error(`the thread's machine on ${node} was released; its directory is kept there`);
      const startAndWait = async () => {
        await session.machine({ case: "machineStart", value: { ref, fence: this.fence(thread) } });
        return session.until(ref, current => current.status?.guest?.ready === true, READY_TIMEOUT_MS);
      };
      const ready = created ? await this.step(thread, startAndWait) : await startAndWait();
      if (created) this.options.registry.endStartupStep(thread.id, { name: "boot", state: "ok" });
      const boot = ready.status?.bootId ?? "";
      const booted = this.boots.get(thread.id) !== boot;
      this.boots.set(thread.id, boot);
      if (booted) this.events.record(thread.id, "ready", `boot ${boot.slice(0, 8)} of host runner ${node}`);
      return { booted };
    } catch (error) {
      const failure = this.waitFor(thread, error);
      this.events.record(thread.id, failure instanceof RunnerWait ? "waiting for a runner" : "start failed", failure);
      throw failure;
    }
  }

  /** Ends the thread's `boot` step as failed when `work` fails. */
  private async step<T>(thread: Thread, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      this.options.registry.endStartupStep(thread.id, { name: "boot", state: "failed", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** The runner keeps the machine's directory either way: it is retained. */
  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    this.boots.delete(thread.id);
    if (placement(this.options.registry.getThread(thread.id) ?? thread) === "provisional") return { retained: false };
    try {
      const machine = await this.session(thread).machine({ case: "machineDelete", value: { ref: this.ref(thread), fence: this.fence(thread), retain } });
      this.log.info("released", { thread: thread.id, phase: MachineStatus_Phase[machine.status?.phase ?? 0] });
      return { retained: machine.status?.phase === MachineStatus_Phase.RETAINED };
    } catch (error) {
      if (error instanceof RunnerError && error.code === "NOT_FOUND") return { retained: false };
      throw error;
    }
  }

  async discard(thread: Thread): Promise<void> {
    const node = this.options.registry.getRunner(thread.runnerId)?.nodeId ?? thread.runnerId;
    throw new Error(`host runner ${node} never deletes a machine's directory; remove ${thread.vm?.vmId ?? "it"} from its DIRECTORY on that host yourself`);
  }

  running(thread: Thread): boolean { return this.boots.has(thread.id); }

  /** What cubed knows of the machine: its events and the runner's last report. */
  async diagnose(thread: Thread): Promise<MachineEvidence> {
    const machine = thread.vm ? this.session(thread).machines.get(`${thread.id}/${thread.vm.vmId}`) : undefined;
    const guest = machine?.status?.guest;
    return {
      cubed: { startInProgress: this.starting.has(thread.id), attached: this.boots.has(thread.id),
        lastGuestProbe: guest ? { at: Number(guest.since?.seconds ?? 0n) * 1000, ready: guest.ready, error: null } : null },
      events: this.events.read(thread.id),
      runner: { status: "unsupported", reason: "a host runner (protocol 4) has no machine diagnosis" },
      gateway: { status: "none", reason: "protocol 4 has no gateway" },
      guest: guest ? { status: "observed", at: Date.now(), ready: guest.ready, ms: 0, error: guest.connected ? null : "the runner could not ask the guest" }
        : { status: "none", reason: "the runner has not reported this machine's guest" },
    };
  }

  async close(): Promise<void> {}
}
