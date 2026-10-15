/** Thread machines on protocol-4 runners (runner-session.ts). On `berth
 * host` a thread's machine is the directory DIRECTORY/<vm id> on that host,
 * its commands run unsandboxed as the user who started the runner. On
 * `berth vm` it is a keel machine under QEMU: created with its size, and
 * started with its boot documents (vm-seed.ts `bootDocuments`) and its
 * egress policy (egress-policy.ts `policyFor`) every time. Either runner
 * reports the guest's readiness in its watch (cubed never polls the
 * guest's hello for it), and on `berth vm` what the keel agent last said
 * of itself (`GuestInfo`): why it is not ready, its build and its hooks.
 *
 * A thread is on such a runner only because it was started there by name:
 * it never moves, and while the runner is down it waits (RunnerWait). */
import path from "node:path";
import type { Duplex } from "node:stream";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { MachineStatus_Phase, Runner_Kind, type EgressPolicySchema, type GuestInfo, type Machine, type Runner, type SizeSchema } from "./gen/runner_pb.js";
import type { GuestTransport } from "./guest-ssh.ts";
import { createLogger, type Logger } from "./log.ts";
import { placement, type Registry, type Thread } from "./registry.ts";
import { machineKey, RunnerError, runnerSession, type MachineRef, type RunnerSession } from "./runner-session.ts";
import { currentMachineEpoch, nextMachineEpoch, readStartupLog, RunnerWait, vmSizes, type MachineStart, type StartOptions, type StartupLog, type ThreadMachines,
  type VmSizes } from "./vm.ts";
import { MachineEvents, safeText, type GuestAgent, type MachineEvidence } from "./vm-diagnostics.ts";
import { bootDocuments, MAX_BOOT_BYTES } from "./vm-seed.ts";

/** How long a machine's guest has to report ready in the runner's watch. */
const READY_TIMEOUT_MS = 2 * 60 * 1000;
/** The most of a runner's diagnosis cubed keeps (berth vm's own bound). */
const MAX_DIAGNOSIS_BYTES = 256 * 1024;
/** The longest reason for a guest that is not ready cubed shows. */
const MAX_REASON = 512;
/** keel's hooks (hooks.rs `HOOKS`), the only names a guest's outcomes are shown for. */
const HOOK_NAMES = ["pre-setup", "setup", "pre-resume", "resume"];

/** Why the guest is not ready, as the runner last reported it; null when it is. */
function notReady(guest: GuestInfo | undefined): string | null {
  if (!guest) return "the runner has not reported the machine's guest";
  const reason = safeText(guest.reason, MAX_REASON);
  if (!guest.connected) return `the runner could not ask the guest${reason ? `: ${reason}` : ""}`;
  return guest.ready ? null : reason || "the guest gave no reason";
}

/** What the agent said of itself, each field bounded; null before it said
 * anything. Its hooks are as of its last status (keel sends one after
 * `machine_setup`): a hook that ran since shows at the next one. */
function guestAgent(guest: GuestInfo): GuestAgent | null {
  if (!guest.connected || (!guest.version && !guest.bootId)) return null;
  const hooks = Object.fromEntries(HOOK_NAMES.filter(name => guest.hooks[name] !== undefined).map(name => [name, safeText(guest.hooks[name]!, 32)]));
  return { version: safeText(guest.version, 64), build: /^[0-9a-f]{64}$/.test(guest.build) ? guest.build : "", kernel: safeText(guest.kernel, 128),
    bootId: safeText(guest.bootId, 64), hooks };
}

export interface RunnerMachinesOptions {
  registry: Registry;
  /** CUBED_STATE/threads: each thread's epoch lives in `<id>/vm`. */
  threads: string;
  log?: Logger;
  /** Tests: the session for a runner admission. */
  session?: (admission: { configPath: string; configHash: string }) => RunnerSession;
  /** The egress policy a VM runner enforces for a thread's machine. */
  policy?: { policyFor(thread: Thread): MessageInitShape<typeof EgressPolicySchema> };
  /** A VM runner's machine size when the project names none (default: vmSizes()). */
  sizes?: VmSizes;
  /** Tests: how long a guest has to report ready (default READY_TIMEOUT_MS). */
  readyTimeoutMs?: number;
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
  /** The thread's runner as enrolled is `berth vm` (its hello said VM). */
  private onVm(thread: Thread): boolean { return this.options.registry.getRunner(thread.runnerId)?.kind === "vm"; }

  /** The project's size when the thread was created, else cubed's, within
   * the runner's limits. */
  private size(thread: Thread, runner: Runner): MessageInitShape<typeof SizeSchema> {
    const sizes = this.options.sizes ?? vmSizes();
    const within = (wanted: number, limit: number | undefined) => limit ? Math.min(wanted, limit) : wanted;
    return { vcpus: within(thread.allocation.machine?.vcpus ?? sizes.vcpus, runner.limits?.maxVcpus),
      memoryMib: within(thread.allocation.machine?.memoryMiB ?? sizes.memoryMiB, runner.limits?.maxMemoryMib),
      diskGib: within(sizes.diskGiB, runner.limits?.maxDiskGib) };
  }

  /** What `machine_start` carries to a VM runner, every time: the size, the
   * boot documents and the policy, its default and lease explicit. A host
   * runner gets none of it. */
  private vmStart(thread: Thread, runner: Runner, size: MessageInitShape<typeof SizeSchema>) {
    if (!this.options.policy) throw new Error("this cubed has no egress policy for protocol-4 VM runners");
    const vm = thread.vm!;
    const documents = bootDocuments({ vmId: vm.vmId, placeholders: vm.placeholders, ...(thread.allocation.hooks ? { hooks: thread.allocation.hooks } : {}) },
      runner.limits?.maxBootBytes || MAX_BOOT_BYTES);
    return { size, boot: { documents, mac: "" }, policy: this.options.policy.policyFor(thread) };
  }

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
      + (this.onVm(thread) ? "" : "(a host runner runs only while someone runs berth host)"), { cause: error });
  }

  private async boot(thread: Thread, options: StartOptions): Promise<MachineStart> {
    const session = this.session(thread);
    const ref = this.ref(thread);
    const node = session.nodeId;
    try {
      await session.hello();
      const runner = session.runner!;
      const vm = runner.kind === Runner_Kind.VM;
      if (!vm && runner.kind !== Runner_Kind.HOST) throw new Error(`runner ${node} is a protocol-4 runner of a kind this cubed does not know`);
      const what = vm ? "VM runner" : "host runner";
      const size = vm ? this.size(thread, runner) : undefined;
      const start = vm ? this.vmStart(thread, runner, size!) : {};
      let machine: Machine;
      let created = false;
      try { machine = await session.machine({ case: "machineGet", value: { ref } }); }
      catch (error) {
        if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw error;
        options.onBoot?.();
        this.options.registry.beginStartupStep(thread.id, { name: "boot", detail: vm
          ? `a keel machine on VM runner ${node}: ${size!.vcpus} vCPU, ${size!.memoryMib} MiB memory, ${size!.diskGib} GiB disk`
          : `a directory on host runner ${node}, unsandboxed` });
        this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional"], "requested");
        created = true;
        machine = await this.step(thread, () => session.machine({ case: "machineCreate",
          value: { ref, fence: this.fence(thread), spec: { source: { case: "base", value: true }, ...(size ? { size } : {}) } } }));
        this.events.record(thread.id, "created", `machine ${ref.id} on ${what} ${node}`);
      }
      this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional", "requested"], "allocated");
      if (machine.status?.phase === MachineStatus_Phase.RETAINED) throw new Error(`the thread's machine on ${node} was released; its ${vm ? "disk" : "directory"} is kept there`);
      const startAndWait = async () => {
        await session.machine({ case: "machineStart", value: { ref, fence: this.fence(thread), ...start } });
        const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
        try { return await session.until(ref, current => current.status?.guest?.ready === true, timeout); }
        catch (error) {
          if (error instanceof RunnerError) throw error;
          // The runner's last word on the guest says why it did not get ready.
          const why = notReady(session.machines.get(machineKey(ref))?.status?.guest);
          throw new Error(`runner ${node}: the guest of machine ${ref.id} did not get ready in ${Math.round(timeout / 1000)} s: ${why ?? "it is ready now"}`, { cause: error });
        }
      };
      const ready = created ? await this.step(thread, startAndWait) : await startAndWait();
      if (created) this.options.registry.endStartupStep(thread.id, { name: "boot", state: "ok" });
      const boot = ready.status?.bootId ?? "";
      const booted = this.boots.get(thread.id) !== boot;
      this.boots.set(thread.id, boot);
      if (booted) this.events.record(thread.id, "ready", `boot ${boot.slice(0, 8)} of ${what} ${node}`);
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

  /** A host runner keeps the machine's directory either way: it is
   * retained. A VM runner stops the machine first (STOP_TIMEOUT_MS), then
   * keeps its disk only when asked to (or after an interruption). */
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
    if (this.onVm(thread)) {
      try {
        const machine = await this.session(thread).machine({ case: "machineDiscard", value: { ref: this.ref(thread), fence: this.fence(thread) } });
        if (machine.status?.phase !== MachineStatus_Phase.DELETED) throw new Error(`runner ${node} did not discard the machine (${MachineStatus_Phase[machine.status?.phase ?? 0]})`);
      } catch (error) {
        if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw error;
      }
      this.events.record(thread.id, "discarded");
      return;
    }
    throw new Error(`host runner ${node} never deletes a machine's directory; remove ${thread.vm?.vmId ?? "it"} from its DIRECTORY on that host yourself`);
  }

  running(thread: Thread): boolean { return this.boots.has(thread.id); }

  /** The portal's connection to `port` of the thread's machine, at its
   * current epoch (as its guest calls), only while this process has it
   * running. The runner refuses ports below 1024 and a machine it does not
   * run; `berth host` has no dial (masterplan B-9). */
  async dial(thread: Thread, port: number): Promise<Duplex> {
    if (!this.running(thread)) throw new Error("the thread's machine is not running");
    return this.session(thread).dial(this.ref(thread), Math.max(1, currentMachineEpoch(this.directory(thread))), port);
  }

  /** The end of the log of the hook running now in a VM runner's machine,
   * read with keel's `read` at the current epoch (no lease, no new fence)
   * while this process has the machine running; null otherwise. A host
   * runner's logs are on that host (CUBE_LOGS): null. */
  async startupLog(thread: Thread): Promise<StartupLog | null> {
    // NEGATIVE CONTROL (never merged): no startup log, ever.
    void readStartupLog; void thread;
    return null;
  }

  /** What cubed knows of the machine: its events, the runner's last report
   * and, from a VM runner, its diagnosis (`machine_diagnose`: one bounded
   * JSON document the runner redacted; cubed cleans the bundle again) and
   * what the keel agent last said of itself in the watch. */
  async diagnose(thread: Thread): Promise<MachineEvidence> {
    const machine = thread.vm ? this.session(thread).machines.get(`${thread.id}/${thread.vm.vmId}`) : undefined;
    const guest = machine?.status?.guest;
    const error = guest ? notReady(guest) : null;
    const agent = guest && this.onVm(thread) ? guestAgent(guest) : null;
    return {
      cubed: { startInProgress: this.starting.has(thread.id), attached: this.boots.has(thread.id),
        lastGuestProbe: guest ? { at: Number(guest.since?.seconds ?? 0n) * 1000, ready: guest.ready, error } : null },
      events: this.events.read(thread.id),
      runner: this.onVm(thread) ? await this.runnerDiagnosis(thread)
        : { status: "unsupported", reason: "a host runner (protocol 4) has no machine diagnosis" },
      gateway: { status: "none", reason: "protocol 4 has no gateway" },
      guest: guest ? { status: "observed", at: Date.now(), ready: guest.ready, ms: 0, error, ...(agent ? { agent } : {}) }
        : { status: "none", reason: "the runner has not reported this machine's guest" },
    };
  }

  private async runnerDiagnosis(thread: Thread): Promise<MachineEvidence["runner"]> {
    if (!thread.vm || placement(this.options.registry.getThread(thread.id) ?? thread) === "provisional") {
      return { status: "none", reason: "the runner was never asked for this thread's machine" };
    }
    const started = Date.now();
    try {
      const result = await this.session(thread).call({ case: "machineDiagnose",
        value: { ref: this.ref(thread), fence: { epoch: BigInt(Math.max(1, currentMachineEpoch(this.directory(thread)))) } } });
      const unavailable = (reason: string) => ({ status: "unavailable" as const, at: Date.now(), reason });
      if (result.case !== "diagnosis") return unavailable(`the runner answered ${result.case} to machine_diagnose`);
      if (Buffer.byteLength(result.value.json) > MAX_DIAGNOSIS_BYTES) return unavailable(`the runner's diagnosis is over ${MAX_DIAGNOSIS_BYTES} bytes`);
      const diagnosis = JSON.parse(result.value.json) as unknown;
      if (!diagnosis || typeof diagnosis !== "object" || Array.isArray(diagnosis)) return unavailable("the runner's diagnosis is not a JSON object");
      return { status: "observed", at: Date.now(), method: "machine_diagnose", ms: Date.now() - started, diagnosis: diagnosis as Record<string, unknown> };
    } catch (error) {
      if (error instanceof RunnerError && error.code === "NOT_FOUND") return { status: "none", at: Date.now(), reason: "the runner has no machine for this thread" };
      return { status: "unavailable", at: Date.now(), reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {}
}
