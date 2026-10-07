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
import { IrohNodeError, runnerClient, type IrohRunnerClient, type RunnerDescription, type RunnerTemplate, type VmRecord, type VmRef } from "./iroh-node.ts";
import { createLogger, type Logger } from "./log.ts";
import { NO_HOOKS, threadAgent, type HookOutcome, type Registry, type Thread, type WorkspaceAllocation } from "./registry.ts";
import { newPlaceholder, type EgressVms } from "./egress-policy.ts";
import { guestDescription, VmWorkspace, type GuestPortal } from "./vm-workspace.ts";
import { GUEST_HELPER_PATH, shippedHelper, vmMac, vmSeed } from "./vm-seed.ts";
import { FAILED_BUILD_BACKOFF_MS, TEMPLATE_CAPABILITY, TEMPLATE_FORMAT, obsoleteTemplates, pickTemplate, templateKey, templateSettings,
  type TemplateMeta, type TemplateSettings } from "./vm-template.ts";
import { LeaseStore } from "./workspace-lease.ts";
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
const MACHINE_STATES_LIVE = new Set(["starting", "running"]);

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
}

export class ThreadVms implements ThreadMachines, EgressVms {
  private readonly options: ThreadVmsOptions;
  private readonly log: Logger;
  private readonly sizes: VmSizes;
  private readonly controls: string;
  private readonly attached = new Map<string, GatewayAttach>();
  private readonly transports = new Map<string, SshGuestTransport>();
  private readonly starting = new Map<string, Promise<MachineStart>>();
  private readonly templates: TemplateSettings;
  /** Template builds under way, by runner and key: one at a time. */
  private readonly builds = new Map<string, Promise<unknown>>();
  /** When a build of a runner and key last failed. */
  private readonly failedBuilds = new Map<string, number>();
  private closed = false;

  constructor(options: ThreadVmsOptions) {
    this.options = options;
    this.log = options.log ?? createLogger("vm");
    this.sizes = options.sizes ?? vmSizes();
    this.controls = controlDirectory(options.run);
    this.templates = options.templates ?? templateSettings();
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
    const starting = this.boot(thread, false, options.onBoot).finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, starting);
    return starting;
  }

  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    const vm = machine(thread);
    const runner = this.runner(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    await this.abandonBuild(thread, runner);
    await this.transports.get(thread.id)?.close();
    this.transports.delete(thread.id);
    this.attached.delete(vm.vmId);
    try { await (await this.options.gateway.ready(5000)).client.detach(vm.vmId); }
    catch (error) { this.log.warn("detach failed", { thread: thread.id, error }); }
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
    return { retained: record.state === "retained" };
  }

  async discard(thread: Thread): Promise<void> {
    const vm = machine(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    const record = await this.runner(thread).vmDiscard(ref, this.epoch(thread));
    if (record.state !== "released") throw new Error(`the runner did not discard the machine (${record.state})`);
    fs.rmSync(this.keyDirectory(thread), { recursive: true, force: true });
    this.log.info("discarded", { thread: thread.id, vm: vm.vmId });
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

  private async boot(thread: Thread, relocated = false, onBoot?: () => void): Promise<MachineStart> {
    const vm = machine(thread);
    const runner = this.runner(thread);
    const target = runner.target;
    await this.options.gateway.ensureNetwork(target.network);
    const { client: gateway, hello } = await this.options.gateway.ready();
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    if (this.attached.has(vm.vmId)) {
      // Already started by this process: only check that it still runs.
      const [{ vm: current }, status] = await Promise.all([runner.vmInspect(ref), gateway.status(vm.vmId)]);
      if (current.state === "running" && status) return { booted: false };
      this.attached.delete(vm.vmId);
      this.log.warn("machine is not running; starting it again", { thread: thread.id, vm: vm.vmId, state: current.state });
    }
    onBoot?.();
    const description = await runner.describe();
    // The runner's bound may have changed since cubed last asked.
    this.options.registry.recordRunnerSlots(thread.runnerId, description.limits.maxActiveVms);
    const sizes = {
      vcpus: Math.min(this.sizes.vcpus, description.limits.maxVcpus),
      memoryMiB: Math.min(this.sizes.memoryMiB, description.limits.maxMemoryMiB),
      diskGiB: Math.min(this.sizes.diskGiB, description.limits.maxDiskGiB),
    };
    let record: VmRecord;
    try { record = (await runner.vmInspect(ref)).vm; }
    catch (error) {
      if (!(error instanceof IrohNodeError && error.code === "NOT_FOUND")) throw error;
      const allocating = Date.now();
      try {
        // Decide what the disk is made from (building a template first if
        // the project has none on this runner), then allocate it.
        thread = await this.prepare(thread, runner, description, sizes, hello.caPem);
        record = await this.allocate(thread, runner, ref, sizes.diskGiB);
      } catch (cause) {
        if (!(cause instanceof IrohNodeError && cause.remoteCode === "CAPACITY_EXCEEDED")) throw cause;
        // cubed's count said a slot was free; the runner (a lowered bound, a
        // full disk, a machine cubed does not know) disagrees. Nothing was
        // created there, so a thread whose agent has not bound its storage
        // to this runner yet moves to one with room, once.
        const moved = !relocated && this.unbound(thread) ? this.options.registry.relocateThread(thread.id) : null;
        if (moved) {
          this.log.warn("runner full; thread moved", { thread: thread.id, from: thread.runnerId, to: moved });
          return this.boot(this.options.registry.getThread(thread.id)!, true);
        }
        const why = cause.message === "CAPACITY_EXCEEDED" ? `it hosts at most ${description.limits.maxActiveVms} machines` : cause.message;
        throw new Error(`the runner has no room for this thread's machine (${why}); cube tries again every 30 seconds`, { cause });
      }
      const preparation = this.options.registry.getThread(thread.id)!.vm!.preparation!;
      this.phase(thread, "allocate", allocating);
      this.log.info("allocated", { thread: thread.id, vm: vm.vmId, diskGiB: sizes.diskGiB, source: preparation.source,
        ...(preparation.templateId ? { template: preparation.templateId } : {}), ...(preparation.reason ? { reason: preparation.reason } : {}) });
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
    record = await runner.vmStart(ref, this.epoch(thread), { vcpus: sizes.vcpus, memoryMiB: sizes.memoryMiB, mac, seed, gateway: { peer: hello.peer, frameToken } });
    if (!MACHINE_STATES_LIVE.has(record.state)) {
      throw new Error(`the thread machine did not start${record.error ? `: ${record.error.trim().split("\n").slice(-3).join("; ")}` : ""}`);
    }
    const spec: GatewayAttach = { threadId: thread.id, runner: target, frameToken, mac };
    await gateway.attach(vm.vmId, spec);
    this.attached.set(vm.vmId, spec);
    this.log.info("started", { thread: thread.id, vm: vm.vmId, state: record.state, runner: runner.nodeId });
    await this.waitReady(this.guest(thread), runner, ref);
    if (first) this.phase(thread, "boot", booting);
    return { booted };
  }

  /** Allocates the thread's disk as its preparation says. A template that
   * vanished meanwhile (removed, expired) falls back to the base image. */
  private async allocate(thread: Thread, runner: IrohRunnerClient, ref: VmRef, diskGiB: number): Promise<VmRecord> {
    const preparation = thread.vm!.preparation!;
    try { return await runner.vmAllocate(ref, this.epoch(thread), diskGiB, preparation.templateId); }
    catch (error) {
      if (!(preparation.templateId && error instanceof IrohNodeError && error.remoteCode === "NOT_FOUND")) throw error;
      this.log.warn("template gone; starting fresh", { thread: thread.id, template: preparation.templateId });
      const updated = this.options.registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason: "the template was removed before the machine was allocated" } });
      return runner.vmAllocate(ref, this.epoch(updated), diskGiB);
    }
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
    await this.abandonBuild(thread, runner);
    const fresh = (reason: string) => this.options.registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason } });
    if (!this.templates.enabled) return fresh("templates are off (CUBED_TEMPLATES=off)");
    if (!description.capabilities.includes(TEMPLATE_CAPABILITY)) return fresh("the runner has no machine templates (cube-runner 0.8.0+)");
    const hooks = thread.allocation.hooks ?? NO_HOOKS;
    const key = templateKey({ allocation: thread.allocation, hooks, runner: description, diskGiB: sizes.diskGiB });
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
    if (found) return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: found.id, setupBlob: found.meta.setupBlob } });
    const flight = `${thread.runnerId}:${key}`;
    // One build per runner and key: a thread that comes meanwhile starts fresh.
    if (this.builds.has(flight)) return fresh("another thread is preparing this project's template");
    const failed = this.failedBuilds.get(flight);
    if (failed !== undefined && now - failed < FAILED_BUILD_BACKOFF_MS) return fresh("the project's last template build failed");
    const building = this.build(thread, runner, sizes, caPem, key);
    this.builds.set(flight, building);
    try {
      const template = await building;
      this.failedBuilds.delete(flight);
      return this.options.registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: template.id, setupBlob: template.meta.setupBlob } });
    } catch (error) {
      // No room: the caller may move the thread; cubed stopping: retried later.
      if ((error instanceof IrohNodeError && error.remoteCode === "CAPACITY_EXCEEDED") || this.closed) throw error;
      this.failedBuilds.set(flight, Date.now());
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn("template build failed; starting fresh", { thread: thread.id, runner: runner.nodeId, error: message });
      return fresh(`the template build failed: ${message}`);
    } finally { this.builds.delete(flight); }
  }

  /** Builds a template for `key` on the thread's runner, in the thread's
   * slot, before the thread's own machine exists: a build machine with its
   * own throwaway identity (VM id, keys, placeholders) boots from the base
   * image, cubed checks out the pinned commits and runs pre-setup and
   * `.agents/setup` in it, seals it and powers it off, and the runner
   * publishes its disk. Anything short of that success publishes nothing
   * and the build machine is deleted. */
  private async build(thread: Thread, runner: IrohRunnerClient, sizes: VmSizes, caPem: string, key: string): Promise<{ id: string; meta: TemplateMeta }> {
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
      await this.waitReady(transport, runner, ref);
      phases["build-boot"] = Date.now() - since;

      // cubed's own commands: the build machine never has an agent.
      since = Date.now();
      leases = new LeaseStore(path.join(directory, "lease"));
      const owner = threadAgent(thread);
      const workspace = new VmWorkspace({ guest: transport, leases, owner, binding: JSON.stringify({ build: build.vmId, thread: thread.id }) });
      const prepared = await own(workspace, owner, "cube:build:prepare", preparationScript(thread.allocation, { kind: "fresh" }), 1800000);
      const outcome = preparationOutcome(prepared);
      if (outcome.error) throw new Error(outcome.error);
      const failedHook = Object.entries(outcome.hooks).find(([, hook]) => hook.status === "failed");
      if (failedHook) throw new Error(`${failedHook[0]} failed (exit ${failedHook[1].exitCode}) in the build machine`);
      phases["build-prepare"] = Date.now() - since;

      since = Date.now();
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

      since = Date.now();
      const meta: TemplateMeta = { format: TEMPLATE_FORMAT, projectId: thread.allocation.projectId, setupBlob: outcome.setupBlob ?? "none",
        commit: thread.allocation.repositories[0]?.baseOid ?? null };
      let template: RunnerTemplate;
      try { template = await runner.vmPublish(ref, this.epoch(thread), key, JSON.stringify(meta)); }
      catch (error) {
        // The answer was lost: publishing is idempotent, so ask again once.
        if (!(error instanceof IrohNodeError && error.completionUnknown)) throw error;
        template = await runner.vmPublish(ref, this.epoch(thread), key, JSON.stringify(meta));
      }
      published = true;
      phases["build-publish"] = Date.now() - since;
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
    } finally {
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
  private async waitReady(transport: GuestTransport, runner: IrohRunnerClient, ref: VmRef): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    let lastInspect = Date.now();
    let last: string;
    for (;;) {
      if (this.closed) throw new Error("cubed is stopping");
      try {
        const answer = await transport.call("hello", {}, { timeoutMs: 45000 });
        if (answer.header.error && typeof answer.header.error === "object") last = String((answer.header.error as { message?: unknown }).message);
        else if (guestDescription(answer.header).ready) { this.log.info("ready", { thread: ref.threadId, vm: ref.vmId }); return; }
        else last = "cloud-init is still running";
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      if (Date.now() > deadline) throw new Error(`the machine did not become ready: ${last}`);
      if (Date.now() - lastInspect > 15000) {
        lastInspect = Date.now();
        const { vm, consoleTail } = await runner.vmInspect(ref);
        if (!MACHINE_STATES_LIVE.has(vm.state)) {
          throw new Error(`the machine stopped while booting (${vm.state})${consoleTail ? `: ${consoleTail.trim().split("\n").slice(-3).join("; ")}` : ""}`);
        }
      }
      await delay(2000);
    }
  }

  private async reattach(client: GatewayClient): Promise<void> {
    // SSH masters ran through the old gateway's dial; the next call opens a new one.
    await Promise.allSettled([...this.transports.values()].map(transport => transport.close()));
    for (const [vmId, spec] of this.attached) {
      try { await client.attach(vmId, spec); this.log.info("reattached", { vm: vmId }); }
      catch (error) { this.log.error("reattach failed", { vm: vmId, error }); }
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
 * /workspace with its output in ~/.cache/cube/LOG and prints
 * `cube-hook NAME ok|failed:<exit>|absent <ms>`. */
const HOOK_SHELL = [
  "logs=\"${HOME:-/tmp}/.cache/cube\"",
  "hooks=\"${CUBE_HOOKS:-/etc/cube/hooks}\"",
  "mkdir -p \"$logs\"",
  "ms() { if [ -n \"${EPOCHREALTIME:-}\" ]; then t=${EPOCHREALTIME/[.,]/}; echo $((10#$t / 1000)); else echo $(( $(date +%s) * 1000 )); fi; }",
  "hook() {",
  "  name=$1 file=$2 log=\"$logs/$3\"",
  "  if [ ! -x \"$file\" ]; then echo \"cube-hook $name absent 0\"; return 0; fi",
  "  start=$(ms)",
  "  \"$file\" >\"$log\" 2>&1 </dev/null; code=$?",
  "  if [ \"$code\" -eq 0 ]; then echo \"cube-hook $name ok $(( $(ms) - start ))\"; return 0; fi",
  "  echo \"cube-hook $name failed:$code $(( $(ms) - start ))\"",
  "  echo \"$name failed (exit $code); see $log\"; tail -n 5 \"$log\"",
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
    "  else echo \"cube-hook setup notrun 0\"; fi",
    "}",
    ...(mode.kind === "template"
      ? [`if [ "$blob" = ${quote(mode.setupBlob)} ]; then echo "cube-hook pre-setup skipped 0"; echo "cube-hook setup skipped 0"`,
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
    "else echo \"cube-hook resume notrun 0\"; fi",
    ": >\"$run/resumed\"",
    "echo resumed",
  ].join("\n");
}

export interface PreparationOutcome {
  hooks: Record<string, HookOutcome>;
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
  for (const line of text.split("\n")) {
    const hook = /^cube-hook ([a-z-]+) (ok|absent|skipped|notrun|failed:(\d+)) (\d+)$/.exec(line.trim());
    if (hook) {
      const status = hook[2].startsWith("failed") ? "failed" : hook[2] as HookOutcome["status"];
      hooks[hook[1]] = { status, ms: Number(hook[4]), at, ...(hook[3] ? { exitCode: Number(hook[3]) } : {}) };
    }
    const blob = /^cube-setup-blob ([0-9a-f]{40}|[0-9a-f]{64}|none)$/.exec(line.trim());
    if (blob) setupBlob = blob[1];
  }
  const stale = /^cube-template stale$/m.test(text);
  if (state.exitCode !== 0) {
    const tail = text.trim().split("\n").filter(line => !line.startsWith("cube-")).slice(-4).join("; ");
    return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), error: `checking out the project failed${tail ? `: ${tail}` : ""}` };
  }
  return { hooks, stale, ...(setupBlob ? { setupBlob } : {}) };
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
  const state = await own(workspace, owner, `cube:provision:${attempt}`, preparationScript(allocation, mode), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new Error(outcome.error);
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
export async function resumeWorkspace(workspace: VmWorkspace, owner: WorkspaceOwner): Promise<{ hooks: Record<string, HookOutcome>; already: boolean }> {
  const state = await own(workspace, owner, epoch => `cube:resume:${epoch}`, resumeScript(), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new Error(outcome.error.replace("checking out the project failed", "the resume hooks did not run"));
  return { hooks: outcome.hooks, already: state.state === "succeeded" && /^cube-resume already$/m.test(Buffer.from(state.output).toString("utf8")) };
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
