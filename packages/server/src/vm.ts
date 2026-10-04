/** A thread's machine: one QEMU VM on the thread's runner, reached only
 * through cube-gateway. `ThreadVms` allocates and boots it, attaches it to
 * the gateway, waits until its guest helper answers ready, and releases it at
 * archive (retaining the disk of a thread whose work is not clean).
 *
 * Provisioning (the pinned repository checkouts) and the release check are
 * ordinary workspace commands under the thread's lease and fixed keys, so
 * they are journaled in the guest like every agent command. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayUnavailable, type GatewayAttach, type GatewayClient, type GatewaySupervisor } from "./gateway.ts";
import { SshGuestTransport, controlDirectory, type GuestTransport } from "./guest-ssh.ts";
import { IrohNodeError, IrohRunnerClient, type VmRecord, type VmRef } from "./iroh-node.ts";
import { createLogger, type Logger } from "./log.ts";
import type { Registry, Thread, WorkspaceAllocation } from "./registry.ts";
import type { EgressVms } from "./egress-policy.ts";
import { guestDescription } from "./vm-workspace.ts";
import { vmMac, vmSeed } from "./vm-seed.ts";
import { settleOperation, WorkspaceError, type Workspace, type WorkspaceOwner } from "./workspace.ts";

const run = promisify(execFile);

/** What Conversations needs from a thread's machine. */
export interface ThreadMachines {
  /** How cubed reaches the thread's guest helper. */
  guest(thread: Thread): GuestTransport;
  /** Boot or re-attach the machine; resolves once its guest answers ready. */
  start(thread: Thread): Promise<void>;
  /** Release the machine; `retain` keeps its disk. The runner always keeps
   * an interrupted or failed one. */
  release(thread: Thread, retain: boolean): Promise<{ retained: boolean }>;
  close(): Promise<void>;
}

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
}

export class ThreadVms implements ThreadMachines, EgressVms {
  private readonly options: ThreadVmsOptions;
  private readonly log: Logger;
  private readonly sizes: VmSizes;
  private readonly controls: string;
  private readonly attached = new Map<string, GatewayAttach>();
  private readonly transports = new Map<string, SshGuestTransport>();
  private readonly starting = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: ThreadVmsOptions) {
    this.options = options;
    this.log = options.log ?? createLogger("vm");
    this.sizes = options.sizes ?? vmSizes();
    this.controls = controlDirectory(options.run);
    options.gateway.onRestart(client => this.reattach(client));
  }

  /** EgressVms: a VM's thread and placeholders, for the egress policy. */
  vm(vmId: string): { threadId: string; placeholders: Record<string, string> } | null {
    const thread = this.options.registry.threadByVm(vmId);
    if (!thread?.vm || thread.archived) return null;
    return { threadId: thread.id, placeholders: thread.vm.placeholders };
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

  start(thread: Thread): Promise<void> {
    if (this.closed) return Promise.reject(new Error("cubed is stopping"));
    const pending = this.starting.get(thread.id);
    if (pending) return pending;
    const starting = this.boot(thread).finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, starting);
    return starting;
  }

  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    const vm = machine(thread);
    const runner = this.runner(thread);
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
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

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.transports.values()].map(transport => transport.close()));
    this.transports.clear();
  }

  private async boot(thread: Thread): Promise<void> {
    const vm = machine(thread);
    const runner = this.runner(thread);
    const target = runner.target;
    await this.options.gateway.ensureNetwork(target.network);
    const { client: gateway, hello } = await this.options.gateway.ready();
    const ref: VmRef = { threadId: thread.id, vmId: vm.vmId };
    if (this.attached.has(vm.vmId)) {
      // Already started by this process: only check that it still runs.
      const [{ vm: current }, status] = await Promise.all([runner.vmInspect(ref), gateway.status(vm.vmId)]);
      if (current.state === "running" && status) return;
      this.attached.delete(vm.vmId);
      this.log.warn("machine is not running; starting it again", { thread: thread.id, vm: vm.vmId, state: current.state });
    }
    const description = await runner.describe();
    const keys = await this.keys(thread);
    const epoch = this.epoch(thread);
    const sizes = {
      vcpus: Math.min(this.sizes.vcpus, description.limits.maxVcpus),
      memoryMiB: Math.min(this.sizes.memoryMiB, description.limits.maxMemoryMiB),
      diskGiB: Math.min(this.sizes.diskGiB, description.limits.maxDiskGiB),
    };
    let record: VmRecord;
    try { record = (await runner.vmInspect(ref)).vm; }
    catch (error) {
      if (!(error instanceof IrohNodeError && error.code === "NOT_FOUND")) throw error;
      record = await runner.vmAllocate(ref, epoch, sizes.diskGiB);
      this.log.info("allocated", { thread: thread.id, vm: vm.vmId, diskGiB: sizes.diskGiB });
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
    const frameToken = randomBytes(32).toString("hex");
    const mac = vmMac(vm.vmId, data => createHash("sha256").update(data).digest());
    const seed = vmSeed({ vmId: vm.vmId, hostKey: keys.host, clientKeyPub: keys.clientPub, caPem: hello.caPem, placeholders: vm.placeholders });
    record = await runner.vmStart(ref, epoch, { vcpus: sizes.vcpus, memoryMiB: sizes.memoryMiB, mac, seed, gateway: { peer: hello.peer, frameToken } });
    if (!MACHINE_STATES_LIVE.has(record.state)) {
      throw new Error(`the thread machine did not start${record.error ? `: ${record.error.trim().split("\n").slice(-3).join("; ")}` : ""}`);
    }
    const spec: GatewayAttach = { threadId: thread.id, runner: target, frameToken, mac };
    await gateway.attach(vm.vmId, spec);
    this.attached.set(vm.vmId, spec);
    this.log.info("started", { thread: thread.id, vm: vm.vmId, state: record.state, runner: runner.nodeId });
    await this.waitReady(thread, runner, ref);
  }

  /** The guest answers `hello` with ready once cloud-init (packages, the
   * helper) has finished; the first boot installs packages through the
   * gateway and takes minutes. */
  private async waitReady(thread: Thread, runner: IrohRunnerClient, ref: VmRef): Promise<void> {
    const transport = this.guest(thread);
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    let lastInspect = Date.now();
    let last: string;
    for (;;) {
      if (this.closed) throw new Error("cubed is stopping");
      try {
        const answer = await transport.call("hello", {}, { timeoutMs: 45000 });
        if (answer.header.error && typeof answer.header.error === "object") last = String((answer.header.error as { message?: unknown }).message);
        else if (guestDescription(answer.header).ready) { this.log.info("ready", { thread: thread.id, vm: ref.vmId }); return; }
        else last = "cloud-init is still running";
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      if (Date.now() > deadline) throw new Error(`the thread machine did not become ready: ${last}`);
      if (Date.now() - lastInspect > 15000) {
        lastInspect = Date.now();
        const { vm, consoleTail } = await runner.vmInspect(ref);
        if (!MACHINE_STATES_LIVE.has(vm.state)) {
          throw new Error(`the thread machine stopped while booting (${vm.state})${consoleTail ? `: ${consoleTail.trim().split("\n").slice(-3).join("; ")}` : ""}`);
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
    return new IrohRunnerClient({ configPath: admission.configPath, configHash: admission.configHash });
  }
  private controlSocket(): string { return this.options.gateway.control; }
  private keyDirectory(thread: Thread): string { return path.join(this.options.threads, thread.id, "vm"); }

  /** cubed's client key and the guest's host key, generated once per VM;
   * the host key is pinned in known_hosts. */
  private async keys(thread: Thread): Promise<{ host: { privateKey: string; publicKey: string }; clientPub: string }> {
    const vm = machine(thread);
    const directory = this.keyDirectory(thread);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of ["id_ed25519", "host_ed25519"]) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) continue;
      fs.rmSync(`${file}.pub`, { force: true });
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `cube-${vm.vmId}`, "-f", file]);
    }
    const host = { privateKey: fs.readFileSync(path.join(directory, "host_ed25519"), "utf8"),
      publicKey: fs.readFileSync(path.join(directory, "host_ed25519.pub"), "utf8").trim() };
    const known = `cube-vm-${vm.vmId} ${host.publicKey.split(" ").slice(0, 2).join(" ")}\n`;
    const knownPath = path.join(directory, "known_hosts");
    if (!fs.existsSync(knownPath) || fs.readFileSync(knownPath, "utf8") !== known) fs.writeFileSync(knownPath, known, { mode: 0o600 });
    return { host, clientPub: fs.readFileSync(path.join(directory, "id_ed25519.pub"), "utf8").trim() };
  }

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

/** The provisioning script: fetch only each declared branch, verify the
 * pinned commit and check it out detached. Credentials (GitHub) come from the
 * guest's placeholder through the gateway. */
export function provisionScript(allocation: WorkspaceAllocation): string {
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
    "  git -C \"$dir\" -c advice.detachedHead=false checkout -q --detach \"$oid\"",
    "}",
    ...checkouts(allocation).map(item => `checkout ${quote(item.dir)} ${quote(item.url)} ${quote(item.ref)} ${quote(item.oid)}`),
    "echo provisioned",
  ];
  return lines.join("\n");
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
 * lease and a fixed key; reattaches to it when the key already ran. */
async function own(workspace: Workspace, owner: WorkspaceOwner, key: string | ((epoch: number) => string), command: string, timeoutMs: number) {
  const lease = await workspace.lease({ owner });
  try {
    if (typeof key !== "string") key = key(lease.epoch);
    await workspace.exec(lease.token, key, { command, timeoutMs });
    return await settleOperation(workspace, lease.token, key);
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Checks out the thread's pinned repositories once. `attempt` numbers the
 * try: a failed one is never rerun under its key, a new try gets a new key. */
export async function provisionWorkspace(workspace: Workspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation, attempt: number): Promise<void> {
  const state = await own(workspace, owner, `cube:provision:${attempt}`, provisionScript(allocation), 600000);
  if (state.state === "succeeded" && state.exitCode === 0) return;
  const output = state.state === "succeeded" ? Buffer.from(state.output).toString("utf8").trim().split("\n").slice(-4).join("; ") : state.state;
  throw new Error(`checking out the project failed${output ? `: ${output}` : ""}`);
}

/** Whether a provisioning try already succeeded (or still runs: wait for it). */
export async function provisioned(workspace: Workspace, owner: WorkspaceOwner, attempt: number): Promise<boolean | null> {
  const lease = await workspace.lease({ owner });
  try {
    const state = await settleOperation(workspace, lease.token, `cube:provision:${attempt}`);
    return state.state === "succeeded" && state.exitCode === 0;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return null;
    throw error;
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Whether the thread's machine may be deleted at archive. */
export async function releaseCheck(workspace: Workspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation): Promise<{ clean: boolean; reason: string }> {
  const state = await own(workspace, owner, epoch => `cube:release-check:${epoch}`, releaseCheckScript(allocation), 120000);
  if (state.state !== "succeeded" || state.exitCode !== 0) return { clean: false, reason: `the release check did not finish (${state.state})` };
  const output = Buffer.from(state.output).toString("utf8").trim();
  return output === "clean" ? { clean: true, reason: "clean" } : { clean: false, reason: output.replace(/^dirty: /, "") || "unknown" };
}
