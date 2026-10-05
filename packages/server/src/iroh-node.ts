/** cubed's runner client, protocol 3: direct in-process Iroh, no subprocess,
 * no stdio bridge. A runner hosts one QEMU VM per active thread and runs no
 * command of its own; this client allocates, starts, stops, inspects and
 * releases those VMs. Every request is idempotent by content; every mutation
 * carries the thread's VM epoch, which the runner fences. Config and keys
 * stay on the control plane. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Schema } from "effect";
// The 1.1.0 tarball publishes index.js/index.d.ts at its root, while its
// manifest incorrectly points at iroh-js/. Pin and use the published subpath.
import { Endpoint, EndpointAddr, EndpointId, SecretKey, type Connection, type BiStream } from "@number0/iroh/index.js";
import { ExecutionNodeError, type NodeContact, type NodeErrorCode } from "./execution-node-contract.ts";

const MAX_FRAME = 1024 * 1024;
export const PROTOCOL = 3;
export const RUNNER_CONFIG_VERSION = 2;
const SHA = /^[0-9a-f]{64}$/;
const RPC_TIMEOUT_MS = 5000;
/** vm.start waits up to 3 s on the runner and writes the seed. */
const VM_RPC_TIMEOUT_MS = 15000;
const ALPN = Array.from(Buffer.from("cubeyard/node/1"));
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const VM_ID = /^[0-9a-f]{16}$/;
const MAC = /^02(?::[0-9a-f]{2}){5}$/;
const NODE_ID = /^node-[a-zA-Z0-9-]{1,123}$/;
const PEER = /^[0-9a-f]{64}$/;
const CODES = new Set(["NODE_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNSUPPORTED", "UNAUTHORIZED", "WRONG_NODE", "INVALID_REQUEST", "CONFLICT",
  "CAPACITY_EXCEEDED", "DRAINING", "CANCELLED", "INCOMPATIBLE_PROTOCOL", "ENVIRONMENT_MISSING", "IO_ERROR", "LEASE_STALE", "NOT_FOUND"]);
const MUTATIONS = new Set(["vm.allocate", "vm.start", "vm.stop", "vm.release", "vm.discard"]);
export const RUNNER_CAPABILITIES = ["node.status", "vm.allocate", "vm.start", "vm.stop", "vm.inspect", "vm.release"] as const;
export const VM_STATES = ["allocating", "allocated", "starting", "running", "stopping", "stopped", "releasing", "released", "retained", "failed"] as const;
const ProtocolCompatibility = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL),
  minimumProtocolVersion: Schema.Literal(PROTOCOL),
  softwareVersion: Schema.String,
});

export type RunnerNetwork = "loopback" | "direct" | "relay";
export interface NodeBinding { nodeId: string; environmentId: number; threadId: string }
/** Where the gateway dials the runner's frame channel. */
export interface RunnerTarget { peer: string; network: RunnerNetwork; address?: string }
/** Advertised in node.hello; every bound is enforced by the runner. */
export interface VmLimits {
  maxFrameBytes: number; requestTimeoutMs: number; maxVcpus: number; maxMemoryMiB: number; maxDiskGiB: number;
  maxSeedBytes: number; maxActiveVms: number;
}
export interface RunnerDescription { softwareVersion: string; capabilities: string[]; limits: VmLimits; platform: string; baseImageSha256: string }
export type VmState = typeof VM_STATES[number];
export interface VmRecord {
  vmId: string; threadId: string; state: VmState; interrupted: boolean; error?: string;
  diskBytes: number; seedSha256?: string; startedAt?: number;
}
export interface VmSeed { metaData: string; userData: string; networkConfig: string }
export interface VmStartSpec { vcpus: number; memoryMiB: number; mac: string; seed: VmSeed; gateway: { peer: string; frameToken: string } }
export interface VmRef { threadId: string; vmId: string }
export interface TrustedRunnerHealth {
  lifecycle: "ready" | "draining" | "faulted" | "recoveryRequired";
  draining: boolean;
  error: string | null;
  activeVms: number;
  runningVms: number;
  maxActiveVms: number;
  retainedVms: number;
  retainedBytes: number;
  softwareVersion: string;
  protocolVersion: 3;
}
interface RunnerConfig {
  version: 2; binding: NodeBinding; controlKey: string; serverPeer: string;
  address?: string; network: RunnerNetwork;
}

export class IrohNodeError extends ExecutionNodeError {
  readonly remoteCode: string;
  constructor(remoteCode: string, completionUnknown = false, detail?: string) {
    const code: NodeErrorCode = completionUnknown || remoteCode === "OUTCOME_UNKNOWN" ? "COMPLETION_UNKNOWN"
      : remoteCode === "UNSUPPORTED" ? "OPERATION_UNSUPPORTED"
      : remoteCode === "UNAUTHORIZED" ? "WRONG_NODE"
      : remoteCode as NodeErrorCode;
    super(code);
    this.remoteCode = remoteCode;
    // An older runner's own incompatibility text names its protocol, not the
    // fix; cubed states the one it requires.
    this.message = detail && remoteCode !== "INCOMPATIBLE_PROTOCOL" && detail !== "runner request rejected" && detail !== "runner state could not be confirmed"
      ? detail
      : `${code}${remoteCode === "INCOMPATIBLE_PROTOCOL" ? `: cubed and cube-runner do not share protocol version ${PROTOCOL}; a protocol-2 runner must be re-enrolled as a VM runner` : ""}${this.completionUnknown ? "; the request may have been applied — repeat it, every vm request is idempotent" : ""}`;
  }
}
class ValidationError extends IrohNodeError { constructor() { super("INVALID_REQUEST"); } }
function invalid(): never { throw new ValidationError(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function shape(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  const row = record(value);
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function binding(value: unknown): NodeBinding {
  const row = shape(value, ["nodeId", "environmentId", "threadId"]);
  if (typeof row.nodeId !== "string" || !NODE_ID.test(row.nodeId) || typeof row.threadId !== "string" || !ID.test(row.threadId) || !integer(row.environmentId, 1)) invalid();
  return { nodeId: row.nodeId, environmentId: row.environmentId, threadId: row.threadId };
}
function equalBinding(a: NodeBinding, b: NodeBinding): boolean {
  return a.nodeId === b.nodeId && a.environmentId === b.environmentId && a.threadId === b.threadId;
}
function limits(value: unknown): VmLimits {
  const keys = ["maxFrameBytes", "requestTimeoutMs", "maxVcpus", "maxMemoryMiB", "maxDiskGiB", "maxSeedBytes", "maxActiveVms"] as const;
  const row = shape(value, [...keys]);
  if (row.maxFrameBytes !== MAX_FRAME || !integer(row.requestTimeoutMs, 1, RPC_TIMEOUT_MS) || keys.some(key => !integer(row[key], 1))) invalid();
  return Object.fromEntries(keys.map(key => [key, row[key]])) as unknown as VmLimits;
}
function vmRecord(value: unknown, ref: VmRef): VmRecord {
  const row = shape(value, ["vmId", "threadId", "state", "interrupted", "diskBytes"], ["error", "seedSha256", "startedAt"]);
  if (row.vmId !== ref.vmId || row.threadId !== ref.threadId || !VM_STATES.includes(row.state as VmState) || typeof row.interrupted !== "boolean"
    || !integer(row.diskBytes, 0) || !(row.error === undefined || (typeof row.error === "string" && row.error.length <= 65536))
    || !(row.seedSha256 === undefined || (typeof row.seedSha256 === "string" && SHA.test(row.seedSha256)))
    || !(row.startedAt === undefined || integer(row.startedAt, 0))) invalid();
  return row as unknown as VmRecord;
}
function vmRef(ref: VmRef): VmRef {
  if (!ref || typeof ref.threadId !== "string" || !ID.test(ref.threadId) || typeof ref.vmId !== "string" || !VM_ID.test(ref.vmId)) invalid();
  return { threadId: ref.threadId, vmId: ref.vmId };
}
function epochField(epoch: number): number {
  if (!integer(epoch, 1)) invalid();
  return epoch;
}
function localIO<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof IrohNodeError) throw error;
    throw new IrohNodeError("IO_ERROR"); // no private paths or native diagnostics
  }
}
function readPrivate(filename: string, limit: number): Buffer {
  return localIO(() => {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) invalid();
    // NONBLOCK prevents a FIFO at an operator path from stalling the process
    // before fstat can reject it. No symlink or non-regular file is consumed.
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > limit) invalid();
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (n === 0) break;
        length += n;
      }
      if (length > limit) invalid();
      return buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
  });
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
}
function socketAddress(value: unknown): { address: string; loopback: boolean } {
  if (typeof value !== "string") invalid();
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  if (!match || !isIP(match[1] ?? match[2]) || !integer(Number(match[3]), 1, 65535)) invalid();
  const host = match[1] ?? match[2];
  let loopback: boolean;
  if (isIP(host) === 4) {
    const first = Number(host.split(".")[0]);
    if (host === "0.0.0.0" || host === "255.255.255.255" || (first >= 224 && first <= 239)) invalid();
    loopback = first === 127;
  } else {
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    if (normalized === "::" || normalized.startsWith("ff") || normalized.startsWith("::ffff:")) invalid();
    loopback = normalized === "::1";
  }
  return { address: value, loopback };
}
/** A runner config: `{version: 2, binding, controlKey, serverPeer, network,
 * address?}` (address for loopback/direct only), mode 0600. A version-1
 * config belonged to a protocol-2 runner; it is refused (re-enroll). */
export function loadRunnerConfig(filename: string): { config: RunnerConfig; hash: string } {
  const bytes = readPrivate(filename, 16384);
  const raw = record(json(bytes));
  if (raw.version === 1) {
    const error = new IrohNodeError("INCOMPATIBLE_PROTOCOL");
    error.message = "INCOMPATIBLE_PROTOCOL: this runner config is version 1 (protocol 2); re-enroll the runner as a VM runner with a version 2 config";
    throw error;
  }
  const network = raw.network;
  const row = network === "relay"
    ? shape(raw, ["version", "binding", "controlKey", "serverPeer", "network"])
    : shape(raw, ["version", "binding", "controlKey", "serverPeer", "address", "network"]);
  if (row.version !== RUNNER_CONFIG_VERSION || typeof row.serverPeer !== "string" || !PEER.test(row.serverPeer)
    || typeof row.controlKey !== "string" || !path.isAbsolute(row.controlKey)
    || !["loopback", "direct", "relay"].includes(String(row.network))) invalid();
  try { EndpointId.fromBytes(Array.from(Buffer.from(row.serverPeer, "hex"))); } catch { return invalid(); }
  let location: Pick<RunnerConfig, "address">;
  if (row.network === "relay") {
    location = {};
  } else {
    const target = socketAddress(row.address);
    if (row.network === "loopback" && !target.loopback) invalid();
    location = { address: target.address };
  }
  return { config: { version: 2, binding: binding(row.binding), controlKey: row.controlKey, serverPeer: row.serverPeer,
    ...location, network: row.network as RunnerNetwork },
    hash: createHash("sha256").update(bytes).digest("hex") };
}
function frame(value: unknown): number[] {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length === 0 || payload.length > MAX_FRAME) invalid();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
}
async function readFrame(stream: BiStream): Promise<Record<string, unknown>> {
  const header = Buffer.from(await stream.recv.readExact(4));
  const length = header.readUInt32BE();
  if (length === 0 || length > MAX_FRAME) invalid();
  const bytes = await stream.recv.readExact(length);
  if ((await stream.recv.read(1)).length !== 0) invalid(); // FIN, no trailing bytes
  return record(json(Uint8Array.from(bytes)));
}
function remoteError(result: Record<string, unknown>): IrohNodeError | undefined {
  if (result.type !== "Error") return;
  shape(result, ["type", "code", "message", "completionUnknown"]);
  if (typeof result.code !== "string" || !CODES.has(result.code) || typeof result.message !== "string" || result.message.length > 65536
    || typeof result.completionUnknown !== "boolean") invalid();
  return new IrohNodeError(result.code, result.completionUnknown, result.message);
}

export class IrohRunnerClient {
  readonly nodeId: string;
  readonly binding: Readonly<NodeBinding>;
  readonly configHash: string;
  contact: NodeContact = "unobserved";
  private readonly config: RunnerConfig;
  private readonly configPath: string;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(options: { configPath: string; configHash?: string }) {
    shape(options, ["configPath"], ["configHash"]);
    const { config, hash } = loadRunnerConfig(options.configPath);
    if (options.configHash !== undefined && options.configHash !== hash) throw new IrohNodeError("CONFLICT");
    this.binding = Object.freeze({ ...config.binding });
    this.nodeId = config.binding.nodeId;
    this.config = config;
    this.configPath = options.configPath;
    this.configHash = hash;
    // Reading config is not contact: construction reads no key, binds no
    // socket and sends nothing.
  }
  /** Where the gateway reaches this runner's frame channel. */
  get target(): RunnerTarget {
    return { peer: this.config.serverPeer, network: this.config.network, ...(this.config.address ? { address: this.config.address } : {}) };
  }
  private assertConfig(): void {
    if (createHash("sha256").update(readPrivate(this.configPath, 16384)).digest("hex") !== this.configHash) throw new IrohNodeError("CONFLICT");
  }
  private identity(): SecretKey {
    const bytes = readPrivate(this.config.controlKey, 32);
    if (bytes.length !== 32) invalid();
    const key = SecretKey.fromBytes(Array.from(bytes));
    bytes.fill(0);
    return key;
  }
  private hello(value: unknown): Record<string, unknown> {
    const hello = shape(value, ["type", "nodeId", "profiles", "capabilities", "limits"],
      ["binding", "protocolVersion", "minimumProtocolVersion", "softwareVersion", "platform", "baseImageSha256"]);
    try { Schema.decodeUnknownSync(ProtocolCompatibility)(hello); }
    catch { throw new IrohNodeError("INCOMPATIBLE_PROTOCOL"); }
    if (hello.type !== "Hello" || hello.nodeId !== this.nodeId
      || hello.binding === undefined || !equalBinding(binding(hello.binding), this.binding)) throw new IrohNodeError("WRONG_NODE");
    if (!Array.isArray(hello.profiles) || !hello.profiles.includes("runner") || !hello.profiles.every(x => typeof x === "string")
      || !Array.isArray(hello.capabilities) || !hello.capabilities.every(x => typeof x === "string")
      || typeof hello.platform !== "string" || typeof hello.baseImageSha256 !== "string" || !SHA.test(hello.baseImageSha256)) invalid();
    hello.limits = limits(hello.limits);
    return hello;
  }
  /** A native endpoint per RPC, in THIS process. Calls are serialized because
   * concurrent endpoints cannot safely publish the same Iroh identity. */
  private async request(query?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const previous = this.requestTail;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.requestTail = previous.then(() => turn, () => turn);
    let onAbort: (() => void) | undefined;
    const interrupted = signal && new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new IrohNodeError("NODE_UNAVAILABLE"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal?.aborted) throw new IrohNodeError("NODE_UNAVAILABLE");
      await (interrupted ? Promise.race([previous, interrupted]) : previous);
      return await this.requestOne(query, signal);
    } finally {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      release();
    }
  }
  /** Owning the endpoint per call lets a deadline close pending connect/read
   * operations. Late bind/connect completions are closed too; no retry task. */
  private async requestOne(query?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new IrohNodeError("NODE_UNAVAILABLE");
    this.assertConfig();
    const key = this.identity();
    const mutating = MUTATIONS.has(String(query?.method));
    const requestBytes = query ? frame(query) : undefined;
    const builder = Endpoint.builder();
    if (this.config.network === "relay") builder.applyN0();
    else builder.applyMinimal();
    builder.secretKey(key.toBytes());
    builder.alpns([]); // caller endpoint has no server-side application protocols
    if (this.config.network === "loopback") {
      // Each bind replaces that family's wildcard default in @number0/iroh.
      // Both must be explicit: the binding does not expose clearIpTransports().
      builder.bindAddr("127.0.0.1:0");
      builder.bindAddr("[::1]:0");
    }
    const peer = EndpointId.fromBytes(Array.from(Buffer.from(this.config.serverPeer, "hex")));
    const address = this.config.network === "relay"
      ? new EndpointAddr(peer)
      : new EndpointAddr(peer, null, [this.config.address!]);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let endpoint: Endpoint | undefined;
    let connection: Connection | undefined;
    let closeTask: Promise<void> | undefined;
    let finished = false;
    let possibleDelivery = false;
    const close = () => {
      connection?.close(0n, []);
      if (endpoint && !closeTask) closeTask = endpoint.close();
      // A close initiated by an abort listener must not create an unhandled
      // rejection; finally still awaits the same task for resource cleanup.
      void closeTask?.catch(() => {});
    };
    let onAbort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        finished = true;
        close();
        reject(new IrohNodeError(possibleDelivery ? "OUTCOME_UNKNOWN" : "NODE_UNAVAILABLE", possibleDelivery));
      };
      combined.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), query && String(query.method).startsWith("vm.") ? VM_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS);
    const work = async () => {
      endpoint = await builder.bind();
      if (finished || combined.aborted) { close(); throw new Error("request ended before bind"); }
      connection = await endpoint.connect(address, ALPN);
      if (finished || combined.aborted) { close(); throw new Error("request ended before connect"); }
      if (!connection.remoteId().equals(peer)) throw new IrohNodeError("WRONG_NODE");
      let stream = await connection.openBi();
      await stream.send.writeAll(frame({ method: "node.hello", protocolVersion: PROTOCOL }));
      await stream.send.finish();
      const response = await readFrame(stream);
      const error = remoteError(response);
      if (error) throw error;
      const hello = this.hello(response); // full immutable node binding
      if (!query) return hello;
      if (!(hello.capabilities as string[]).includes(query.method as string)) throw new IrohNodeError("UNSUPPORTED");
      combined.throwIfAborted();
      stream = await connection.openBi();
      combined.throwIfAborted();
      possibleDelivery = mutating;
      await stream.send.writeAll(requestBytes!);
      await stream.send.finish();
      const result = await readFrame(stream);
      const failure = remoteError(result);
      if (failure) { this.contact = "available"; throw failure; }
      if (query.method === "node.status") {
        shape(result, ["type", "nodeId", "binding", "status", "protocolVersion", "minimumProtocolVersion", "softwareVersion"]);
        if (result.type !== "Status" || result.nodeId !== this.nodeId || !equalBinding(binding(result.binding), this.binding)) invalid();
        try { Schema.decodeUnknownSync(ProtocolCompatibility)(result); }
        catch { throw new IrohNodeError("INCOMPATIBLE_PROTOCOL"); }
        const status = shape(result.status, ["lifecycle", "draining", "activeVms", "runningVms", "maxActiveVms", "retainedVms", "retainedBytes"], ["error"]);
        if (!["ready", "draining", "faulted", "recoveryRequired"].includes(String(status.lifecycle)) || typeof status.draining !== "boolean"
          || !integer(status.activeVms, 0) || !integer(status.runningVms, 0) || !integer(status.maxActiveVms, 1)
          || !integer(status.retainedVms, 0) || !integer(status.retainedBytes, 0)
          || !(status.error === undefined || (typeof status.error === "string" && status.error.length <= 4096))) invalid();
      } else {
        shape(result, ["type", "vm"], ["consoleTail"]);
        if (result.type !== "Vm" || !(result.consoleTail === undefined || typeof result.consoleTail === "string")) invalid();
        result.vm = vmRecord(result.vm, { threadId: query.threadId as string, vmId: query.vmId as string });
      }
      return result;
    };
    try {
      if (combined.aborted) onAbort();
      const result = await Promise.race([work(), interrupted]);
      this.contact = "available";
      return result;
    } catch (error) {
      if (error instanceof IrohNodeError && !(error instanceof ValidationError)) {
        if (["NODE_UNAVAILABLE", "WRONG_NODE", "COMPLETION_UNKNOWN"].includes(error.code)) this.contact = "unavailable";
        throw error;
      }
      this.contact = "unavailable";
      throw new IrohNodeError(possibleDelivery ? "OUTCOME_UNKNOWN" : "NODE_UNAVAILABLE", possibleDelivery);
    } finally {
      finished = true;
      clearTimeout(timer);
      combined.removeEventListener("abort", onAbort);
      close();
      // iroh gracefully drains QUIC here (about 3s for an unreachable peer).
      // Cancellation closes native IO, not a remote operation.
      await closeTask;
    }
  }
  /** Authenticated hello: capabilities, limits, platform and base image. */
  async describe(signal?: AbortSignal): Promise<RunnerDescription> {
    signal?.throwIfAborted();
    const hello = await this.request(undefined, signal);
    const capabilities = hello.capabilities as string[];
    if (!RUNNER_CAPABILITIES.every(capability => capabilities.includes(capability))) throw new IrohNodeError("UNSUPPORTED");
    return { softwareVersion: hello.softwareVersion as string, capabilities: [...capabilities], limits: hello.limits as VmLimits,
      platform: hello.platform as string, baseImageSha256: hello.baseImageSha256 as string };
  }
  /** Contact only. */
  async check(): Promise<void> { await this.describe(); }
  async health(): Promise<TrustedRunnerHealth> {
    const result = await this.request({ method: "node.status" });
    const status = result.status as Omit<TrustedRunnerHealth, "softwareVersion" | "protocolVersion" | "error"> & { error?: string };
    return { ...status, error: status.error ?? null, softwareVersion: result.softwareVersion as string, protocolVersion: PROTOCOL };
  }
  async vmAllocate(ref: VmRef, epoch: number, diskGiB: number): Promise<VmRecord> {
    if (!integer(diskGiB, 1, 4096)) invalid();
    return this.vm({ method: "vm.allocate", ...vmRef(ref), epoch: epochField(epoch), diskGiB });
  }
  async vmStart(ref: VmRef, epoch: number, spec: VmStartSpec): Promise<VmRecord> {
    const row = shape(spec, ["vcpus", "memoryMiB", "mac", "seed", "gateway"]);
    const seed = shape(row.seed, ["metaData", "userData", "networkConfig"]);
    const gateway = shape(row.gateway, ["peer", "frameToken"]);
    if (!integer(row.vcpus, 1, 64) || !integer(row.memoryMiB, 256) || typeof row.mac !== "string" || !MAC.test(row.mac)
      || ![seed.metaData, seed.userData, seed.networkConfig].every(text => typeof text === "string")
      || typeof gateway.peer !== "string" || !PEER.test(gateway.peer) || typeof gateway.frameToken !== "string" || !/^[0-9a-f]{64}$/.test(gateway.frameToken)) invalid();
    return this.vm({ method: "vm.start", ...vmRef(ref), epoch: epochField(epoch), vcpus: spec.vcpus, memoryMiB: spec.memoryMiB, mac: spec.mac,
      seed: { metaData: spec.seed.metaData, userData: spec.seed.userData, networkConfig: spec.seed.networkConfig },
      gateway: { peer: spec.gateway.peer, frameToken: spec.gateway.frameToken } });
  }
  /** Asynchronous on the runner: poll vmInspect until `stopped`. */
  async vmStop(ref: VmRef, epoch: number): Promise<VmRecord> {
    return this.vm({ method: "vm.stop", ...vmRef(ref), epoch: epochField(epoch) });
  }
  async vmInspect(ref: VmRef, signal?: AbortSignal): Promise<{ vm: VmRecord; consoleTail: string | null }> {
    const result = await this.request({ method: "vm.inspect", ...vmRef(ref) }, signal);
    return { vm: result.vm as VmRecord, consoleTail: (result.consoleTail as string | undefined) ?? null };
  }
  /** Asynchronous for a live VM: poll vmInspect until `released`/`retained`.
   * The runner always retains an interrupted or failed VM. */
  async vmRelease(ref: VmRef, epoch: number, retain: boolean): Promise<VmRecord> {
    if (typeof retain !== "boolean") invalid();
    return this.vm({ method: "vm.release", ...vmRef(ref), epoch: epochField(epoch), retain });
  }
  /** Deletes a retained VM's disk (runner 0.5.0+; older runners: UNSUPPORTED). */
  async vmDiscard(ref: VmRef, epoch: number): Promise<VmRecord> {
    return this.vm({ method: "vm.discard", ...vmRef(ref), epoch: epochField(epoch) });
  }
  private async vm(query: Record<string, unknown>): Promise<VmRecord> {
    return (await this.request(query)).vm as VmRecord;
  }
}
