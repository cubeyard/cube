/** A thread's machine: one QEMU VM on the thread's runner, reached only
 * through cube-gateway. `ThreadVms` allocates and boots it, attaches it to
 * the gateway, waits until its guest helper answers ready, and releases it at
 * archive (retaining the disk of a thread whose agent changed anything or
 * whose work is not clean).
 *
 * Provisioning (the pinned repository checkouts) and the release check are
 * ordinary workspace commands under the thread's lease and fixed keys, so
 * they are journaled in the guest like every agent command. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { dialGuest, GatewayUnavailable, type GatewayAttach, type GatewayClient, type GatewaySupervisor } from "./gateway.ts";
import { SshGuestTransport, controlDirectory, type GuestTransport } from "./guest-ssh.ts";
import { IrohNodeError, runnerClient, type IrohRunnerClient, type RunnerDescription, type RunnerTemplate, type TrustedRunnerHealth, type VmRecord, type VmRef } from "./iroh-node.ts";
import { createLogger, type Logger } from "./log.ts";
import { NO_HOOKS, STEP_LOG_BYTES, placement, threadAgent, type CommandMemory, type HookOutcome, type Registry, type StartupStep, type Thread,
  type WorkspaceAllocation } from "./registry.ts";
import { newPlaceholder, type EgressVms } from "./egress-policy.ts";
import { guestDescription, VmWorkspace, type GuestPortal } from "./vm-workspace.ts";
import { GUEST_HELPER_PATH, shippedHelper, vmMac, vmSeed } from "./vm-seed.ts";
import { clean, MachineEvents, type Evidence, type MachineEvidence } from "./vm-diagnostics.ts";
import { FAILED_BUILD_BACKOFF_MS, TEMPLATE_CAPABILITY, TEMPLATE_FORMAT, missingTemplate, obsoleteTemplates, pickTemplate, templateKey, templateParts,
  templateSettings, type TemplateMeta, type TemplateParts, type TemplateSettings } from "./vm-template.ts";
import { LeaseStore } from "./workspace-lease.ts";
import { skillInstallScripts } from "./skills.ts";
import { settleOperation, WorkspaceError, type WorkspaceOwner } from "./workspace.ts";

const run = promisify(execFile);

/** What Conversations needs from a thread's machine. */
export interface ThreadMachines {
  /** How cubed reaches the thread's guest helper. */
  guest(thread: Thread): GuestTransport;
  /** Boot or re-attach the machine; resolves once its guest answers ready.
   * `booted` says this call started the machine (a first boot or a boot
   * after it had stopped), not only re-attached a running one. `onBoot` is
   * called once the call goes past checking a machine this process already
   * runs: it boots or re-attaches the machine (which may take minutes). */
  start(thread: Thread, options?: StartOptions): Promise<MachineStart | void>;
  /** Stops new machines from using a template (its setup changed). */
  invalidateTemplate?(thread: Thread, templateId: string): Promise<void>;
  /** Release the machine; `retain` keeps its disk. The runner always keeps
   * an interrupted or failed one. */
  release(thread: Thread, retain: boolean): Promise<{ retained: boolean }>;
  /** Deletes an archived thread's retained disk. */
  discard(thread: Thread): Promise<void>;
  close(): Promise<void>;
  /** Whether this process has the thread's machine running and attached;
   * never starts one (the portal must not wake a machine). */
  running?(thread: Thread): boolean;
  /** A TCP connection to a port of the thread's running machine, for the
   * portal (the gateway allows 22 and 1024-65535). */
  dial?(thread: Thread, port: number): Promise<net.Socket>;
  /** Read-only evidence about the thread's machine (vm-diagnostics.ts);
   * never starts, stops or attaches it. */
  diagnose?(thread: Thread): Promise<MachineEvidence>;
  /** The end of the log of the hook running now in the thread's template
   * build machine or its own machine; null when neither is reachable. Read
   * only, with no lease: it never waits for or disturbs the preparation. */
  startupLog?(thread: Thread): Promise<StartupLog | null>;
}

/** The hook running now in a machine (from ~/.cache/cube/running) and the
 * end of its log, escaped and redacted. */
export interface StartupLog { machine: "build" | "thread"; hook: string | null; text: string; bytes: number; truncated: boolean }
/** Where the guest's hooks write their logs (the seed's user `agent`). */
const HOOK_LOGS = "/home/agent/.cache/cube";
/** How much of a hook's log the thread shows. */
export const STARTUP_LOG_BYTES = 16 * 1024;

/** The hook running now in a machine and the end of its log, read with the
 * guest's `read`, which is not fenced: it needs no lease and changes nothing.
 * `logs`: the hooks' log directory in that machine. */
export async function readStartupLog(transport: GuestTransport, machine: StartupLog["machine"], logs = HOOK_LOGS): Promise<StartupLog> {
  const read = async (file: string, offset: number, limit: number) => {
    const answer = await transport.call("read", { path: `${logs}/${file}`, offset, limit }, { timeoutMs: 10000 });
    const error = answer.header.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === "object") {
      if (error.code === "NOT_FOUND") return null;
      throw new Error(`reading ${file} failed: ${String(error.message ?? error.code)}`);
    }
    if (!Number.isSafeInteger(answer.header.size)) throw new Error("the guest helper's answer is malformed");
    return { size: answer.header.size as number, content: Buffer.from(answer.body) };
  };
  const running = await read("running", 0, 256);
  const [hook, log] = running ? running.content.toString("utf8").trim().split(" ") : [];
  if (!hook || !log || !/^[a-z-]{1,32}$/.test(hook) || !/^[a-z-]{1,32}\.log$/.test(log)) return { machine, hook: null, text: "", bytes: 0, truncated: false };
  // The size and the text come from the same read: a next try moves the
  // log aside (to .prev) at any moment.
  let offset = 0;
  let tail = await read(log, 0, STARTUP_LOG_BYTES);
  if (tail && tail.size > STARTUP_LOG_BYTES) {
    const end = await read(log, tail.size - STARTUP_LOG_BYTES, STARTUP_LOG_BYTES);
    if (end && end.size >= STARTUP_LOG_BYTES) { offset = tail.size - STARTUP_LOG_BYTES; tail = end; }
  }
  let text = tail ? tail.content.toString("utf8") : "";
  // From the first whole line when the start was cut off.
  if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
  return { machine, hook, text: clean(text, STARTUP_LOG_BYTES * 4), bytes: tail?.size ?? 0, truncated: offset > 0 };
}

export interface MachineStart { booted: boolean }
export interface StartOptions { onBoot?: () => void }

export interface VmSizes { vcpus: number; memoryMiB: number; diskGiB: number }
export const DEFAULT_VM_SIZES: VmSizes = { vcpus: 2, memoryMiB: 4096, diskGiB: 32 };

/** VM sizes from CUBED_VM_VCPUS, CUBED_VM_MEMORY_MIB and CUBED_VM_DISK_GIB. */
export function vmSizes(env: NodeJS.ProcessEnv = process.env): VmSizes {
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return { vcpus: read("CUBED_VM_VCPUS", DEFAULT_VM_SIZES.vcpus), memoryMiB: read("CUBED_VM_MEMORY_MIB", DEFAULT_VM_SIZES.memoryMiB),
    diskGiB: read("CUBED_VM_DISK_GIB", DEFAULT_VM_SIZES.diskGiB) };
}

const READY_TIMEOUT_MS = 15 * 60 * 1000;
const SETTLE_TIMEOUT_MS = 3 * 60 * 1000;
/** How long an attached machine's guest has to answer before it is attached
 * again (as long as one ready poll: a busy guest is not a gone one). */
const GUEST_CHECK_TIMEOUT_MS = 45000;
/** How long a machine attached again has to answer: it was ready before, so
 * this tells a lost link from a guest that is gone without a first boot's wait. */
const REATTACH_READY_TIMEOUT_MS = 2 * 60 * 1000;
const MACHINE_STATES_LIVE = new Set(["starting", "running"]);
/** A diagnosis waits this long for the runner (its requests queue behind
 * the runner's other calls) and for the guest's hello. */
const DIAGNOSE_RUNNER_MS = 8000;
const DIAGNOSE_GUEST_MS = 8000;

export interface ThreadVmsOptions {
  registry: Registry;
  /** CUBED_STATE/threads: per-thread keys live in `<id>/vm`. */
  threads: string;
  /** CUBED_STATE/run: ControlMaster sockets. */
  run: string;
  gateway: GatewaySupervisor;
  sizes?: VmSizes;
  readyTimeoutMs?: number;
  log?: Logger;
  /** Tests: the runner client for an admission (default: the shared one). */
  runnerClient?: (admission: { configPath: string; configHash: string }) => IrohRunnerClient;
  /** Machine templates (default: from CUBED_TEMPLATES and CUBED_TEMPLATE_TTL_HOURS). */
  templates?: TemplateSettings;
  /** Tests: how long a diagnosis waits for the runner and for the guest. */
  diagnoseTimeoutMs?: number;
}

export class ThreadVms implements ThreadMachines, EgressVms {
  private readonly options: ThreadVmsOptions;
  private readonly log: Logger;
  private readonly sizes: VmSizes;
  private readonly controls: string;
  private readonly attached = new Map<string, GatewayAttach>();
  private readonly transports = new Map<string, SshGuestTransport>();
  /** The guest of each thread's template build machine while it prepares. */
  private readonly buildTransports = new Map<string, SshGuestTransport>();
  private readonly starting = new Map<string, Promise<MachineStart>>();
  private readonly templates: TemplateSettings;
  /** Template builds under way, by runner and key: one at a time. */
  private readonly builds = new Map<string, Promise<unknown>>();
  /** When a build of a runner, key and machine size last failed, and why. */
  private readonly failedBuilds = new Map<string, { at: number; error: string }>();
  /** Status questions under way, by runner: one at a time, shared. */
  private readonly probes = new Map<string, Promise<TrustedRunnerHealth>>();
  /** cubed's machine events per thread, kept for diagnostics. */
  private readonly events: MachineEvents;
  /** The last guest hello of each thread's machine: when, and its answer. */
  private readonly guestProbes = new Map<string, { at: number; ready: boolean; error: string | null }>();
  /** Diagnoses under way, by thread: callers at the same time share one. */
  private readonly diagnoses = new Map<string, Promise<MachineEvidence>>();
  private closed = false;

  constructor(options: ThreadVmsOptions) {
    this.options = options;
    this.log = options.log ?? createLogger("vm");
    this.sizes = options.sizes ?? vmSizes();
    this.controls = controlDirectory(options.run);
    this.templates = options.templates ?? templateSettings();
    this.events = new MachineEvents(options.threads);
    options.gateway.onRestart(client => this.reattach(client));
  }

  /** EgressVms: a VM's thread and placeholders, for the egress policy. */
  vm(vmId: string): { threadId: string; placeholders: Record<string, string> } | null {
    return machineFor(this.options.registry, vmId);
  }

  guest(thread: Thread): SshGuestTransport {
    const vm = machine(thread);
    let transport = this.transports.get(thread.id);
    if (!transport) {
      const binary = this.options.gateway.binary;
      if (!binary) throw new GatewayUnavailable(this.options.gateway.unavailable ?? "no cube-gateway");
      transport = new SshGuestTransport({ vmId: vm.vmId, keyDirectory: this.keyDirectory(thread), controlDirectory: this.controls,
        gateway: { binary, control: this.controlSocket() } });
      this.transports.set(thread.id, transport);
    }
    return transport;
  }

  start(thread: Thread, options: StartOptions = {}): Promise<MachineStart> {
    if (this.closed) return Promise.reject(new Error("cubed is stopping"));
    const pending = this.starting.get(thread.id);
    if (pending) return pending;
    const starting = this.boot(thread, options.onBoot).finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, starting);
    return starting;
  }

  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    const vm = machine(thread);
    const runner = this.runner(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    const left = this.options.registry.getThread(thread.id)?.vm?.build?.runnerId;
    if (left && left !== thread.runnerId) {
      // A build machine on a runner the thread moved away from (cubed's own,
      // no agent) does not hold up the archive while that runner is gone; its
      // record stays on the thread as the evidence of where it is.
      if (!await this.abandonBuildElsewhere(thread, true)) this.log.warn("build machine left on another runner", { thread: thread.id, runner: left });
    } else await this.abandonBuild(thread, runner);
    await this.transports.get(thread.id)?.close();
    this.transports.delete(thread.id);
    this.attached.delete(vm.vmId);
    try { await (await this.options.gateway.ready(5000)).client.detach(vm.vmId); }
    catch (error) { this.log.warn("detach failed", { thread: thread.id, error }); }
    // No allocation ever reached a runner (a thread that waited for one):
    // nothing to release, whether or not its runner answers. The registry
    // says so, not the caller's copy of the thread.
    if (placement(this.options.registry.getThread(thread.id) ?? thread) === "provisional") return { retained: false };
    try { await runner.vmInspect(ref); }
    catch (error) {
      // Never allocated: nothing to release.
      if (error instanceof IrohNodeError && error.code === "NOT_FOUND") return { retained: false };
      throw error;
    }
    let record = await runner.vmRelease(ref, this.epoch(thread), retain);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (record.state !== "released" && record.state !== "retained") {
      if (record.state === "failed") throw new Error(`the runner could not release the thread machine${record.error ? `: ${record.error}` : ""}`);
      if (Date.now() > deadline) throw new Error(`the thread machine is still ${record.state}`);
      await delay(1000);
      record = (await runner.vmInspect(ref)).vm;
    }
    if (record.state === "released") fs.rmSync(this.keyDirectory(thread), { recursive: true, force: true });
    this.log.info("released", { thread: thread.id, vm: vm.vmId, retained: record.state === "retained" });
    this.events.record(thread.id, record.state);
    this.guestProbes.delete(thread.id);
    return { retained: record.state === "retained" };
  }

  async discard(thread: Thread): Promise<void> {
    const vm = machine(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    const record = await this.runner(thread).vmDiscard(ref, this.epoch(thread));
    if (record.state !== "released") throw new Error(`the runner did not discard the machine (${record.state})`);
    fs.rmSync(this.keyDirectory(thread), { recursive: true, force: true });
    this.log.info("discarded", { thread: thread.id, vm: vm.vmId });
    this.events.record(thread.id, "discarded");
  }

  running(thread: Thread): boolean { return !!thread.vm && this.attached.has(thread.vm.vmId); }

  async dial(thread: Thread, port: number): Promise<net.Socket> {
    if (!this.running(thread)) throw new Error("the thread's machine is not running");
    return dialGuest(this.controlSocket(), machine(thread).vmId, port);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.transports.values()].map(transport => transport.close()));
    this.transports.clear();
  }

  /** Starts the thread's machine on its runner. A thread whose machine was
   * never allocated first checks that its runner can take it (`verify`) and
   * moves to another when it cannot (`movable`); one whose machine is, or
   * may be, on its runner waits for that runner (`waitFor`). */
  private async boot(thread: Thread, onBoot?: () => void): Promise<MachineStart> {
    const vm = machine(thread);
    try {
      thread = this.options.registry.getThread(thread.id) ?? thread;
      await this.abandonBuildElsewhere(thread);
      if (placement(thread) === "allocated") await this.verify(thread);
      let reattach = false;
      if (this.attached.has(vm.vmId)) {
        // Already started by this process: only check that it still runs
        // and its guest answers.
        const runner = this.runner(thread);
        await this.options.gateway.ensureNetwork(runner.target.network);
        const { client: gateway } = await this.options.gateway.ready();
        const [{ vm: current }, status] = await Promise.all([runner.vmInspect({ threadId: thread.id, vmId: vm.vmId }).catch((error: unknown) => {
          if (contactLost(error)) this.observe(thread.runnerId, { error: errorText(error) });
          throw error;
        }), gateway.status(vm.vmId)]);
        if (current.state === "running" && status) {
          // Running is QEMU's word, not the guest's: a guest that stopped
          // answering over the gateway is attached again (a new frame
          // connection to the same machine) and waited for, not trusted.
          const unanswered = await this.unanswered(thread);
          if (!unanswered) return { booted: false };
          this.log.warn("machine runs but its guest does not answer; attaching it again", { thread: thread.id, vm: vm.vmId, error: unanswered,
            link: status.link, linkError: status.lastError });
          this.events.record(thread.id, "guest does not answer; attaching again", `${unanswered}; link ${status.link}${status.lastError ? `: ${status.lastError}` : ""}`);
          await this.guest(thread).close();
          reattach = true;
        } else {
          this.log.warn("machine is not running; starting it again", { thread: thread.id, vm: vm.vmId, state: current.state });
          this.events.record(thread.id, "machine is not running; starting it again", `runner state ${current.state}, gateway ${status ? status.link : "not attached"}`);
        }
        this.attached.delete(vm.vmId);
      }
      onBoot?.();
      // Each runner is tried once per start; a move commits before the next try.
      const tried = new Set<string>();
      for (;;) {
        thread = this.options.registry.getThread(thread.id) ?? thread;
        // No runner is asked anything while the gateway is unavailable.
        const runner = this.runner(thread);
        await this.options.gateway.ensureNetwork(runner.target.network);
        const gateway = await this.options.gateway.ready();
        try {
          await this.verify(thread);
          return await this.bootOn(thread, runner, gateway, reattach);
        } catch (error) {
          if (!await this.movable(thread, error)) throw error;
          tried.add(thread.runnerId);
          const why = unusableReason(error);
          const moved = this.options.registry.relocateThread(thread.id, tried);
          if (!moved) {
            const text = `${this.nodeId(thread.runnerId)} ${why}, and no other runner with a free thread machine is ready`;
            if (error instanceof RunnerUnusable && !error.transient) throw new Error(`runner ${text}`, { cause: error });
            throw new RunnerWait(`waiting for a runner: ${text}; cube tries again`, { cause: error });
          }
          this.log.info("thread moved to another runner", { thread: thread.id, from: thread.runnerId, to: moved, why });
          this.events.record(thread.id, "moved to another runner", `${this.nodeId(thread.runnerId)} ${why}; now ${this.nodeId(moved)}`);
        }
      }
    } catch (error) {
      const failure = this.waitFor(this.options.registry.getThread(thread.id) ?? thread, error);
      this.events.record(thread.id, failure instanceof RunnerWait ? "waiting for a runner" : "start failed", failure);
      throw failure;
    }
  }

  /** Whether `error` lets the thread leave its runner: it says the runner
   * cannot take the machine now (no answer, not ready, a refused
   * allocation), nothing is bound to the runner, and no allocation of the
   * machine can have reached it: none was sent (`provisional`), or the
   * runner refused a request fenced by the thread's newest epoch and then
   * had no machine, so no older request can still make one. */
  private async movable(thread: Thread, error: unknown): Promise<boolean> {
    const refused = refusal(error);
    if (contactLost(error)) this.observe(thread.runnerId, { error: errorText(error) });
    // A runner that refused (full, draining) is asked how it is, so placement
    // does not keep choosing it from an older report.
    if (refused) await this.probe(thread.runnerId).catch(() => {});
    if (!(refused || contactLost(error) || error instanceof RunnerUnusable) || !this.unbound(thread)) return false;
    const current = this.options.registry.getThread(thread.id);
    if (!current || current.runnerId !== thread.runnerId) return false;
    if (placement(current) === "provisional") return true;
    if (placement(current) !== "requested" || !refused) return false;
    try { await this.runner(current).vmInspect({ threadId: current.id, vmId: machine(current).vmId }); return false; }
    catch (cause) {
      if (!(cause instanceof IrohNodeError && cause.code === "NOT_FOUND")) return false;
      return this.options.registry.markPlacement(current.id, current.runnerId, ["requested"], "provisional");
    }
  }

  /** A failure the thread waits out on its runner, said as such: a refused
   * allocation, or a runner that does not answer or is not ready. */
  private waitFor(thread: Thread, error: unknown): unknown {
    if (error instanceof RunnerWait) return error;
    if (refusal(error)) {
      const why = (error as IrohNodeError).message;
      return new RunnerWait(`the runner has no room for this thread's machine (${why === "CAPACITY_EXCEEDED" ? "it hosts as many machines as it can"
        : why === "DRAINING" ? "it is not taking new machines" : why}); cube tries again every 30 seconds`, { cause: error });
    }
    if (!(contactLost(error) || error instanceof RunnerUnusable)) return error;
    if (error instanceof RunnerUnusable && !error.transient) return new Error(`runner ${this.nodeId(thread.runnerId)} ${error.message}`, { cause: error });
    const node = this.nodeId(thread.runnerId);
    const state = placement(thread);
    return new RunnerWait(state === "allocated" ? `waiting for runner ${node}: it ${unusableReason(error)}; this thread's machine is on it and stays there`
      : state === "requested" ? `waiting for runner ${node}: it ${unusableReason(error)}, and a request for this thread's machine may have reached it, so the thread waits for it rather than start a second machine elsewhere`
      : `waiting for runner ${node}: it ${unusableReason(error)}; the thread's workspace is bound to it`, { cause: error });
  }

  /** Before anything of the thread reaches its runner: a runner cubed saw
   * ready lately is used; one it saw fail, whose retry is not due, is not
   * asked again; any other is asked for its status first (one question per
   * runner at a time, shared by every thread that waits on it). */
  private async verify(thread: Thread): Promise<void> {
    const observed = this.options.registry.runnerFitness(thread.runnerId);
    const unanswered = observed?.fitness === "down" && !!observed.error && CONTACT_ERROR.test(observed.error);
    // A thread whose machine is there is not moved; until the runner's retry
    // is due nothing is sent, so threads waiting on a dead runner do not
    // queue requests on its one client. Its own requests answer the rest.
    if (placement(thread) === "allocated") {
      if (unanswered) throw new RunnerUnusable("does not answer");
      return;
    }
    if (observed?.fitness === "ready") return;
    if (observed?.fitness === "down") {
      if (unanswered) throw new RunnerUnusable("does not answer");
      // Not ready but answering: a requested thread asks for its machine,
      // which the runner returns if it exists or refuses, fenced.
      if (!observed.error) {
        if (placement(thread) === "requested") return;
        throw new RunnerUnusable(`is ${lifecycleText(observed.health)}`);
      }
      throw new RunnerUnusable(`could not report its status (${observed.error})`, false);
    }
    let health: TrustedRunnerHealth;
    try { health = await this.probe(thread.runnerId); }
    catch (error) {
      if (contactLost(error)) throw error;
      throw new RunnerUnusable(`could not report its status (${error instanceof Error ? error.message : String(error)})`, false);
    }
    // A requested thread goes on: the runner's answer to its allocation is final.
    if ((health.lifecycle !== "ready" || health.draining) && placement(thread) === "provisional") throw new RunnerUnusable(`is ${lifecycleText(health)}`);
  }

  private probe(runnerId: string): Promise<TrustedRunnerHealth> {
    let pending = this.probes.get(runnerId);
    if (!pending) {
      const admission = this.options.registry.getRunner(runnerId);
      if (!admission) return Promise.reject(new Error("runner not found"));
      pending = (async () => {
        try {
          const health = await (this.options.runnerClient ?? runnerClient)(admission).health();
          this.observe(runnerId, { health });
          return health;
        } catch (error) {
          this.observe(runnerId, { error: errorText(error) });
          throw error;
        }
      })().finally(() => this.probes.delete(runnerId));
      this.probes.set(runnerId, pending);
    }
    return pending;
  }

  /** A template build machine left on a runner the thread moved away from
   * (cubed's own, no agent) holds a slot there: it is deleted once that
   * runner answered ready lately (the background probe), so a thread's start
   * never waits on a runner that is gone. `now`: try unless it is down (an
   * archive). A retired runner took the machine with it: the record goes.
   * Returns whether nothing is left. */
  private async abandonBuildElsewhere(thread: Thread, now = false): Promise<boolean> {
    const left = this.options.registry.getThread(thread.id)?.vm?.build?.runnerId;
    if (!left || left === thread.runnerId) return true;
    const observed = this.options.registry.runnerFitness(left);
    if (!observed || observed.retired) {
      this.log.warn("build machine record dropped: its runner is retired", { thread: thread.id, runner: left });
      this.options.registry.updateThreadVm(thread.id, { build: undefined });
      return true;
    }
    if (now ? observed.fitness === "down" : observed.fitness !== "ready") return false;
    try { await this.abandonBuild(thread, this.runner(thread)); return true; }
    catch (error) {
      if (contactLost(error)) this.observe(left, { error: errorText(error) });
      this.log.warn("deleting a build machine on another runner failed", { thread: thread.id, runner: left, error });
      return false;
    }
  }

  /** What a runner answered, or that it did not, as its probe would record it. */
  private observe(runnerId: string, result: { health: TrustedRunnerHealth } | { error: string }): void {
    try { this.options.registry.recordRunnerProbe(runnerId, result); }
    catch (error) { this.log.warn("runner observation not kept", { runner: runnerId, error }); }
  }
  private nodeId(runnerId: string): string { return this.options.registry.getRunner(runnerId)?.nodeId ?? runnerId; }

  private async bootOn(thread: Thread, runner: IrohRunnerClient, { client: gateway, hello }: Awaited<ReturnType<GatewaySupervisor["ready"]>>,
    reattach = false): Promise<MachineStart> {
    const vm = machine(thread);
    const target = runner.target;
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    const description = await runner.describe();
    // The runner's bound may have changed since cubed last asked.
    this.options.registry.recordRunnerSlots(thread.runnerId, description.limits.maxActiveVms);
    // The project's size when the thread was created, else cubed's; the
    // runner's limits bound both.
    const wanted = { vcpus: thread.allocation.machine?.vcpus ?? this.sizes.vcpus, memoryMiB: thread.allocation.machine?.memoryMiB ?? this.sizes.memoryMiB };
    const sizes = {
      vcpus: Math.min(wanted.vcpus, description.limits.maxVcpus),
      memoryMiB: Math.min(wanted.memoryMiB, description.limits.maxMemoryMiB),
      diskGiB: Math.min(this.sizes.diskGiB, description.limits.maxDiskGiB),
    };
    const clamped = sizes.vcpus < wanted.vcpus || sizes.memoryMiB < wanted.memoryMiB
      ? `; the project asks for ${wanted.vcpus} vCPU and ${gib(wanted.memoryMiB * MIB)}, this runner allows at most ${description.limits.maxVcpus} vCPU and ${gib(description.limits.maxMemoryMiB * MIB)}` : "";
    let record: VmRecord;
    try {
      record = (await runner.vmInspect(ref)).vm;
      // The runner has the machine, whatever answer was lost: it is this thread's there.
      this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional", "requested"], "allocated");
    } catch (error) {
      if (!(error instanceof IrohNodeError && error.code === "NOT_FOUND")) throw error;
      const allocating = Date.now();
      // Decide what the disk is made from (building a template first if the
      // project has none on this runner), then allocate it. A refusal (full,
      // draining) created nothing; boot() moves an unbound thread elsewhere.
      thread = await this.prepare(thread, runner, description, sizes, hello.caPem);
      record = await this.allocate(thread, runner, ref, sizes.diskGiB);
      const preparation = this.options.registry.getThread(thread.id)!.vm!.preparation!;
      this.phase(thread, "allocate", allocating);
      this.log.info("allocated", { thread: thread.id, vm: vm.vmId, diskGiB: sizes.diskGiB, source: preparation.source,
        ...(preparation.templateId ? { template: preparation.templateId } : {}), ...(preparation.reason ? { reason: preparation.reason } : {}) });
      this.events.record(thread.id, "allocated", `${sizes.diskGiB} GiB on ${runner.nodeId}, ${preparation.source}${preparation.templateId ? ` template ${preparation.templateId}` : ""}`
        + (preparation.reason ? ` (${preparation.reason})` : ""));
    }
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (record.state === "stopping") {
      if (Date.now() > deadline) throw new Error("the thread machine did not stop");
      await delay(1000);
      record = (await runner.vmInspect(ref)).vm;
    }
    if (!["allocated", "stopped", "starting", "running"].includes(record.state)) {
      throw new Error(`the thread machine is ${record.state}${record.error ? `: ${record.error}` : ""}`);
    }
    const booted = record.state === "allocated" || record.state === "stopped";
    const first = record.state === "allocated";
    const booting = Date.now();
    const keys = await this.keys(thread);
    const frameToken = randomBytes(32).toString("hex");
    const mac = vmMac(vm.vmId, data => createHash("sha256").update(data).digest());
    // Only a first start writes the seed; the runner keeps it for the machine's life.
    const seed = vmSeed({ vmId: vm.vmId, hostKey: keys.host, clientKeyPub: keys.clientPub, caPem: hello.caPem, placeholders: vm.placeholders,
      hooks: thread.allocation.hooks ?? NO_HOOKS, fromTemplate: record.template !== undefined });
    this.events.record(thread.id, "start sent", `the runner had it ${record.state}${reattach ? "; attaching again" : ""}`);
    if (booted) this.begin(thread, { name: "boot", detail: `${sizes.vcpus} vCPU, ${gib(sizes.memoryMiB * MIB)} memory, disk from ${record.template ? "the template" : "the base image"}${clamped}` });
    try {
      record = await runner.vmStart(ref, this.epoch(thread), { vcpus: sizes.vcpus, memoryMiB: sizes.memoryMiB, mac, seed, gateway: { peer: hello.peer, frameToken } });
      this.events.record(thread.id, "start answered", `${record.state}${record.interrupted ? ", interrupted" : ""}${record.error ? `: ${record.error}` : ""}`);
      if (!MACHINE_STATES_LIVE.has(record.state)) {
        throw new Error(`the thread machine did not start${record.error ? `: ${record.error.trim().split("\n").slice(-3).join("; ")}` : ""}`);
      }
      const spec: GatewayAttach = { threadId: thread.id, runner: target, frameToken, mac };
      await gateway.attach(vm.vmId, spec);
      this.attached.set(vm.vmId, spec);
      this.log.info("started", { thread: thread.id, vm: vm.vmId, state: record.state, runner: runner.nodeId });
      this.events.record(thread.id, "gateway attached");
      const readyMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const waitMs = reattach && !booted ? Math.min(readyMs, REATTACH_READY_TIMEOUT_MS) : readyMs;
      this.events.record(thread.id, "waiting for the guest", `up to ${Math.round(waitMs / 1000)} s`);
      await this.waitReady(this.guest(thread), runner, ref, waitMs);
    } catch (error) {
      if (booted) this.end(thread, { name: "boot", state: "failed", detail: errorText(error) });
      throw error;
    }
    if (booted) this.end(thread, { name: "boot", state: "ok" });
    if (first) this.phase(thread, "boot", booting);
    return { booted };
  }

  /** Allocates the thread's disk as its preparation says. A template that
   * vanished meanwhile (removed, expired) falls back to the base image. */
  private async allocate(thread: Thread, runner: IrohRunnerClient, ref: VmRef, diskGiB: number): Promise<VmRecord> {
    const preparation = thread.vm!.preparation!;
    const { registry } = this.options;
    // Kept before the request leaves: from here the machine may exist on
    // this runner, and the thread leaves it only on the runner's word.
    const first = registry.markPlacement(thread.id, thread.runnerId, ["provisional"], "requested");
    if (!first && placement(registry.getThread(thread.id) ?? thread) !== "requested") throw new Error("the thread's placement changed while its machine was being prepared");
    const allocated = (record: VmRecord) => {
      registry.markPlacement(thread.id, thread.runnerId, ["requested"], "allocated");
      return record;
    };
    const send = async (current: Thread, template?: string) => {
      try { return allocated(await runner.vmAllocate(ref, this.epoch(current), diskGiB, template)); }
      catch (error) {
        // Not sent: the runner has nothing of it, as before this try (a
        // template it did not have made nothing either).
        if (first && error instanceof IrohNodeError && error.code === "NODE_UNAVAILABLE") registry.markPlacement(thread.id, thread.runnerId, ["requested"], "provisional");
        throw error;
      }
    };
    try { return await send(thread, preparation.templateId); }
    catch (error) {
      if (!(preparation.templateId && error instanceof IrohNodeError && error.remoteCode === "NOT_FOUND")) throw error;
      this.log.warn("template gone; starting fresh", { thread: thread.id, template: preparation.templateId });
      const updated = registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason: "the template was removed before the machine was allocated" } });
      return send(updated);
    }
  }

  /** Records the start of a step the thread shows (`vm.steps`); evidence
   * only, so a registry error never fails the machine's start. */
  private begin(thread: Thread, step: Pick<StartupStep, "name" | "attempt" | "detail">): void {
    try { this.options.registry.beginStartupStep(thread.id, step); }
    catch (error) { this.log.warn("startup step not kept", { thread: thread.id, step: step.name, error }); }
  }
  private end(thread: Thread, step: Pick<StartupStep, "name" | "attempt" | "detail" | "memory" | "log"> & { state: "ok" | "failed" }): void {
    try { this.options.registry.endStartupStep(thread.id, step); }
    catch (error) { this.log.warn("startup step not kept", { thread: thread.id, step: step.name, error }); }
  }

  /** Records a startup phase of the thread's machine (ms since `since`). */
  private phase(thread: Thread, name: string, since: number): void {
    const current = this.options.registry.getThread(thread.id)?.vm;
    if (!current) return;
    const source = current.preparation?.source ?? "fresh";
    const startup = current.startup ?? { source, totalMs: 0, phases: {} };
    this.options.registry.updateThreadVm(thread.id, { startup: { ...startup, source, phases: { ...startup.phases, [name]: Date.now() - since } } });
  }

  /** Decides what a new machine's disk is made from and records it on the
   * thread: the newest fresh template of the project on this runner, or a
   * template built now, or the base image. Returns the updated thread. */
  private async prepare(thread: Thread, runner: IrohRunnerClient, description: RunnerDescription, sizes: VmSizes, caPem: string): Promise<Thread> {
    this.begin(thread, { name: "lookup" });
    const fresh = (reason: string) => {
      this.end(thread, { name: "lookup", state: "ok", detail: `no template: ${reason}` });
      return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason } });
    };
    const left = thread.vm?.build?.runnerId;
    if (left && left !== thread.runnerId) {
      // A build machine on the runner the thread left (cubed's own, no agent):
      // deleted when that runner answers, at the latest at archive. Its record
      // stays until then, so this thread builds no template meanwhile.
      try { await this.abandonBuild(thread, runner); }
      catch (error) {
        this.log.warn("deleting a build machine on another runner failed", { thread: thread.id, runner: left, error });
        return fresh("an earlier template build machine on another runner is not deleted yet");
      }
    } else await this.abandonBuild(thread, runner);
    if (!this.templates.enabled) return fresh("templates are off (CUBED_TEMPLATES=off)");
    if (!description.capabilities.includes(TEMPLATE_CAPABILITY)) return fresh("the runner has no machine templates (cube-runner 0.8.0+)");
    const hooks = thread.allocation.hooks ?? NO_HOOKS;
    const keyInput = { allocation: thread.allocation, hooks, runner: description, diskGiB: sizes.diskGiB };
    const key = templateKey(keyInput);
    let templates: RunnerTemplate[];
    try { templates = await runner.templateList(); }
    catch (error) {
      this.log.warn("listing templates failed", { thread: thread.id, error });
      return fresh("the runner's templates could not be listed");
    }
    const now = Date.now();
    await this.removeTemplates(runner, obsoleteTemplates(templates, { now, ttlMs: this.templates.ttlMs,
      projectExists: id => this.options.registry.getProject(id) !== null }), "obsolete");
    const found = pickTemplate(templates, key, now, this.templates.ttlMs);
    if (found) {
      this.end(thread, { name: "lookup", state: "ok", detail: `template ${found.id}, prepared ${minutes(now - found.createdAt)} ago` });
      return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: found.id, setupBlob: found.meta.setupBlob } });
    }
    const missing = missingTemplate(templates, { projectId: thread.allocation.projectId, key, parts: templateParts(keyInput), now, ttlMs: this.templates.ttlMs });
    const flight = `${thread.runnerId}:${key}`;
    // One build per runner and key: a thread that comes meanwhile starts fresh.
    if (this.builds.has(flight)) return fresh(`${missing}; another thread is preparing the project's template now`);
    // A failed build is not tried again for an hour with the same key,
    // machine size and commit. The size and the commit are not in the key
    // (neither changes what a template is for), but a build that ran out of
    // memory, or that a new commit fixes, is tried again at once.
    const attempt = `${flight}:${sizes.vcpus}:${sizes.memoryMiB}:${thread.allocation.repositories[0]?.baseOid ?? ""}`;
    const failed = this.failedBuilds.get(attempt);
    if (failed !== undefined && now - failed.at < FAILED_BUILD_BACKOFF_MS) {
      return fresh(`${missing}; the last build of one failed ${minutes(now - failed.at)} ago (${failed.error}); `
        + `cube tries again in ${minutes(failed.at + FAILED_BUILD_BACKOFF_MS - now)}, or at once with a new commit or another machine size`);
    }
    this.end(thread, { name: "lookup", state: "ok", detail: `${missing}: building one` });
    const building = this.build(thread, runner, sizes, caPem, key, templateParts(keyInput));
    this.builds.set(flight, building);
    try {
      const template = await building;
      this.failedBuilds.delete(flight);
      return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: template.id, setupBlob: template.meta.setupBlob } });
    } catch (error) {
      // No room, or the runner went away: the caller may move the thread;
      // cubed stopping: retried later.
      if (refusal(error) || contactLost(error) || this.closed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.failedBuilds.set(attempt, { at: Date.now(), error: message });
      this.log.warn("template build failed; starting fresh", { thread: thread.id, runner: runner.nodeId, error: message });
      return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason: `the template build failed: ${message}` } });
    } finally { this.builds.delete(flight); }
  }

  /** Builds a template for `key` on the thread's runner, in the thread's
   * slot, before the thread's own machine exists: a build machine with its
   * own throwaway identity (VM id, keys, placeholders) boots from the base
   * image, cubed checks out the pinned commits and runs pre-setup and
   * `.agents/setup` in it, seals it and powers it off, and the runner
   * publishes its disk. Anything short of that success publishes nothing
   * and the build machine is deleted. */
  private async build(thread: Thread, runner: IrohRunnerClient, sizes: VmSizes, caPem: string, key: string, parts: TemplateParts): Promise<{ id: string; meta: TemplateMeta }> {
    const started = Date.now();
    const build = { vmId: randomBytes(8).toString("hex"), placeholders: { github: newPlaceholder("github") }, key, runnerId: thread.runnerId };
    this.options.registry.updateThreadVm(thread.id, { build });
    const ref: VmRef = { threadId: thread.id, vmId: build.vmId };
    const directory = this.buildDirectory(thread);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const phases: Record<string, number> = {};
    let transport: SshGuestTransport | undefined;
    let leases: LeaseStore | undefined;
    let published = false;
    // The step under way, marked failed if the build stops there.
    let step: StartupStep["name"] = "build-boot";
    this.begin(thread, { name: step, detail: `${sizes.vcpus} vCPU, ${gib(sizes.memoryMiB * MIB)} memory, from the base image` });
    try {
      let since = Date.now();
      await runner.vmAllocate(ref, this.epoch(thread), sizes.diskGiB);
      const keys = await generateKeys(directory, build.vmId);
      const { client: gateway, hello } = await this.options.gateway.ready();
      const frameToken = randomBytes(32).toString("hex");
      const mac = vmMac(build.vmId, data => createHash("sha256").update(data).digest());
      const seed = vmSeed({ vmId: build.vmId, hostKey: keys.host, clientKeyPub: keys.clientPub, caPem, placeholders: build.placeholders,
        hooks: thread.allocation.hooks ?? NO_HOOKS });
      const record = await runner.vmStart(ref, this.epoch(thread), { vcpus: sizes.vcpus, memoryMiB: sizes.memoryMiB, mac, seed,
        gateway: { peer: hello.peer, frameToken } });
      if (!MACHINE_STATES_LIVE.has(record.state)) throw new Error(`the build machine did not start${record.error ? `: ${record.error.trim().split("\n").at(-1)}` : ""}`);
      const spec: GatewayAttach = { threadId: thread.id, runner: runner.target, frameToken, mac };
      await gateway.attach(build.vmId, spec);
      this.attached.set(build.vmId, spec);
      const binary = this.options.gateway.binary;
      if (!binary) throw new GatewayUnavailable(this.options.gateway.unavailable ?? "no cube-gateway");
      transport = new SshGuestTransport({ vmId: build.vmId, keyDirectory: directory, controlDirectory: this.controls,
        gateway: { binary, control: this.controlSocket() } });
      await this.waitReady(transport, runner, ref, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      phases["build-boot"] = Date.now() - since;
      this.end(thread, { name: step, state: "ok" });

      // cubed's own commands: the build machine never has an agent.
      since = Date.now();
      step = "build-prepare";
      this.begin(thread, { name: step, detail: "checkout, pre-setup and .agents/setup in the build machine" });
      this.buildTransports.set(thread.id, transport);
      leases = new LeaseStore(path.join(directory, "lease"));
      const owner = threadAgent(thread);
      const workspace = new VmWorkspace({ guest: transport, leases, owner, binding: JSON.stringify({ build: build.vmId, thread: thread.id }) });
      const prepared = await own(workspace, owner, "cube:build:prepare", preparationScript(thread.allocation, { kind: "fresh" }), 1800000);
      const outcome = preparationOutcome(prepared);
      if (outcome.error) {
        // A hook that was killed printed nothing more: its log is still in the machine.
        const log = outcome.log ?? (outcome.running ? await readStartupLog(transport, "build").then(read => read.text ? stepLog(read.text) : undefined, () => undefined) : undefined);
        throw new StepFailure(outcome.error, outcome.memory, log);
      }
      const failedHook = Object.entries(outcome.hooks).find(([, hook]) => hook.status === "failed");
      if (failedHook) throw new StepFailure(`${failedHook[0]} failed (exit ${failedHook[1].exitCode}) in the build machine`, outcome.memory, outcome.log);
      phases["build-prepare"] = Date.now() - since;
      this.buildTransports.delete(thread.id);
      this.end(thread, { name: step, state: "ok", detail: hookSummary(outcome.hooks), ...(outcome.memory ? { memory: outcome.memory } : {}) });

      since = Date.now();
      step = "build-seal";
      this.begin(thread, { name: step, detail: "removing the build machine's identity, then powering it off" });
      const sealed = await own(workspace, owner, "cube:build:seal", `sudo -n ${GUEST_HELPER_PATH} seal`, 900000);
      const sealOutput = sealed.state === "succeeded" ? Buffer.from(sealed.output).toString("utf8") : "";
      if (sealed.state !== "succeeded" || sealed.exitCode !== 0 || !sealOutput.includes("sealed at power-off")) {
        throw new Error(`sealing the build machine failed (${sealed.state === "succeeded" ? sealOutput.trim().slice(-200) : sealed.state})`);
      }
      await transport.close();
      transport = undefined;
      this.attached.delete(build.vmId);
      await gateway.detach(build.vmId).catch(() => {});
      // ACPI power-off: the guest cleans itself at shutdown and QEMU exits.
      let stopped = await runner.vmStop(ref, this.epoch(thread));
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (stopped.state !== "stopped") {
        if (Date.now() > deadline || !["stopping", "running", "starting"].includes(stopped.state)) throw new Error(`the build machine did not power off (${stopped.state})`);
        await delay(1000);
        stopped = (await runner.vmInspect(ref)).vm;
      }
      if (stopped.interrupted) throw new Error("the build machine did not power off cleanly");
      phases["build-seal"] = Date.now() - since;
      this.end(thread, { name: step, state: "ok" });

      since = Date.now();
      step = "build-publish";
      this.begin(thread, { name: step });
      const meta: TemplateMeta = { format: TEMPLATE_FORMAT, projectId: thread.allocation.projectId, setupBlob: outcome.setupBlob ?? "none",
        commit: thread.allocation.repositories[0]?.baseOid ?? null, parts };
      let template: RunnerTemplate;
      try { template = await runner.vmPublish(ref, this.epoch(thread), key, JSON.stringify(meta)); }
      catch (error) {
        // The answer was lost: publishing is idempotent, so ask again once.
        if (!(error instanceof IrohNodeError && error.completionUnknown)) throw error;
        template = await runner.vmPublish(ref, this.epoch(thread), key, JSON.stringify(meta));
      }
      published = true;
      phases["build-publish"] = Date.now() - since;
      this.end(thread, { name: step, state: "ok", detail: `template ${template.id}, ${gib(template.bytes)}` });
      this.log.info("template published", { thread: thread.id, runner: runner.nodeId, template: template.id, bytes: template.bytes,
        ms: Date.now() - started, phases });
      for (const [name, ms] of Object.entries(phases)) this.phase(thread, name, Date.now() - ms);
      // The project's older templates on this runner are superseded.
      try {
        const templates = await runner.templateList();
        await this.removeTemplates(runner, obsoleteTemplates(templates, { now: Date.now(), ttlMs: this.templates.ttlMs,
          projectExists: id => this.options.registry.getProject(id) !== null, projectId: meta.projectId, keep: template.id }), "superseded");
      } catch (error) { this.log.warn("removing superseded templates failed", { runner: runner.nodeId, error }); }
      return { id: template.id, meta };
    } catch (error) {
      if (!published) this.end(thread, { name: step, state: "failed", detail: `${errorText(error)}; no template was published`,
        ...(error instanceof StepFailure && error.memory ? { memory: error.memory } : {}), ...(error instanceof StepFailure && error.log ? { log: error.log } : {}) });
      throw error;
    } finally {
      this.buildTransports.delete(thread.id);
      await transport?.close().catch(() => {});
      leases?.close();
      if (published) {
        this.options.registry.updateThreadVm(thread.id, { build: undefined });
        fs.rmSync(directory, { recursive: true, force: true });
      } else await this.abandonBuild(thread, runner).catch(error => this.log.warn("deleting the build machine failed", { thread: thread.id, error }));
    }
  }

  /** Deletes a template build machine of the thread that did not publish
   * (a failure, or a crash in between). It held only cubed's own work. */
  private async abandonBuild(thread: Thread, current: IrohRunnerClient): Promise<void> {
    const build = this.options.registry.getThread(thread.id)?.vm?.build;
    if (!build) return;
    // The runner the build machine was made on (the thread may have moved since).
    const admission = build.runnerId && build.runnerId !== thread.runnerId ? this.options.registry.getRunner(build.runnerId) : null;
    const runner = admission ? (this.options.runnerClient ?? runnerClient)(admission) : current;
    const ref: VmRef = { threadId: thread.id, vmId: build.vmId };
    this.attached.delete(build.vmId);
    try { await (await this.options.gateway.ready(5000)).client.detach(build.vmId); } catch { /* not attached */ }
    try {
      let record = (await runner.vmInspect(ref)).vm;
      if (record.state !== "released") {
        if (record.state !== "retained" && record.state !== "failed") record = await runner.vmRelease(ref, this.epoch(thread), false);
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        while (record.state !== "released" && record.state !== "retained" && record.state !== "failed") {
          if (Date.now() > deadline) throw new Error(`the build machine is still ${record.state}`);
          await delay(1000);
          record = (await runner.vmInspect(ref)).vm;
        }
        // An interrupted build machine is retained by the runner; it holds nothing of an agent.
        if (record.state !== "released") await runner.vmDiscard(ref, this.epoch(thread));
      }
    } catch (error) {
      if (!(error instanceof IrohNodeError && error.code === "NOT_FOUND")) throw error;
    }
    this.options.registry.updateThreadVm(thread.id, { build: undefined });
    fs.rmSync(this.buildDirectory(thread), { recursive: true, force: true });
    this.log.info("build machine deleted", { thread: thread.id, vm: build.vmId });
  }

  async invalidateTemplate(thread: Thread, templateId: string): Promise<void> {
    await this.removeTemplates(this.runner(thread), [templateId], "its setup changed");
  }

  private async removeTemplates(runner: IrohRunnerClient, ids: string[], reason: string): Promise<void> {
    for (const id of ids) {
      try {
        const removed = await runner.templateRemove(id);
        this.log.info("template removed", { runner: runner.nodeId, template: id, reason, inUse: removed.users });
      } catch (error) {
        if (error instanceof IrohNodeError && error.code === "NOT_FOUND") continue;
        this.log.warn("removing a template failed", { runner: runner.nodeId, template: id, error });
      }
    }
  }

  /** The guest answers `hello` with ready once cloud-init (packages, the
   * helper) has finished; the first boot installs packages through the
   * gateway and takes minutes. */
  private async waitReady(transport: GuestTransport, runner: IrohRunnerClient, ref: VmRef, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastInspect = Date.now();
    let last: string;
    let reported: string | undefined;
    for (;;) {
      if (this.closed) throw new Error("cubed is stopping");
      try {
        const answer = await transport.call("hello", {}, { timeoutMs: 45000 });
        if (answer.header.error && typeof answer.header.error === "object") last = String((answer.header.error as { message?: unknown }).message);
        else if (guestDescription(answer.header).ready) {
          this.guestProbes.set(ref.threadId, { at: Date.now(), ready: true, error: null });
          this.events.record(ref.threadId, "ready");
          this.log.info("ready", { thread: ref.threadId, vm: ref.vmId });
          return;
        } else last = "cloud-init is still running";
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      this.guestProbes.set(ref.threadId, { at: Date.now(), ready: false, error: last });
      // Each different answer once, not every poll.
      if (last !== reported) { this.events.record(ref.threadId, "guest not ready", last); reported = last; }
      if (Date.now() > deadline) {
        this.events.record(ref.threadId, "guest never became ready", `after ${Math.round(timeoutMs / 1000)} s: ${last}`);
        throw new Error(`the machine did not become ready: ${last}`);
      }
      if (Date.now() - lastInspect > 15000) {
        lastInspect = Date.now();
        const { vm, consoleTail } = await runner.vmInspect(ref);
        if (!MACHINE_STATES_LIVE.has(vm.state)) {
          this.events.record(ref.threadId, "machine stopped while booting", `${vm.state}${vm.error ? `: ${vm.error}` : ""}`);
          // An older runner sends its console raw; a guest may print anything there.
          const lines = consoleTail ? clean(consoleTail).trim().split("\n").slice(-3).join("; ").slice(0, 512) : "";
          throw new Error(`the machine stopped while booting (${vm.state})${lines ? `: ${lines}` : ""}`);
        }
      }
      await delay(2000);
    }
  }

  /** Why an attached machine's guest does not answer ready now, or null. */
  private async unanswered(thread: Thread): Promise<string | null> {
    const why = await this.hello(thread, GUEST_CHECK_TIMEOUT_MS);
    this.guestProbes.set(thread.id, { at: Date.now(), ready: !why, error: why });
    return why;
  }

  /** Why the machine's guest does not answer ready within `timeoutMs`, or null. */
  private async hello(thread: Thread, timeoutMs: number): Promise<string | null> {
    try {
      const answer = await this.guest(thread).call("hello", {}, { timeoutMs });
      if (answer.header.error && typeof answer.header.error === "object") return String((answer.header.error as { message?: unknown }).message);
      return guestDescription(answer.header).ready ? null : "its guest is not ready";
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  /** Read-only evidence about the thread's machine: cubed's events and
   * live view, the runner's evidence (`vm.diagnose`, or `vm.inspect` on a
   * runner before 0.8.3), the gateway's link, and a guest hello when the
   * gateway has the machine attached. Each part is bounded in time and
   * reports why it is missing; nothing is started, stopped or attached. */
  diagnose(thread: Thread): Promise<MachineEvidence> {
    // One at a time per thread: a client that polls never queues more than
    // one runner request and one guest hello behind the thread's own.
    let pending = this.diagnoses.get(thread.id);
    if (!pending) {
      pending = this.collect(thread).finally(() => this.diagnoses.delete(thread.id));
      this.diagnoses.set(thread.id, pending);
    }
    return pending;
  }

  private async collect(thread: Thread): Promise<MachineEvidence> {
    const vm = machine(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    // A timer of its own (AbortSignal.timeout's does not keep the process
    // alive): the deadline holds even for a call that never settles.
    const timed = async <T,>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`no answer within ${Math.round(ms / 100) / 10} s`)); }, ms);
      });
      try { return await Promise.race([work(controller.signal), late]); }
      finally { clearTimeout(timer); }
    };
    const failed = (error: unknown) => ({ status: "unavailable" as const, at: Date.now(), reason: errorText(error) });
    const runnerMs = this.options.diagnoseTimeoutMs ?? DIAGNOSE_RUNNER_MS;
    const runnerPart = async (): Promise<MachineEvidence["runner"]> => {
      if (placement(this.options.registry.getThread(thread.id) ?? thread) === "provisional") {
        return { status: "none", reason: "no allocation of this machine ever reached its runner" };
      }
      const started = Date.now();
      try {
        const client = this.runner(thread);
        try {
          const diagnosis = await timed(runnerMs, signal => client.vmDiagnose(ref, signal));
          return { status: "observed", at: Date.now(), method: "vm.diagnose", ms: Date.now() - started, diagnosis };
        } catch (error) {
          if (!(error instanceof IrohNodeError && error.code === "OPERATION_UNSUPPORTED")) throw error;
          const { vm: record, consoleTail } = await timed(Math.max(1, runnerMs - (Date.now() - started)), signal => client.vmInspect(ref, signal));
          return { status: "observed", at: Date.now(), method: "vm.inspect", ms: Date.now() - started, vm: record, consoleTail,
            note: "the runner predates vm.diagnose (cube-runner 0.8.3): only its record of the machine and the last 16 KiB of its console; "
              + "no command line, process, QMP, frame counters, qemu log or runner events" };
        }
      } catch (error) { return failed(error); }
    };
    const gatewayPart = async (): Promise<MachineEvidence["gateway"]> => {
      try {
        // Asked only if one runs: a diagnosis never starts the gateway.
        const running = this.options.gateway.running;
        if (!running) return { status: "none", reason: `no gateway runs now${this.options.gateway.unavailable ? `: ${this.options.gateway.unavailable}` : ""}` };
        const status = await timed(3000, () => running.client.status(vm.vmId));
        return status ? { status: "observed", at: Date.now(), attached: true, link: status.link, leased: status.leased, guestIp: status.guestIp,
          flows: status.flows, rxBytes: status.rxBytes, txBytes: status.txBytes, lastError: status.lastError }
          : { status: "observed", at: Date.now(), attached: false };
      } catch (error) { return failed(error); }
    };
    const [runner, gateway] = await Promise.all([runnerPart(), gatewayPart()]);
    let guest: Evidence<{ ready: boolean; ms: number; error: string | null }>;
    if (gateway.status !== "observed" || !gateway.attached) guest = { status: "none", reason: "not asked: the gateway does not have the machine attached" };
    else {
      const started = Date.now();
      const why = await this.hello(thread, this.options.diagnoseTimeoutMs ?? DIAGNOSE_GUEST_MS);
      guest = { status: "observed", at: Date.now(), ready: !why, ms: Date.now() - started, error: why };
    }
    return {
      cubed: { startInProgress: this.starting.has(thread.id), attached: this.attached.has(vm.vmId), lastGuestProbe: this.guestProbes.get(thread.id) ?? null },
      events: this.events.read(thread.id),
      runner, gateway, guest,
    };
  }

  async startupLog(thread: Thread): Promise<StartupLog | null> {
    const build = this.buildTransports.get(thread.id);
    const transport = build ?? (thread.vm && this.attached.has(thread.vm.vmId) ? this.guest(thread) : null);
    return transport ? readStartupLog(transport, build ? "build" : "thread") : null;
  }

  private async reattach(client: GatewayClient): Promise<void> {
    // SSH masters ran through the old gateway's dial; the next call opens a new one.
    await Promise.allSettled([...this.transports.values()].map(transport => transport.close()));
    for (const [vmId, spec] of this.attached) {
      try { await client.attach(vmId, spec); this.log.info("reattached", { vm: vmId }); this.events.record(spec.threadId, "gateway restarted; attached again"); }
      catch (error) { this.log.error("reattach failed", { vm: vmId, error }); this.events.record(spec.threadId, "gateway restarted; attaching again failed", error); }
    }
  }

  private runner(thread: Thread): IrohRunnerClient {
    const admission = this.options.registry.runner(thread.id);
    if (!admission) throw new Error("thread runner allocation is missing");
    return (this.options.runnerClient ?? runnerClient)(admission);
  }
  /** Nothing is bound to the thread's runner yet: no agent storage and no
   * opened workspace. Opening the workspace creates its lease store first,
   * and a cached workspace keys every guest operation by the runner. */
  private unbound(thread: Thread): boolean {
    const directory = path.join(this.options.threads, thread.id);
    return ["pi.sqlite", "claude.sqlite", "lease.sqlite"].every(name => !fs.existsSync(path.join(directory, name)));
  }
  private controlSocket(): string { return this.options.gateway.control; }
  private keyDirectory(thread: Thread): string { return path.join(this.options.threads, thread.id, "vm"); }
  private buildDirectory(thread: Thread): string { return path.join(this.options.threads, thread.id, "build"); }

  private keys(thread: Thread): Promise<MachineKeys> { return generateKeys(this.keyDirectory(thread), machine(thread).vmId); }

  /** The thread's VM epoch: increasing for every runner mutation, and at
   * least the wall clock, so a lost file still fences an older cubed. */
  private epoch(thread: Thread): number {
    const directory = this.keyDirectory(thread);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "epoch");
    const previous = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) || 0 : 0;
    const next = Math.max(previous + 1, Date.now());
    fs.writeFileSync(`${file}.tmp`, String(next), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return next;
  }
}

/** The thread's machine waits for a runner: none with a free slot can take
 * it now, or the runner that has (or may have) it does not answer. Not a
 * failure of the thread; cubed's recovery loop tries again. */
export class RunnerWait extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "RunnerWait"; }
}
/** A runner placement does not use now (its message completes "the runner …").
 * `transient`: it does not answer or is not ready, which passes; otherwise
 * it answered wrongly (configuration, protocol), which needs the operator. */
class RunnerUnusable extends Error {
  readonly transient: boolean;
  constructor(message: string, transient = true) { super(message); this.transient = transient; }
}
/** A recorded runner error that is a failed contact rather than a wrong answer. */
const CONTACT_ERROR = /^(NODE_UNAVAILABLE|COMPLETION_UNKNOWN)\b/;

/** The runner refused to create the machine before creating anything, after
 * fencing the thread's older requests: it is full or not accepting. */
function refusal(error: unknown): boolean {
  return error instanceof IrohNodeError && !error.completionUnknown && (error.remoteCode === "CAPACITY_EXCEEDED" || error.remoteCode === "DRAINING");
}
/** The runner did not answer the request (NODE_UNAVAILABLE: it was not sent). */
function contactLost(error: unknown): boolean {
  return error instanceof IrohNodeError && (error.code === "NODE_UNAVAILABLE" || error.code === "COMPLETION_UNKNOWN");
}
/** An error as a runner observation records it: an Iroh error begins with its code. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof IrohNodeError && !message.startsWith(error.code) ? `${error.code}: ${message}` : message;
}
/** Completes "the runner …". */
function unusableReason(error: unknown): string {
  if (error instanceof RunnerUnusable) return error.message;
  if (refusal(error)) return (error as IrohNodeError).remoteCode === "DRAINING" ? "is not taking new machines" : "has no room";
  return "does not answer";
}
function lifecycleText(health: TrustedRunnerHealth | null): string {
  if (!health) return "not ready";
  return health.lifecycle === "recoveryRequired" ? "waiting for operator recovery" : health.lifecycle === "ready" ? "draining" : health.lifecycle;
}

type MachineKeys = { host: { privateKey: string; publicKey: string }; clientPub: string };

/** cubed's client key and the guest's host key, generated once per machine
 * in `directory`; the host key is pinned in known_hosts. */
async function generateKeys(directory: string, vmId: string): Promise<MachineKeys> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of ["id_ed25519", "host_ed25519"]) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) continue;
    fs.rmSync(`${file}.pub`, { force: true });
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `cube-${vmId}`, "-f", file]);
  }
  const host = { privateKey: fs.readFileSync(path.join(directory, "host_ed25519"), "utf8"),
    publicKey: fs.readFileSync(path.join(directory, "host_ed25519.pub"), "utf8").trim() };
  const known = `cube-vm-${vmId} ${host.publicKey.split(" ").slice(0, 2).join(" ")}\n`;
  const knownPath = path.join(directory, "known_hosts");
  if (!fs.existsSync(knownPath) || fs.readFileSync(knownPath, "utf8") !== known) fs.writeFileSync(knownPath, known, { mode: 0o600 });
  return { host, clientPub: fs.readFileSync(path.join(directory, "id_ed25519.pub"), "utf8").trim() };
}

/** The thread (and placeholders) a machine belongs to, for the egress
 * policy: a thread's own machine or its unfinished template build machine. */
export function machineFor(registry: Registry, vmId: string): { threadId: string; placeholders: Record<string, string> } | null {
  const thread = registry.threadByVm(vmId);
  if (thread?.vm && !thread.archived) return { threadId: thread.id, placeholders: thread.vm.placeholders };
  const building = registry.threadByBuildVm(vmId);
  if (building?.vm?.build && !building.archived) return { threadId: building.id, placeholders: building.vm.build.placeholders };
  return null;
}

function machine(thread: Thread): NonNullable<Thread["vm"]> {
  if (!thread.vm) throw new Error("thread has no machine");
  return thread.vm;
}

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Repository checkouts of an allocation, relative to /workspace: the
 * primary is the workspace itself, references live in ../repos/<name>. */
function checkouts(allocation: WorkspaceAllocation): Array<{ dir: string; url: string; ref: string; oid: string }> {
  return allocation.repositories.map((repository, index) => ({
    dir: index === 0 ? "." : `../repos/${repository.checkoutName}`,
    url: repository.url,
    ref: repository.base.startsWith("refs/heads/") ? repository.base : `refs/heads/${repository.base}`,
    oid: repository.baseOid,
  }));
}

/** Shell helpers shared by the preparation and resume scripts. `hook NAME
 * FILE LOG` runs FILE (if it is executable) as the agent's account in
 * /workspace with its output in ~/.cache/cube/LOG (the previous try's moves
 * to LOG.prev) and prints `cube-hook NAME ok|failed:<exit>|absent <ms>`; the
 * same line, with the time it ended, goes to ~/.cache/cube/NAME.status for
 * `cube hooks`. While it runs, `cube-hook-start NAME` is printed and
 * ~/.cache/cube/running names it and its log (what the thread shows live). */
const HOOK_SHELL = [
  "logs=\"${HOME:-/tmp}/.cache/cube\"",
  "hooks=\"${CUBE_HOOKS:-/etc/cube/hooks}\"",
  "mkdir -p \"$logs\"",
  // A hook killed with its command (out of memory) left its marker: nothing runs yet.
  "rm -f \"$logs/running\"",
  "ms() { if [ -n \"${EPOCHREALTIME:-}\" ]; then t=${EPOCHREALTIME/[.,]/}; echo $((10#$t / 1000)); else echo $(( $(date +%s) * 1000 )); fi; }",
  "outcome() { echo \"cube-hook $1 $2 $3\"; echo \"$2 $3 $(ms)\" >\"$logs/$1.status\" 2>/dev/null || true; }",
  "hook() {",
  "  name=$1 file=$2 log=\"$logs/$3\"",
  "  if [ ! -x \"$file\" ]; then outcome \"$name\" absent 0; return 0; fi",
  "  if [ -e \"$log\" ]; then mv -f \"$log\" \"$log.prev\"; fi",
  "  echo \"cube-hook-start $name\"; echo \"$name $3\" >\"$logs/running\"",
  "  start=$(ms)",
  "  \"$file\" >\"$log\" 2>&1 </dev/null; code=$?",
  "  rm -f \"$logs/running\"",
  "  if [ \"$code\" -eq 0 ]; then outcome \"$name\" ok $(( $(ms) - start )); return 0; fi",
  "  outcome \"$name\" \"failed:$code\" $(( $(ms) - start ))",
  "  echo \"$name failed (exit $code); see $log\"; tail -n 20 \"$log\"",
  "  return 1",
  "}",
];

/** How a machine's workspace is prepared:
 * - `fresh` (a base-image disk, or a template build machine): check out the
 *   pinned commits, then the external pre-setup hook, then the repository's
 *   `.agents/setup` (only if pre-setup succeeded).
 * - `template` (an overlay on a template): bring the template's checkouts to
 *   the thread's pinned commits; pre-setup and setup are skipped, unless the
 *   pinned `.agents/setup` differs from the one the template ran
 *   (`setupBlob`), then both run here and the template is stale.
 * Hooks may fail without failing the thread (the agent can read the logs);
 * a checkout that fails does. */
export type PreparationMode = { kind: "fresh" } | { kind: "template"; setupBlob: string };

export function preparationScript(allocation: WorkspaceAllocation, mode: PreparationMode = { kind: "fresh" }): string {
  const items = checkouts(allocation);
  const lines = [
    "set -eu",
    "export GIT_TERMINAL_PROMPT=0",
    "checkout() {",
    "  dir=$1 url=$2 ref=$3 oid=$4",
    "  mkdir -p \"$dir\"",
    "  git -C \"$dir\" init -q",
    "  git -C \"$dir\" remote remove origin 2>/dev/null || true",
    "  git -C \"$dir\" remote add origin \"$url\"",
    "  git -C \"$dir\" fetch -q --no-tags origin \"+$ref:refs/remotes/origin/${ref#refs/heads/}\"",
    "  git -C \"$dir\" cat-file -e \"$oid^{commit}\" || { echo \"pinned commit $oid is not on $ref\"; exit 3; }",
    // -f: a template's checkout may hold what its setup changed.
    "  git -C \"$dir\" -c advice.detachedHead=false checkout -q -f --detach \"$oid\"",
    // A template's own history must not look like this thread's work.
    ...(mode.kind === "template" ? ["  git -C \"$dir\" reflog expire --expire=now --all"] : []),
    "}",
    ...items.map(item => `checkout ${quote(item.dir)} ${quote(item.url)} ${quote(item.ref)} ${quote(item.oid)}`),
    "set +e",
    ...HOOK_SHELL,
    "blob=$(git rev-parse -q --verify 'HEAD:.agents/setup' 2>/dev/null || echo none)",
    "echo \"cube-setup-blob $blob\"",
    "prepare() {",
    "  if hook pre-setup \"$hooks/pre-setup\" pre-setup.log; then hook setup .agents/setup setup.log",
    "  else outcome setup notrun 0; fi",
    "}",
    ...(mode.kind === "template"
      ? [`if [ "$blob" = ${quote(mode.setupBlob)} ]; then outcome pre-setup skipped 0; outcome setup skipped 0`,
        "else echo \"cube-template stale\"; prepare; fi"]
      : ["prepare"]),
    "echo provisioned",
  ];
  return lines.join("\n");
}

/** The checkout and setup of a machine made from the base image. */
export function provisionScript(allocation: WorkspaceAllocation): string { return preparationScript(allocation, { kind: "fresh" }); }

/** The resume hooks: the external pre-resume hook, then the repository's
 * `.agents/resume` (only if pre-resume succeeded). Once per machine boot,
 * before the agent uses the machine: a marker on a tmpfs records that this
 * boot resumed, and a lock keeps a second try from running beside a first
 * one that a cubed restart left running. */
export function resumeScript(): string {
  return [
    "set -u",
    ...HOOK_SHELL,
    "run=\"${CUBE_RUN:-/dev/shm/cube}\"",
    "mkdir -p \"$run\"",
    "exec 9>\"$run/resume.lock\"",
    "command -v flock >/dev/null 2>&1 && flock 9",
    "if [ -e \"$run/resumed\" ]; then echo \"cube-resume already\"; exit 0; fi",
    "if hook pre-resume \"$hooks/pre-resume\" pre-resume.log; then hook resume .agents/resume resume.log",
    "else outcome resume notrun 0; fi",
    ": >\"$run/resumed\"",
    "echo resumed",
  ].join("\n");
}

export interface PreparationOutcome {
  hooks: Record<string, HookOutcome>;
  /** The command's memory when it ended (a guest helper that reports it). */
  memory?: CommandMemory;
  /** The end of the failed hook's log, as the script printed it. */
  log?: string;
  /** The hook that had started and not ended when the command stopped. */
  running?: string;
  /** The primary checkout's `.agents/setup` blob ("none" without one). */
  setupBlob?: string;
  /** A template's setup differed from the pinned one; setup ran here. */
  stale: boolean;
  /** The checkout (or the command) failed. */
  error?: string;
}

/** Reads the `cube-hook` lines of a preparation or resume command. */
export function preparationOutcome(state: Awaited<ReturnType<typeof settleOperation>>, at = Date.now()): PreparationOutcome {
  if (state.state !== "succeeded") return { hooks: {}, stale: false, error: `the command did not finish (${state.state})` };
  const text = Buffer.from(state.output).toString("utf8");
  const hooks: Record<string, HookOutcome> = {};
  let setupBlob: string | undefined;
  // The hook that had started and not ended when the command stopped.
  let running: string | undefined;
  // The lines the script printed of the last hook that failed.
  let failureLog: string[] | null = null;
  let capturing = false;
  for (const line of text.split("\n")) {
    if (/^[a-z-]+ failed \(exit \d+\); see /.test(line)) { failureLog = []; capturing = true; continue; }
    if (line.startsWith("cube-") || line === "provisioned" || line === "resumed") capturing = false;
    else if (capturing) failureLog!.push(line);
    const started = /^cube-hook-start ([a-z-]+)$/.exec(line.trim());
    if (started) running = started[1];
    const hook = /^cube-hook ([a-z-]+) (ok|absent|skipped|notrun|failed:(\d+)) (\d+)$/.exec(line.trim());
    if (hook) {
      const status = hook[2].startsWith("failed") ? "failed" : hook[2] as HookOutcome["status"];
      hooks[hook[1]] = { status, ms: Number(hook[4]), at, ...(hook[3] ? { exitCode: Number(hook[3]) } : {}) };
      if (hook[1] === running) running = undefined;
    }
    const blob = /^cube-setup-blob ([0-9a-f]{40}|[0-9a-f]{64}|none)$/.exec(line.trim());
    if (blob) setupBlob = blob[1];
  }
  const stale = /^cube-template stale$/m.test(text);
  const memory = { ...(state.memory ? { memory: state.memory } : {}), ...(failureLog?.join("\n").trim() ? { log: stepLog(failureLog.join("\n")) } : {}),
    ...(running ? { running } : {}) };
  if (state.exitCode !== 0) {
    const what = running ?? "the preparation";
    const stopped = stoppedBecause(state);
    if (stopped) return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory, error: `${what} was stopped: ${stopped}` };
    const tail = text.trim().split("\n").filter(line => !line.startsWith("cube-")).slice(-4).join("; ");
    return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory, error: `checking out the project failed${tail ? `: ${tail}` : ""}` };
  }
  return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory };
}

/** Why a command that did not exit on its own stopped, in words; null for
 * one that exited with its own status. */
export function stoppedBecause(state: { exitCode: number | null; termination: string; serviceResult?: string; memory?: CommandMemory }): string | null {
  const oom = state.serviceResult === "oom-kill" || (state.exitCode === null && (state.memory?.oomKills ?? 0) > 0);
  if (oom) return `the machine ran out of memory${state.memory ? ` (this command used up to ${gib(state.memory.peakBytes)}; the machine has ${gib(state.memory.totalBytes)})` : ""}`;
  if (state.termination === "timedOut") return "it did not finish within 30 minutes";
  if (state.exitCode === null) return `it was killed${state.serviceResult && !["success", "exit-code", "signal"].includes(state.serviceResult) ? ` (${state.serviceResult})` : " by a signal"}`;
  return null;
}

/** A step that failed, with the memory its command reported and the end
 * of the failed hook's log. */
export class StepFailure extends Error {
  readonly memory: CommandMemory | undefined;
  log: string | undefined;
  constructor(message: string, memory?: CommandMemory, log?: string) { super(message); this.name = "StepFailure"; this.memory = memory; this.log = log; }
}

/** The last lines of a log as a step keeps them: escaped, redacted, bounded. */
export function stepLog(text: string): string {
  return clean(text.trimEnd().split("\n").slice(-20).join("\n"), STEP_LOG_BYTES * 2).slice(-STEP_LOG_BYTES);
}

export const MIB = 1024 * 1024;
/** Bytes as GB with one decimal ("3.5 GB"), or MB below one GB. */
export function gib(bytes: number): string {
  return bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(1)} GB` : `${Math.round(bytes / MIB)} MB`;
}
/** A duration as whole minutes ("12 min", "under a minute"). */
function minutes(ms: number): string {
  const whole = Math.round(ms / 60000);
  return whole < 1 ? "under a minute" : `${whole} min`;
}
/** The hooks' outcomes in a few words ("pre-setup ok, setup absent"). */
function hookSummary(hooks: Record<string, HookOutcome>): string {
  return Object.entries(hooks).map(([name, hook]) => `${name} ${hook.status}${hook.exitCode !== undefined ? ` (exit ${hook.exitCode})` : ""}`).join(", ");
}

/** The release check: clean means every checkout is at its pinned commit
 * with no changes, branches, stashes or commits of its own, an empty project
 * left /workspace empty, and no other command runs. Prints `clean` or
 * `dirty: <reason>`. */
export function releaseCheckScript(allocation: WorkspaceAllocation): string {
  const items = checkouts(allocation);
  const lines = [
    "set -u",
    "dirty() { echo \"dirty: $*\"; exit 0; }",
    "check() {",
    "  dir=$1 oid=$2",
    "  [ -e \"$dir/.git\" ] || dirty \"$dir is not a checkout\"",
    "  [ \"$(git -C \"$dir\" rev-parse HEAD 2>/dev/null)\" = \"$oid\" ] || dirty \"$dir is not at its pinned commit\"",
    "  [ -z \"$(git -C \"$dir\" status --porcelain 2>&1)\" ] || dirty \"$dir has changes\"",
    "  [ -z \"$(git -C \"$dir\" for-each-ref refs/heads refs/tags --format=x 2>&1)\" ] || dirty \"$dir has branches or tags of its own\"",
    "  [ -z \"$(git -C \"$dir\" stash list 2>&1)\" ] || dirty \"$dir has stashes\"",
    "  [ -z \"$(git -C \"$dir\" rev-list --all --reflog --not --remotes \"$oid\" 2>&1)\" ] || dirty \"$dir has commits of its own\"",
    "}",
    ...(items.length ? items.map(item => `check ${quote(item.dir)} ${quote(item.oid)}`)
      : ["[ -z \"$(ls -A . 2>&1)\" ] || dirty \"the workspace is not empty\""]),
    "if command -v systemctl >/dev/null 2>&1; then",
    "  running=$(systemctl list-units --plain --no-legend --state=active,activating,deactivating 'cube-op-*' 2>/dev/null | wc -l)",
    "  [ \"$running\" -le 1 ] || dirty \"another command is still running\"",
    "fi",
    "echo clean",
  ];
  return lines.join("\n");
}

/** Runs one of cubed's own commands in the thread workspace under a fresh
 * lease and a fixed key; reattaches to it when the key already ran. These
 * are not the agent's changes. */
async function own(workspace: VmWorkspace, owner: WorkspaceOwner, key: string | ((epoch: number) => string), command: string, timeoutMs: number) {
  const lease = await workspace.lease({ owner });
  try {
    if (typeof key !== "string") key = key(lease.epoch);
    await workspace.execOwn(lease.token, key, { command, timeoutMs });
    return await settleOperation(workspace, lease.token, key);
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Checks out the thread's pinned repositories once and prepares the
 * workspace (see `preparationScript`). `attempt` numbers the try: a failed
 * one is never rerun under its key, a new try gets a new key. */
export async function provisionWorkspace(workspace: VmWorkspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation, attempt: number,
  mode: PreparationMode = { kind: "fresh" }): Promise<PreparationOutcome> {
  // The skills first: a try that checked out is not run again (`provisioned`).
  if (allocation.skills) {
    for (const [index, script] of skillInstallScripts(allocation.skills).entries()) {
      const installed = await own(workspace, owner, `cube:skills:${attempt}:${index}`, script, 600000);
      if (installed.state !== "succeeded") throw new StepFailure(`installing the thread's skills did not finish (${installed.state})`);
      if (installed.exitCode !== 0) {
        const output = Buffer.from(installed.output).toString("utf8").trim().split("\n").slice(-3).join("; ");
        throw new StepFailure(`installing the thread's skills failed (exit ${installed.exitCode}): ${output}`);
      }
    }
  }
  const state = await own(workspace, owner, `cube:provision:${attempt}`, preparationScript(allocation, mode), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new StepFailure(outcome.error, outcome.memory, outcome.log);
  return outcome;
}

/** The outcome of a provisioning try that already ran (null: none ran
 * under this key; a try still running is waited for). */
export async function provisioned(workspace: VmWorkspace, owner: WorkspaceOwner, attempt: number): Promise<PreparationOutcome | null> {
  const lease = await workspace.lease({ owner });
  try {
    return preparationOutcome(await settleOperation(workspace, lease.token, `cube:provision:${attempt}`));
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return null;
    throw error;
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Runs the resume hooks for this boot of the machine (see `resumeScript`). */
export async function resumeWorkspace(workspace: VmWorkspace, owner: WorkspaceOwner): Promise<{ hooks: Record<string, HookOutcome>; already: boolean; memory?: CommandMemory; log?: string }> {
  const state = await own(workspace, owner, epoch => `cube:resume:${epoch}`, resumeScript(), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new StepFailure(outcome.error.replace("checking out the project failed", "the resume hooks did not run").replace("the preparation was", "the resume hooks were"), outcome.memory, outcome.log);
  return { hooks: outcome.hooks, already: state.state === "succeeded" && /^cube-resume already$/m.test(Buffer.from(state.output).toString("utf8")),
    ...(outcome.memory ? { memory: outcome.memory } : {}), ...(outcome.log ? { log: outcome.log } : {}) };
}

/** Base64 per bootstrap command: the helper takes commands up to 8 KiB. */
const BOOTSTRAP_CHUNK = 6000;

/** Commands that put `source` in place of a helper from before `install`
 * existed (and with it the `cube` command): the gzipped helper in chunks
 * under /var/tmp, checked against its sha256, then the new helper's own
 * `install` as root. Each is an ordinary command of cubed's. */
export function helperBootstrapScripts(source: Buffer): string[] {
  const sha256 = createHash("sha256").update(source).digest("hex");
  const directory = `/var/tmp/cube-helper-${sha256.slice(0, 16)}`;
  const encoded = gzipSync(source).toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += BOOTSTRAP_CHUNK) chunks.push(encoded.slice(offset, offset + BOOTSTRAP_CHUNK));
  return [
    ...chunks.map((chunk, index) => `set -e\nmkdir -p ${directory}\nprintf '%s' '${chunk}' > ${directory}/${index}`),
    ["set -e", `d=${directory}`,
      `cat ${chunks.map((_, index) => `"$d/${index}"`).join(" ")} | base64 -d | gunzip > "$d/helper"`,
      `echo "${sha256}  $d/helper" | sha256sum -c --quiet`,
      `{ printf '{"sha256":"${sha256}","length":%d}\\n' "$(stat -c %s "$d/helper")"; cat "$d/helper"; } | sudo -n /usr/bin/python3 "$d/helper" call install`,
      "rm -rf \"$d\""].join("\n"),
  ];
}

/** Brings the machine's guest helper, and with it the agent's `cube`
 * command, to the one this cubed ships, then tells it the portal's settings.
 * A fresh machine has it from its seed already; a machine made before this
 * cubed (a cubed update, a reused disk) gets it here. Runs with the
 * workspace lease free (before the agent opens). */
export async function refreshGuest(workspace: VmWorkspace, owner: WorkspaceOwner, portal: GuestPortal): Promise<"current" | "installed" | "bootstrapped"> {
  const shipped = shippedHelper();
  const description = await workspace.describe();
  let outcome: "current" | "installed" | "bootstrapped" = "current";
  if (description.build !== shipped.sha256) {
    if (description.capabilities.includes("helper.install")) {
      await workspace.installHelper(shipped.source);
      outcome = "installed";
    } else {
      const lease = await workspace.lease({ owner });
      try {
        for (const [index, command] of helperBootstrapScripts(shipped.source).entries()) {
          const key = `cube:helper:${lease.epoch}:${index}`;
          await workspace.execOwn(lease.token, key, { command, timeoutMs: 120000 });
          const state = await settleOperation(workspace, lease.token, key);
          if (state.state !== "succeeded" || state.exitCode !== 0) {
            const output = state.state === "succeeded" ? Buffer.from(state.output).toString("utf8").trim().slice(-300) : state.state;
            throw new Error(`installing the guest helper failed: ${output}`);
          }
        }
      } finally { await workspace.release(lease.token).catch(() => {}); }
      workspace.forget();
      outcome = "bootstrapped";
    }
    const after = await workspace.describe();
    if (after.build !== shipped.sha256) throw new Error("the machine still runs another guest helper");
  }
  await workspace.configurePortal(portal);
  return outcome;
}

/** What the machine reports about its work at archive. The guest is
 * agent-controlled: `clean` alone never decides deletion (see
 * Conversations.archive), any other answer keeps the disk. */
export async function releaseCheck(workspace: VmWorkspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation): Promise<{ clean: boolean; reason: string }> {
  const state = await own(workspace, owner, epoch => `cube:release-check:${epoch}`, releaseCheckScript(allocation), 120000);
  if (state.state !== "succeeded" || state.exitCode !== 0) return { clean: false, reason: `the release check did not finish (${state.state})` };
  const output = Buffer.from(state.output).toString("utf8").trim();
  return output === "clean" ? { clean: true, reason: "clean" } : { clean: false, reason: output.replace(/^dirty: /, "") || "unknown" };
}
