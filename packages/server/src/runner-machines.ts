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
 * A thread is on `berth host` only because it was started there by name,
 * and on `berth vm` by name or from the pool (registry.ts pooledRunner).
 * Either way it never moves, and while the runner is down it waits
 * (RunnerWait).
 *
 * On `berth vm` a new machine starts from its project's template on that
 * runner when there is one (vm-template.ts): the newest
 * fresh one for its key, or one built now in the thread's slot before its
 * own machine exists, or the base. The build machine is cubed's own: its
 * own id and placeholders (`vm.build`), made from the base with a template
 * disk (`MachineSpec.build`); only cubed's checkout, pre-setup and
 * `.agents/setup` run in it, never an agent; then `template_publish`, where
 * keel cleans and checks its writable layer itself (there is no seal) and
 * berth keeps the layer as the template and deletes the build machine (so
 * cubed only forgets it). A build that fails before that is deleted and the
 * thread starts from the base, with the reason. `berth host` has no templates.
 *
 * Suspend (masterplan S-7a, P7-5; B7-1…B7-5): a running machine on a `berth
 * vm` that says `machine.suspend` is suspended after IDLE_MS without
 * activity (machine-idle.ts) while the conversation finds nothing running
 * (`suspendIfIdle`); it then holds no slot. Any guest call, a portal
 * connection or a start wakes it (`machine_start`): with a full runner the
 * thread waits, saying so, and tries again. A runner that cannot use the
 * snapshot starts the machine from its disk (`SnapshotDropped`), which the
 * thread shows as a notice. A runner that refuses the suspend (busy, short
 * of disk, a failed save) keeps the machine running.
 *
 * A thread whose runner was enrolled with protocol 3 (runner-select.ts
 * `retiredRunner`) is never contacted. `start`, `guest`, `release`,
 * `discard`, `diagnose`, `startupLog`, `invalidateTemplate`, `suspended`
 * and `settleWake` check it first: a start, guest call, diagnosis or
 * discard is refused with PROTOCOL_3_RETIRED, a release succeeds at once
 * and counts the disk of a machine that was allocated as kept, the rest
 * answer as for a machine that never ran. Every other path to its runner
 * fails closed in `session`. protocol3-port-test.ts pins both, member by
 * member. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { MachineStatus_Phase, Runner_Kind, Template_State, type EgressPolicySchema, type GuestInfo, type Machine, type Runner, type SizeSchema,
  type Template } from "./gen/runner_pb.js";
import { GuestTransportError, type GuestTransport } from "./guest-transport.ts";
import type { RunnerTemplate } from "./runner-types.ts";
import { createLogger, type Logger } from "./log.ts";
import { newPlaceholder } from "./egress-policy.ts";
import { NO_HOOKS, placement, threadAgent, type HookOutcome, type Registry, type StartupStep, type Thread } from "./registry.ts";
import { closeRunnerSessions, machineKey, RunnerError, runnerSession, type MachineRef, type RunnerSession } from "./runner-session.ts";
import { PROTOCOL_3_RETIRED, retiredRunner } from "./runner-select.ts";
import { currentMachineEpoch, gib, nextMachineEpoch, preparationOutcome, preparationScript, readStartupLog, RunnerWait, StepFailure, stepLog, vmSizes,
  type GuestHooks, type MachineStart, type StartOptions, type StartupLog, type ThreadMachines, type VmSizes } from "./vm.ts";
import { MachineEvents, safeText, type GuestAgent, type MachineEvidence } from "./vm-diagnostics.ts";
import { bootDocuments, MAX_BOOT_BYTES } from "./vm-seed.ts";
import { FAILED_BUILD_BACKOFF_MS, KEEL_TEMPLATE_CAPABILITIES, TEMPLATE_FORMAT, keelTemplateKey, keelTemplateParts, missingTemplate, obsoleteTemplates, pickTemplate, runnerCaSha256,
  templateMeta, templateSettings, type TemplateMeta, type TemplateParts, type TemplateSettings } from "./vm-template.ts";
import { guestServices, VmWorkspace } from "./vm-workspace.ts";
import { IDLE_MS, MachineActivity } from "./machine-idle.ts";
import { holdsSlot } from "./machine-sleep.ts";
import { LeaseStore } from "./workspace-lease.ts";
import { settleOperation, type WorkspaceOwner } from "./workspace.ts";

/** How long a machine's guest has to report ready in the runner's watch. */
const READY_TIMEOUT_MS = 2 * 60 * 1000;
/** The most of a runner's diagnosis cubed keeps (berth vm's own bound). */
const MAX_DIAGNOSIS_BYTES = 256 * 1024;
/** The longest reason for a guest that is not ready cubed shows. */
const MAX_REASON = 512;
/** keel's hooks (hooks.rs `HOOKS`), the only names a guest's outcomes are shown for. */
const HOOK_NAMES = ["pre-setup", "setup", "pre-resume", "resume"];
/** How long cubed's preparation command in a build machine may run. */
const BUILD_PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
/** What a runner says it can do when it suspends machines (berth vm with
 * `--suspend-disk-margin-gib`). */
const SUSPEND_CAPABILITY = "machine.suspend";
/** `machine_suspend`'s wait (K-8): berth gives a save 60 s and its undo
 * more; past this cubed asks the runner what became of the machine. */
const SUSPEND_TIMEOUT_MS = 90000;
/** A suspend the runner refused for want of disk or a failed save is not
 * tried again for this long; the machine keeps running meanwhile. */
const SUSPEND_RETRY_MS = 30 * 60 * 1000;
/** B7-5: what a thread shows when its snapshot could not be used. */
const RESTARTED_AFTER_UPDATE = "restarted after an update; running commands were interrupted";
const RESTARTED = "restarted from its disk: its saved state could not be restored; running commands were interrupted";

/** A runner's template as vm-template.ts reads it. */
function listedTemplate(template: Template): RunnerTemplate {
  const created = template.createdAt;
  return { id: template.id, key: template.key, meta: template.meta,
    state: template.state === Template_State.READY ? "ready" : template.state === Template_State.REMOVING ? "removing" : "publishing",
    diskGiB: template.diskGib, bytes: Number(template.bytes), createdAt: created ? Number(created.seconds) * 1000 + Math.floor(created.nanos / 1e6) : 0,
    users: template.users };
}

/** Why the runner would not make a machine from the template, as the
 * thread's reason to start from the base; null for any other refusal. */
function templateRefused(error: unknown, id: string): string | null {
  if (!(error instanceof RunnerError)) return null;
  if (error.code === "NOT_FOUND") return `template ${id} was removed before the machine was created`;
  if (error.code === "FAILED_PRECONDITION" && error.reason === "template_removing") return `template ${id} was being removed when the machine was created`;
  if (error.code === "FAILED_PRECONDITION" && error.reason === "template_image_changed") return `the runner's image changed since template ${id} was prepared`;
  if (error.code === "FAILED_PRECONDITION" && error.reason === "template_runner_ca_changed") return `the runner's CA changed since template ${id} was prepared`;
  return null;
}

/** Runs one of cubed's own commands in a build machine under a fresh lease
 * and a fixed key (as vm.ts `own`); reattaches to it when the key already ran. */
async function own(workspace: VmWorkspace, owner: WorkspaceOwner, key: string, command: string, timeoutMs: number) {
  const lease = await workspace.lease({ owner });
  try {
    await workspace.execOwn(lease.token, key, { command, timeoutMs });
    return await settleOperation(workspace, lease.token, key);
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

function minutes(ms: number): string {
  const whole = Math.round(ms / 60000);
  return whole < 1 ? "under a minute" : `${whole} min`;
}
function hookSummary(hooks: Record<string, HookOutcome>): string {
  return Object.entries(hooks).map(([name, hook]) => `${name} ${hook.status}${hook.exitCode !== undefined ? ` (exit ${hook.exitCode})` : ""}`).join(", ");
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  // runner-ca: keel's check of Java's keystore at this boot's setup (ok, repaired, skipped, failed).
  const hooks = Object.fromEntries([...HOOK_NAMES, "runner-ca"].filter(name => guest.hooks[name] !== undefined).map(name => [name, safeText(guest.hooks[name]!, 32)]));
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
  /** Tests: how long a machine must be idle before it is suspended (IDLE_MS). */
  idleMs?: number;
  /** Tests: the clock of the machines' activity. */
  now?: () => number;
  /** Tests: how often and how long a wake tries a full runner. */
  /** Tests: `machine_suspend`'s wait (SUSPEND_TIMEOUT_MS). */
  suspendTimeoutMs?: number;
  /** Machine templates on VM runners (default: from CUBED_TEMPLATES and CUBED_TEMPLATE_TTL_HOURS). */
  templates?: TemplateSettings;
}

export class RunnerMachines implements ThreadMachines {
  private readonly options: RunnerMachinesOptions;
  private readonly log: Logger;
  private readonly events: MachineEvents;
  /** The runner boot each thread's machine was last started in. */
  private readonly boots = new Map<string, string>();
  private readonly starting = new Map<string, Promise<MachineStart>>();
  private readonly templates: TemplateSettings;
  /** Template builds under way, by runner and key: one at a time. */
  private readonly builds = new Map<string, Promise<unknown>>();
  /** When a build of a runner, key, machine size and commit last failed, and why. */
  private readonly failedBuilds = new Map<string, { at: number; error: string }>();
  /** The guest of each thread's build machine while cubed prepares it. */
  private readonly buildGuests = new Map<string, GuestTransport>();
  /** What cubed sees of each thread's machine (machine-idle.ts). */
  readonly activity: MachineActivity;
  /** Suspends under way: a guest call waits for one, then wakes the machine. */
  private readonly suspending = new Map<string, Promise<void>>();
  /** Runners that answered `machine_suspend` with no such verb (K-6), by
   * the software version that did: a new release is asked again. */
  private readonly noSuspend = new Map<string, string>();
  /** Runners with a suspend under way: one at a time per runner (B-207-3). */
  private readonly suspendingOn = new Set<string>();
  /** When a refused suspend may be tried again, by thread. */
  private readonly suspendRetry = new Map<string, number>();

  constructor(options: RunnerMachinesOptions) {
    this.options = options;
    this.log = options.log ?? createLogger("runner-machines");
    this.events = new MachineEvents(options.threads);
    this.templates = options.templates ?? templateSettings();
    this.activity = new MachineActivity(options.now);
  }

  /** The thread's runner is one cubed never contacts (runner-select.ts).
   * Protected only so protocol3-port-test.ts can model a member that
   * forgot to ask, which `session` must still refuse. */
  protected retired(thread: Thread): boolean { return retiredRunner(this.options.registry.runner(thread.id)); }
  private session(thread: Thread): RunnerSession {
    const admission = this.options.registry.runner(thread.id);
    if (!admission) throw new Error("thread runner allocation is missing");
    if (retiredRunner(admission)) throw new Error(PROTOCOL_3_RETIRED);
    return (this.options.session ?? runnerSession)(admission);
  }
  private ref(thread: Thread): MachineRef {
    if (!thread.vm) throw new Error("thread has no machine");
    return { owner: thread.id, id: thread.vm.vmId };
  }
  private directory(thread: Thread): string { return path.join(this.options.threads, thread.id, "vm"); }
  /** The build machine's lease store (its epoch is the thread's). */
  private buildDirectory(thread: Thread): string { return path.join(this.options.threads, thread.id, "build"); }
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

  guest(thread: Thread, hooks: GuestHooks = {}): GuestTransport {
    if (this.retired(thread)) return { call: () => Promise.reject(new GuestTransportError(PROTOCOL_3_RETIRED)), close: () => Promise.resolve() };
    const directory = this.directory(thread);
    const transport = this.session(thread).guest(this.ref(thread), () => Math.max(1, currentMachineEpoch(directory)));
    return this.activity.guest(thread.id, transport, () => this.awake(thread.id, hooks.before));
  }

  touch(thread: Thread): void { this.activity.touch(thread.id); }

  idleMs(thread: Thread): number { return this.activity.idleMs(thread.id); }

  /** Whether the thread's machine is suspended (or waking). */
  suspended(thread: Thread): boolean { return !this.retired(thread) && !!this.options.registry.getThread(thread.id)?.vm?.suspension; }

  /** Before a guest call or a dial: a suspend under way ends first, then
   * the wake owner's `before` (Conversations wakes a suspended machine). */
  private async awake(id: string, before?: () => Promise<void>): Promise<void> {
    await this.suspending.get(id);
    await before?.();
  }

  /** Wakes the thread's suspended machine for cubed's own check (an
   * archive's release check) if its runner has a slot free now; it never
   * waits for one. Null once the machine runs; otherwise why it stays
   * suspended (no slot, or the runner does not answer). */
  async wakeNow(thread: Thread): Promise<string | null> {
    if (!this.suspended(thread)) return null;
    try { await this.start(this.options.registry.getThread(thread.id) ?? thread, { once: true }); }
    catch (error) { if (error instanceof RunnerWait) return error.message; throw error; }
    return this.suspended(thread) ? "it is still suspended" : null;
  }

  wakeInFlight(thread: Thread): boolean { return this.starting.has(thread.id); }

  /** A `waking` that no start or wake of this process owns: one a cubed
   * restart cut short, or one whose owner gave up. Nothing asks for the
   * machine now, so it is not woken: the runner's phase is recorded. Still
   * suspended (or gone), it is `suspended` again and holds no slot; running
   * (the start went through before the stop), the suspension is cleared and
   * the next recovery round checks it like any running machine. A runner
   * that does not answer leaves it for the next round. */
  async settleWake(thread: Thread): Promise<void> {
    if (this.retired(thread)) return;
    const id = thread.id;
    if (this.wakeInFlight(thread)) return;
    const current = this.options.registry.getThread(id);
    if (!current || current.archived || current.vm?.suspension?.state !== "waking") return;
    let machine: Machine | null;
    try { machine = await this.session(current).machine({ case: "machineGet", value: { ref: this.ref(current) } }); }
    catch (error) {
      if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw this.waitFor(current, error);
      machine = null;
    }
    // A start that began meanwhile owns the thread now.
    if (this.wakeInFlight(thread) || this.options.registry.getThread(id)?.vm?.suspension?.state !== "waking") return;
    const phase = machine?.status?.phase;
    if (phase === MachineStatus_Phase.SUSPENDING) return;
    if (machine && phase !== MachineStatus_Phase.SUSPENDED) {
      this.options.registry.applySleep(id, { type: "running" });
      this.events.record(id, "wake read back", `runner ${this.session(current).nodeId} runs it (${MachineStatus_Phase[phase ?? 0]}); a restart had cut its wake short`);
      this.log.info("wake read back: the machine runs", { thread: id, phase: MachineStatus_Phase[phase ?? 0] });
      return;
    }
    this.options.registry.applySleep(id, { type: "wakeDropped" });
    this.events.record(id, "wake dropped", "nothing asked for the machine after a restart cut its wake short; it stays suspended until something does");
    this.log.info("wake dropped: no one asks for the machine", { thread: id, phase: machine ? "SUSPENDED" : "gone" });
  }

  /** Suspends the thread's machine when it has been idle for `idleMs` (the
   * options' idleMs, IDLE_MS, unless a thread waits for its slot) and
   * nothing runs in it: `busy` (the conversation's), its commands, calls and
   * portal connections, and no registered service (asked last, with the
   * suspend's gate up, so nothing starts between). Only a running machine
   * on a runner that says it can suspend, one suspend per runner at a time;
   * a refusal keeps it running. True when it was suspended. */
  async suspendIfIdle(thread: Thread, busy: () => Promise<string | null>, idleMs = this.options.idleMs ?? IDLE_MS): Promise<boolean> {
    const current = this.options.registry.getThread(thread.id);
    if (!current || current.archived || current.workspaceState !== "available" || !this.onVm(current) || !this.running(current)) return false;
    if (this.starting.has(thread.id) || this.suspending.has(thread.id)) return false;
    if (this.suspendingOn.has(current.runnerId) || (this.suspendRetry.get(thread.id) ?? 0) > Date.now()) return false;
    const session = this.session(current);
    if (!session.capabilities.includes(SUSPEND_CAPABILITY)) return false;
    const refusedBy = this.noSuspend.get(current.runnerId);
    if (refusedBy !== undefined && refusedBy === (session.runner?.softwareVersion ?? "")) return false;
    if (this.activity.idleMs(thread.id) < idleMs) return false;
    // From here guest calls and starts wait for the outcome (N-207-1).
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    this.suspending.set(thread.id, gate);
    this.suspendingOn.add(current.runnerId);
    try {
      const why = await busy() ?? this.activity.busy(thread.id) ?? await this.services(current, session);
      if (why) {
        this.activity.touch(thread.id);
        this.log.debug("machine not suspended", { thread: thread.id, reason: why });
        return false;
      }
      return await this.suspend(current, session);
    } finally {
      this.suspending.delete(thread.id);
      this.suspendingOn.delete(current.runnerId);
      open();
    }
  }

  /** Why the machine's registered services keep it running, or null. A
   * registered service (`cube service`) may serve without a connection
   * open; until the user decides whether such a machine may be frozen
   * (N-207-8), it keeps the machine running, and so does a machine that
   * cannot say. Asked past the activity count: not activity itself. */
  private async services(thread: Thread, session: RunnerSession): Promise<string | null> {
    const transport = session.guest(this.ref(thread), () => Math.max(1, currentMachineEpoch(this.directory(thread))));
    try {
      const answer = await transport.call("services", {}, { timeoutMs: 15000 });
      const failure = answer.header.error as { message?: unknown } | undefined;
      if (failure) return `its services could not be listed: ${typeof failure.message === "string" ? failure.message : "the guest refused"}`;
      const names = guestServices(answer.header).map(service => service.name);
      return names.length ? `services are registered (${names.slice(0, 5).join(", ")})` : null;
    } catch (error) {
      return `its services could not be listed: ${message(error)}`;
    } finally { await transport.close().catch(() => {}); }
  }

  private async suspend(thread: Thread, session: RunnerSession): Promise<boolean> {
    const ref = this.ref(thread);
    const node = session.nodeId;
    const suspended = (machine: Machine) => {
      const memoryBytes = Number(machine.status?.suspended?.memoryBytes ?? 0n);
      this.options.registry.applySleep(thread.id, { type: "suspended", at: Date.now(), ...(memoryBytes ? { memoryBytes } : {}) });
      this.events.record(thread.id, "suspended", `idle; ${gib(memoryBytes)} of memory saved on VM runner ${node}; it holds no slot until it is resumed`);
      this.log.info("machine suspended", { thread: thread.id, runner: node, memoryBytes });
      return true;
    };
    const refused = (what: string, retry: boolean) => {
      if (retry) this.suspendRetry.set(thread.id, Date.now() + SUSPEND_RETRY_MS);
      this.activity.touch(thread.id);
      this.events.record(thread.id, "not suspended", `${what}; the machine keeps running`);
      this.log.info("machine not suspended", { thread: thread.id, runner: node, reason: what });
      return false;
    };
    try {
      const result = await session.call({ case: "machineSuspend", value: { ref, fence: this.fence(thread) } }, this.options.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS);
      if (result.case !== "machine") return refused(`runner ${node} answered ${result.case} to machine_suspend`, true);
      if (result.value.status?.phase !== MachineStatus_Phase.SUSPENDED) return refused(`runner ${node} left the machine ${MachineStatus_Phase[result.value.status?.phase ?? 0]}`, true);
      return suspended(result.value);
    } catch (error) {
      if (error instanceof RunnerError) {
        // K-6: a runner without the verb (a release from before suspend).
        if (error.code === "UNIMPLEMENTED" || (error.code === "INVALID_ARGUMENT" && error.reason === "verb")) {
          this.noSuspend.set(thread.runnerId, session.runner?.softwareVersion ?? "");
          return refused(`runner ${node} does not suspend machines`, false);
        }
        if (error.code === "FAILED_PRECONDITION" && error.reason === "busy") return refused(`runner ${node} found it busy (${error.message})`, false);
        if (error.code === "RESOURCE_EXHAUSTED" && error.reason === "disk") return refused(`runner ${node} has too little free disk for its memory file`, true);
        if (error.code === "UNAVAILABLE" && error.reason === "snapshot") return refused(`runner ${node} could not save it (${error.message})`, true);
      }
      // K-8: no answer in time (or a lost one): the runner says what became
      // of it. Still SUSPENDING, the gate stays up until it says more.
      try {
        let machine = await session.machine({ case: "machineGet", value: { ref } });
        if (machine.status?.phase === MachineStatus_Phase.SUSPENDING) {
          machine = await session.until(ref, current => current.status?.phase !== MachineStatus_Phase.SUSPENDING,
            this.options.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS);
        }
        if (machine.status?.phase === MachineStatus_Phase.SUSPENDED) return suspended(machine);
      } catch (asked) { this.log.warn("machine_get after machine_suspend failed", { thread: thread.id, error: asked }); }
      return refused(`machine_suspend failed: ${message(error)}`, true);
    }
  }


  start(thread: Thread, options: StartOptions = {}): Promise<MachineStart> {
    if (this.retired(thread)) return Promise.reject(new Error(PROTOCOL_3_RETIRED));
    const pending = this.starting.get(thread.id);
    if (pending) return pending;
    // An archived thread's machine is released: nothing starts it again.
    if (this.options.registry.getThread(thread.id)?.archived !== false) return Promise.reject(new Error("thread not found"));
    // A suspend under way ends first: the start then resumes what it saved,
    // never races its save (B-207-1).
    const suspending = this.suspending.get(thread.id);
    const starting = (suspending ? suspending.then(() => this.boot(this.options.registry.getThread(thread.id) ?? thread, options)) : this.boot(thread, options))
      .finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, starting);
    return starting;
  }

  /** A failure that only means the runner cannot take the machine now (it
   * does not answer, or it is full): the thread waits. */
  private waitFor(thread: Thread, error: unknown): unknown {
    const node = this.options.registry.getRunner(thread.runnerId)?.nodeId ?? thread.runnerId;
    // A new machine on a full runner (its slot was reserved, but the runner
    // counts otherwise: another cubed, a lowered bound) waits; it is no failure.
    if (error instanceof RunnerError && error.code === "RESOURCE_EXHAUSTED") {
      return new RunnerWait(`waiting for a free slot on runner ${node}: it hosts as many machines as it may; this thread stays on it`, { cause: error });
    }
    if (!(error instanceof RunnerError && error.code === "UNAVAILABLE")) return error;
    const stays = `this thread was ${thread.pinned ? "started on it by name" : "placed on it"} and stays there`
      + (this.onVm(thread) ? "" : " (a host runner runs only while someone runs berth host)");
    return new RunnerWait(`waiting for runner ${node}: it does not answer; ${stays}`,
      { cause: error, ...this.onVm(thread) ? { unanswered: { runner: node, stays } } : {} });
  }

  private async boot(thread: Thread, options: StartOptions): Promise<MachineStart> {
    // A queued thread's machine is made only once it got its slot
    // (Conversations asks for it): its runner is not asked before.
    const queued = this.options.registry.getThread(thread.id)?.vm?.suspension;
    if (queued?.state === "queued") throw new RunnerWait(queued.waiting);
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
      try {
        machine = await session.machine({ case: "machineGet", value: { ref } });
        // A save the runner is still doing (one cubed gave up on): its end.
        if (machine.status?.phase === MachineStatus_Phase.SUSPENDING) {
          machine = await session.until(ref, current => current.status?.phase !== MachineStatus_Phase.SUSPENDING,
            this.options.suspendTimeoutMs ?? SUSPEND_TIMEOUT_MS);
        }
      }
      catch (error) {
        if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw error;
        options.onBoot?.();
        // What the disk is made from (a template, built now if there is
        // none), decided before the thread's machine exists.
        if (vm) thread = await this.prepare(thread, session, runner, size!);
        this.options.registry.beginStartupStep(thread.id, { name: "boot", detail: vm
          ? `a keel machine on VM runner ${node}: ${size!.vcpus} vCPU, ${size!.memoryMib} MiB memory, ${size!.diskGib} GiB disk`
          : `a directory on host runner ${node}, unsandboxed` });
        this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional"], "requested");
        created = true;
        machine = await this.step(thread, () => this.create(thread, session, ref, size));
        const preparation = this.options.registry.getThread(thread.id)?.vm?.preparation;
        this.events.record(thread.id, "created", `machine ${ref.id} on ${what} ${node}`
          + (preparation ? `, ${preparation.source}${preparation.templateId ? ` template ${preparation.templateId}` : ""}${preparation.reason ? ` (${preparation.reason})` : ""}` : ""));
      }
      this.options.registry.markPlacement(thread.id, thread.runnerId, ["provisional", "requested"], "allocated");
      if (machine.status?.phase === MachineStatus_Phase.RETAINED) throw new Error(`the thread's machine on ${node} was released; its ${vm ? "disk" : "directory"} is kept there`);
      // A suspended machine: this start resumes it (or the runner starts it
      // from its disk); one the runner no longer holds suspended is simply started.
      const suspension = this.options.registry.getThread(thread.id)?.vm?.suspension;
      const resuming = machine.status?.phase === MachineStatus_Phase.SUSPENDED;
      const waiting = `waiting for a free slot on runner ${node}: the machine is suspended and resumes once one frees`;
      // B7-2: a full runner; the thread waits, saying so, and tries again.
      // A start that does not wait (`once`) leaves the machine suspended.
      const full = (cause?: unknown) => {
        if (options.once) this.options.registry.applySleep(thread.id, { type: "wakeDropped" });
        return new RunnerWait(waiting, cause === undefined ? undefined : { cause });
      };
      if (resuming) {
        // The registry reserves the slot first, as for a new thread: a wake
        // never takes the slot of a thread whose machine is not created yet.
        if (!holdsSlot(this.options.registry.applySleep(thread.id, { type: "wakeAsked", waiting }))) throw full();
      } else if (suspension) this.options.registry.applySleep(thread.id, { type: "running" });
      // A snapshot the runner restored is the boot it saved, also when this
      // process never saw that boot (a cubed restart since the suspend): its
      // agent goes on, it is not a machine that booted again.
      let sameBoot = false;
      const startAndWait = async () => {
        let started: Machine;
        try { started = await session.machine({ case: "machineStart", value: { ref, fence: this.fence(thread), ...start } }); }
        catch (error) {
          // The runner is full all the same (another cubed, a lowered bound).
          if (resuming && error instanceof RunnerError && error.code === "RESOURCE_EXHAUSTED") {
            if (!options.once) this.options.registry.applySleep(thread.id, { type: "slotTaken", waiting });
            throw full(error);
          }
          throw error;
        }
        if (resuming) sameBoot = this.resumed(thread, started, node);
        return this.ready(session, ref);
      };
      const ready = created ? await this.step(thread, startAndWait) : await startAndWait();
      if (created) this.options.registry.endStartupStep(thread.id, { name: "boot", state: "ok" });
      const boot = ready.status?.bootId ?? "";
      // A machine started or resumed now is active now, and nothing from
      // before runs in it. A check of one that ran already is not activity:
      // the recovery loop's checks must not keep it awake (B-207-1).
      if (machine.status?.phase !== MachineStatus_Phase.RUNNING) {
        this.activity.started(thread.id);
      }
      const booted = !sameBoot && this.boots.get(thread.id) !== boot;
      this.boots.set(thread.id, boot);
      if (booted) this.events.record(thread.id, "ready", `boot ${boot.slice(0, 8)} of ${what} ${node}`);
      return { booted };
    } catch (error) {
      const failure = this.waitFor(thread, error);
      this.events.record(thread.id, failure instanceof RunnerWait ? "waiting for a runner" : "start failed", failure);
      throw failure;
    }
  }

  /** Waits until the runner's watch reports the guest of `ref` ready. */
  private async ready(session: RunnerSession, ref: MachineRef): Promise<Machine> {
    const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    try { return await session.until(ref, current => current.status?.guest?.ready === true, timeout); }
    catch (error) {
      if (error instanceof RunnerError) throw error;
      // The runner's last word on the guest says why it did not get ready.
      const why = notReady(session.machines.get(machineKey(ref))?.status?.guest);
      throw new Error(`runner ${session.nodeId}: the guest of machine ${ref.id} did not get ready in ${Math.round(timeout / 1000)} s: ${why ?? "it is ready now"}`, { cause: error });
    }
  }

  /** Creates the thread's machine as its preparation says. A template the
   * runner no longer has, is removing, or made on another image (B-8 D3) or
   * under another runner CA makes it start from the base, with that reason
   * (as vm.ts `allocate`). */
  private async create(thread: Thread, session: RunnerSession, ref: MachineRef, size: MessageInitShape<typeof SizeSchema> | undefined): Promise<Machine> {
    const send = (templateId?: string) => session.machine({ case: "machineCreate", value: { ref, fence: this.fence(thread),
      spec: { source: templateId ? { case: "templateId", value: templateId } : { case: "base", value: true }, ...(size ? { size } : {}) } } });
    const preparation = this.options.registry.getThread(thread.id)?.vm?.preparation;
    if (preparation?.source !== "template" || !preparation.templateId) return send();
    try { return await send(preparation.templateId); }
    catch (error) {
      const reason = templateRefused(error, preparation.templateId);
      if (!reason) throw error;
      this.log.warn("template refused; starting fresh", { thread: thread.id, template: preparation.templateId, error });
      this.options.registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason } });
      return send();
    }
  }

  /** Decides what a new machine's disk on a VM runner is made from and
   * records it on the thread (`vm.preparation`): the newest fresh template
   * of the project on this runner for its key, or one built now, or the
   * base. Returns the updated thread. */
  private async prepare(thread: Thread, session: RunnerSession, runner: Runner, size: MessageInitShape<typeof SizeSchema>): Promise<Thread> {
    const { registry } = this.options;
    registry.beginStartupStep(thread.id, { name: "lookup" });
    const fresh = (reason: string) => {
      registry.endStartupStep(thread.id, { name: "lookup", state: "ok", detail: `no template: ${reason}` });
      return registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason } });
    };
    // A build machine an earlier start left (a crash, a cubed restart): cubed's own, deleted first.
    try { await this.abandonBuild(thread, session); }
    catch (error) {
      registry.endStartupStep(thread.id, { name: "lookup", state: "failed", detail: `an earlier template build machine is not deleted yet: ${message(error)}` });
      throw error;
    }
    if (!this.templates.enabled) return fresh("templates are off (CUBED_TEMPLATES=off)");
    if (!KEEL_TEMPLATE_CAPABILITIES.every(capability => session.capabilities.includes(capability))) {
      return fresh(`the runner has no machine templates (${KEEL_TEMPLATE_CAPABILITIES.join(", ")})`);
    }
    const keyInput = { allocation: thread.allocation, hooks: thread.allocation.hooks ?? NO_HOOKS, diskGiB: size.diskGib ?? 0,
      runner: { baseImageSha256: runner.platform?.baseImageSha256 ?? "", platform: [runner.platform?.os, runner.platform?.arch].filter(Boolean).join("-"),
        imageId: runner.platform?.imageId ?? "", caSha256: runnerCaSha256(runner.caPem) } };
    const key = keelTemplateKey(keyInput);
    let templates: RunnerTemplate[];
    try { templates = await this.listTemplates(session); }
    catch (error) {
      this.log.warn("listing templates failed", { thread: thread.id, error });
      return fresh("the runner's templates could not be listed");
    }
    const now = Date.now();
    await this.removeTemplates(session, this.obsolete(templates, now), "obsolete");
    const found = pickTemplate(templates, key, now, this.templates.ttlMs);
    if (found) {
      registry.endStartupStep(thread.id, { name: "lookup", state: "ok", detail: `template ${found.id}, prepared ${minutes(now - found.createdAt)} ago` });
      return registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: found.id, setupBlob: found.meta.setupBlob } });
    }
    const parts = keelTemplateParts(keyInput);
    const missing = missingTemplate(templates, { projectId: thread.allocation.projectId, key, parts, now, ttlMs: this.templates.ttlMs });
    const flight = `${thread.runnerId}:${key}`;
    // One build per runner and key: a thread that comes meanwhile starts fresh.
    if (this.builds.has(flight)) return fresh(`${missing}; another thread is preparing the project's template now`);
    // A failed build is not tried again for an hour with the same
    // key, machine size and commit.
    const attempt = `${flight}:${size.vcpus}:${size.memoryMib}:${thread.allocation.repositories[0]?.baseOid ?? ""}`;
    const failed = this.failedBuilds.get(attempt);
    if (failed !== undefined && now - failed.at < FAILED_BUILD_BACKOFF_MS) {
      return fresh(`${missing}; the last build of one failed ${minutes(now - failed.at)} ago (${failed.error}); `
        + `cube tries again in ${minutes(failed.at + FAILED_BUILD_BACKOFF_MS - now)}, or at once with a new commit or another machine size`);
    }
    registry.endStartupStep(thread.id, { name: "lookup", state: "ok", detail: `${missing}: building one` });
    const building = this.build(thread, session, runner, size, key, parts);
    this.builds.set(flight, building);
    try {
      const template = await building;
      this.failedBuilds.delete(attempt);
      return registry.updateThreadVm(thread.id, { preparation: { source: "template", templateId: template.id, setupBlob: template.meta.setupBlob } });
    } catch (error) {
      // The runner does not answer: the thread waits for it (it never moves).
      if (error instanceof RunnerError && error.code === "UNAVAILABLE") throw error;
      const text = message(error);
      // No room (B-8 C2, or no free machine): the thread cannot move, so it
      // starts fresh; a refusal is no failed build and sets no backoff.
      if (!(error instanceof RunnerError && error.code === "RESOURCE_EXHAUSTED")) this.failedBuilds.set(attempt, { at: Date.now(), error: text });
      this.log.warn("template build failed; starting fresh", { thread: thread.id, runner: session.nodeId, error: text });
      return registry.updateThreadVm(thread.id, { preparation: { source: "fresh", reason: `the template build failed: ${text}` } });
    } finally { this.builds.delete(flight); }
  }

  /** Builds a template for `key` in the thread's slot, before the thread's
   * own machine exists: a build machine with its own id and placeholders
   * (`vm.build`) is made from the base with a template disk and started
   * with its own boot documents and policy; cubed's own commands check out
   * the pinned commits and run pre-setup and `.agents/setup` in it; then
   * `template_publish` (600 s; asked once more if the answer is lost, as it
   * is idempotent). A published build machine is used up (C1: berth
   * deleted it) and only forgotten. Anything short of that publishes
   * nothing and the build machine is deleted. */
  private async build(thread: Thread, session: RunnerSession, runner: Runner, size: MessageInitShape<typeof SizeSchema>, key: string,
    parts: TemplateParts): Promise<{ id: string; meta: TemplateMeta }> {
    const { registry } = this.options;
    if (!this.options.policy) throw new Error("this cubed has no egress policy for protocol-4 VM runners");
    const started = Date.now();
    const build = { vmId: randomBytes(8).toString("hex"), placeholders: { github: newPlaceholder("github") }, key, runnerId: thread.runnerId };
    registry.updateThreadVm(thread.id, { build });
    const ref: MachineRef = { owner: thread.id, id: build.vmId };
    const directory = this.buildDirectory(thread);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let leases: LeaseStore | undefined;
    let published = false;
    // The step under way, marked failed if the build stops there.
    let step: StartupStep["name"] = "build-boot";
    registry.beginStartupStep(thread.id, { name: step, detail: `${size.vcpus} vCPU, ${size.memoryMib} MiB memory, ${size.diskGib} GiB disk, from the base image` });
    try {
      await session.machine({ case: "machineCreate", value: { ref, fence: this.fence(thread), spec: { source: { case: "base", value: true }, size, build: true } } });
      this.events.record(thread.id, "build machine created", `machine ${ref.id} on VM runner ${session.nodeId}`);
      const documents = bootDocuments({ vmId: build.vmId, placeholders: build.placeholders, ...(thread.allocation.hooks ? { hooks: thread.allocation.hooks } : {}) },
        runner.limits?.maxBootBytes || MAX_BOOT_BYTES);
      await session.machine({ case: "machineStart", value: { ref, fence: this.fence(thread), size, boot: { documents, mac: "" },
        policy: this.options.policy.policyFor({ ...thread, vm: { ...thread.vm!, placeholders: build.placeholders } }) } });
      await this.ready(session, ref);
      registry.endStartupStep(thread.id, { name: step, state: "ok" });

      // cubed's own commands: the build machine never has an agent.
      step = "build-prepare";
      registry.beginStartupStep(thread.id, { name: step, detail: "checkout, pre-setup and .agents/setup in the build machine" });
      const guest = session.guest(ref, () => Math.max(1, currentMachineEpoch(this.directory(thread))));
      this.buildGuests.set(thread.id, guest);
      leases = new LeaseStore(path.join(directory, "lease"));
      const owner = threadAgent(thread);
      const workspace = new VmWorkspace({ guest, leases, owner, binding: JSON.stringify({ build: build.vmId, thread: thread.id }) });
      const prepared = await own(workspace, owner, "cube:build:prepare", preparationScript(thread.allocation, { kind: "fresh" }), BUILD_PREPARE_TIMEOUT_MS);
      const outcome = preparationOutcome(prepared);
      if (outcome.error) {
        // A hook that was killed printed nothing more: its log is still in the machine.
        const log = outcome.log ?? (outcome.running ? await readStartupLog(guest, "build").then(read => read.text ? stepLog(read.text) : undefined, () => undefined) : undefined);
        throw new StepFailure(outcome.error, outcome.memory, log);
      }
      const failedHook = Object.entries(outcome.hooks).find(([, hook]) => hook.status === "failed");
      if (failedHook) throw new StepFailure(`${failedHook[0]} failed (exit ${failedHook[1].exitCode}) in the build machine`, outcome.memory, outcome.log);
      this.buildGuests.delete(thread.id);
      registry.endStartupStep(thread.id, { name: step, state: "ok", detail: hookSummary(outcome.hooks), ...(outcome.memory ? { memory: outcome.memory } : {}) });

      // No seal: keel's template_publish cleans and checks the layer itself.
      step = "build-publish";
      registry.beginStartupStep(thread.id, { name: step, detail: "keel cleans the build machine's layer and writes it as the template" });
      const meta: TemplateMeta = { format: TEMPLATE_FORMAT, projectId: thread.allocation.projectId, setupBlob: outcome.setupBlob ?? "none",
        commit: thread.allocation.repositories[0]?.baseOid ?? null, parts };
      const ask = { case: "templatePublish" as const, value: { from: ref, fence: this.fence(thread), key, meta: JSON.stringify(meta) } };
      const publish = async () => {
        const result = await session.call(ask);
        if (result.case !== "template") throw new Error(`runner ${session.nodeId} answered ${result.case} to template_publish`);
        return result.value;
      };
      let template: Template;
      try { template = await publish(); }
      catch (error) {
        // The answer was lost: publishing is idempotent, so the same call goes once more.
        if (!(error instanceof RunnerError && error.code === "UNAVAILABLE")) throw error;
        this.log.warn("template_publish unanswered; asking again", { thread: thread.id, vm: build.vmId, error });
        template = await publish();
      }
      published = true;
      registry.endStartupStep(thread.id, { name: step, state: "ok", detail: `template ${template.id}, ${gib(Number(template.bytes))}` });
      this.log.info("template published", { thread: thread.id, runner: session.nodeId, template: template.id, bytes: Number(template.bytes), ms: Date.now() - started });
      this.events.record(thread.id, "template published", `template ${template.id}; the runner deleted the build machine`);
      // The project's older templates on this runner are superseded.
      try {
        await this.removeTemplates(session, this.obsolete(await this.listTemplates(session), Date.now(), { projectId: meta.projectId, keep: template.id }), "superseded");
      } catch (error) { this.log.warn("removing superseded templates failed", { runner: session.nodeId, error }); }
      return { id: template.id, meta };
    } catch (error) {
      if (!published) registry.endStartupStep(thread.id, { name: step, state: "failed", detail: `${message(error)}; no template was published`,
        ...(error instanceof StepFailure && error.memory ? { memory: error.memory } : {}), ...(error instanceof StepFailure && error.log ? { log: error.log } : {}) });
      throw error;
    } finally {
      this.buildGuests.delete(thread.id);
      leases?.close();
      // C1: a published build machine is used up (the runner deleted it): only forgotten.
      if (published) {
        registry.updateThreadVm(thread.id, { build: undefined });
        fs.rmSync(directory, { recursive: true, force: true });
      } else await this.abandonBuild(thread, session).catch(error => this.log.warn("deleting the build machine failed", { thread: thread.id, error }));
    }
  }

  /** Deletes the thread's build machine that did not publish (a failure, or
   * one an earlier cubed left); it held only cubed's own work. Gone already
   * (`NOT_FOUND`) is the same. */
  private async abandonBuild(thread: Thread, session: RunnerSession): Promise<void> {
    const build = this.options.registry.getThread(thread.id)?.vm?.build;
    if (!build) return;
    this.buildGuests.delete(thread.id);
    const ref: MachineRef = { owner: thread.id, id: build.vmId };
    try {
      const machine = await session.machine({ case: "machineDelete", value: { ref, fence: this.fence(thread), retain: false } });
      if (machine.status?.phase === MachineStatus_Phase.RETAINED) await session.machine({ case: "machineDiscard", value: { ref, fence: this.fence(thread) } });
    } catch (error) {
      if (!(error instanceof RunnerError && error.code === "NOT_FOUND")) throw error;
    }
    this.options.registry.updateThreadVm(thread.id, { build: undefined });
    fs.rmSync(this.buildDirectory(thread), { recursive: true, force: true });
    this.log.info("build machine deleted", { thread: thread.id, vm: build.vmId });
    this.events.record(thread.id, "build machine deleted", `machine ${build.vmId}`);
  }

  private async listTemplates(session: RunnerSession): Promise<RunnerTemplate[]> {
    const result = await session.call({ case: "templateList", value: {} });
    if (result.case !== "templates") throw new Error(`runner ${session.nodeId} answered ${result.case} to template_list`);
    return result.value.items.map(listedTemplate);
  }

  /** C7: `template_delete` has no owner or fence, so cubed deletes only
   * templates whose metadata it reads as its own (`templateMeta`), by the
   * obsolete rule (expired, of a project that is gone, or superseded by
   * `keep`); a template it cannot read is never touched. */
  private obsolete(templates: RunnerTemplate[], now: number, superseded?: { projectId: string; keep: string }): string[] {
    return obsoleteTemplates(templates.filter(template => templateMeta(template.meta) !== null), { now, ttlMs: this.templates.ttlMs,
      projectExists: id => this.options.registry.getProject(id) !== null, ...(superseded ?? {}) });
  }

  private async removeTemplates(session: RunnerSession, ids: string[], reason: string): Promise<void> {
    for (const id of ids) {
      try {
        const removed = await session.call({ case: "templateDelete", value: { id } });
        this.log.info("template removed", { runner: session.nodeId, template: id, reason, inUse: removed.case === "template" ? removed.value.users : undefined });
      } catch (error) {
        if (error instanceof RunnerError && error.code === "NOT_FOUND") continue;
        this.log.warn("removing a template failed", { runner: session.nodeId, template: id, error });
      }
    }
  }

  /** Stops new machines from using a template (its setup changed): on a VM
   * runner, `template_delete`; the runner removes it once no machine uses it. */
  async invalidateTemplate(thread: Thread, templateId: string): Promise<void> {
    if (this.retired(thread) || !this.onVm(thread)) return;
    await this.removeTemplates(this.session(thread), [templateId], "its setup changed");
  }

  /** Ends the thread's `boot` step as failed when `work` fails, or as
   * interrupted when the runner cannot take it now (the thread waits). */
  private async step<T>(thread: Thread, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      const waits = error instanceof RunnerError && (error.code === "RESOURCE_EXHAUSTED" || error.code === "UNAVAILABLE");
      this.options.registry.endStartupStep(thread.id, { name: "boot", state: waits ? "interrupted" : "failed", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** A host runner keeps the machine's directory either way: it is
   * retained. A VM runner stops the machine first (STOP_TIMEOUT_MS), then
   * keeps its disk only when asked to (or after an interruption). */
  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    // A retired runner keeps whatever disk it has: nothing is asked of it.
    if (this.retired(thread)) return { retained: !!thread.vm && placement(thread) !== "provisional" && !thread.vm.discarded };
    this.boots.delete(thread.id);
    this.activity.forget(thread.id);
    this.suspendRetry.delete(thread.id);
    // A build machine that outlived its start (cubed's own) goes first.
    if (this.onVm(thread)) await this.abandonBuild(thread, this.session(thread));
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
    if (this.retired(thread)) throw new Error(PROTOCOL_3_RETIRED);
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

  running(thread: Thread): boolean { return this.boots.has(thread.id) && !this.suspended(thread); }

  /** After `machine_start` on a suspended machine: it runs again, resumed
   * (the same boot) or, when the runner could not use its snapshot, from
   * its disk (B7-5: a notice, and running commands were interrupted). */
  /** Records a resume; true when the runner restored the snapshot (the
   * same boot), false when it started the machine from its disk. */
  private resumed(thread: Thread, machine: Machine, node: string): boolean {
    const dropped = machine.status?.conditions.find(condition => condition.type === "SnapshotDropped");
    if (dropped) {
      const text = dropped.reason === "version" ? RESTARTED_AFTER_UPDATE : RESTARTED;
      this.options.registry.applySleep(thread.id, { type: "resumed", notice: { text, at: Date.now() } });
      this.events.record(thread.id, "restarted from its disk", `runner ${node} could not use the snapshot (${safeText(dropped.reason, 32)}: ${safeText(dropped.message, 256)})`);
      this.log.warn("snapshot dropped; the machine started from its disk", { thread: thread.id, runner: node, reason: dropped.reason });
      return false;
    }
    // A notice of an earlier cold start is old news now (N-207-6).
    this.options.registry.applySleep(thread.id, { type: "resumed", notice: null });
    this.events.record(thread.id, "resumed", `on VM runner ${node}, the same boot`);
    return true;
  }

  /** The portal's connection to `port` of the thread's machine, at its
   * current epoch (as its guest calls), only while this process has it
   * running. The runner refuses ports below 1024 and a machine it does not
   * run; `berth host` has no dial (masterplan B-9). */
  async dial(thread: Thread, port: number): Promise<Duplex> {
    if (this.retired(thread)) throw new Error(PROTOCOL_3_RETIRED);
    // A suspend under way ends first; the portal woke a suspended machine (B7-3).
    await this.awake(thread.id);
    if (!this.running(thread)) throw new Error("the thread's machine is not running");
    const socket = await this.session(thread).dial(this.ref(thread), Math.max(1, currentMachineEpoch(this.directory(thread))), port);
    return this.activity.dial(thread.id, socket);
  }

  /** The end of the log of the hook running now in a VM runner's machine,
   * read with keel's `read` at the current epoch (no lease, no new fence)
   * while this process has the machine running; null otherwise. A host
   * runner's logs are on that host (CUBE_LOGS): null. */
  async startupLog(thread: Thread): Promise<StartupLog | null> {
    if (this.retired(thread) || !this.onVm(thread)) return null;
    // While cubed prepares a template, the hook runs in the build machine.
    const build = this.buildGuests.get(thread.id);
    if (build) return readStartupLog(build, "build");
    if (!this.running(thread)) return null;
    return readStartupLog(this.guest(thread), "thread");
  }

  /** What cubed knows of the machine: its events, the runner's last report
   * and, from a VM runner, its diagnosis (`machine_diagnose`: one bounded
   * JSON document the runner redacted; cubed cleans the bundle again) and
   * what the keel agent last said of itself in the watch. */
  async diagnose(thread: Thread): Promise<MachineEvidence> {
    if (this.retired(thread)) throw new Error(PROTOCOL_3_RETIRED);
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

  /** The runner sessions this process opened (none for a test's own). */
  async close(): Promise<void> {
    if (!this.options.session) await closeRunnerSessions();
  }
}
