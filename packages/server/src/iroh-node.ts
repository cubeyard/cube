/** Direct in-process iroh client. No subprocess, stdio bridge, local execution
 * fallback or automatic command resubmission. Config/keys/intents stay on the
 * control plane; production enrollment/tool routing is separate integration. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
// The 1.1.0 tarball publishes index.js/index.d.ts at its root, while its
// manifest incorrectly points at iroh-js/. Pin and use the published subpath.
import { Endpoint, EndpointAddr, EndpointId, SecretKey, type Connection, type BiStream } from "@number0/iroh/index.js";
import { ExecutionNodeError, type ExecutionNodeClient, type EnvironmentObservation, type NodeContact, type NodeErrorCode } from "./execution-node-contract.ts";
import type { WorkspaceAllocation } from "./registry.ts";

const MAX_FRAME = 1024 * 1024;
const PROTOCOL = 2;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT = 262144;
const MAX_WRITE = 524288;
const SHA = /^[0-9a-f]{64}$/;
const RPC_TIMEOUT_MS = 5000;
const WORKSPACE_RPC_TIMEOUT_MS = 30000;
const ALPN = Array.from(Buffer.from("cubeyard/node/1"));
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NODE_ID = /^node-[a-zA-Z0-9-]{1,123}$/;
const PEER = /^[0-9a-f]{64}$/;
const CODES = new Set(["NODE_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNSUPPORTED", "UNAUTHORIZED", "WRONG_NODE", "INVALID_REQUEST", "CONFLICT", "CAPACITY_EXCEEDED", "DRAINING", "CANCELLED", "INCOMPATIBLE_PROTOCOL", "ENVIRONMENT_MISSING", "ENVIRONMENT_STOPPED", "IO_ERROR",
  "LEASE_STALE", "PRECONDITION_FAILED", "NOT_FOUND"]);
const FAILURES = new Set(["IO_ERROR", "CANCELLED", "PRECONDITION_FAILED", "NOT_FOUND", "INVALID_REQUEST", "UNSUPPORTED"]);
const ProtocolCompatibility = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL),
  minimumProtocolVersion: Schema.Literal(PROTOCOL),
  softwareVersion: Schema.String,
});
export interface NodeBinding { nodeId: string; environmentId: number; threadId: string }
export interface RunnerExecSpec { command: string; guestCwd: string; timeoutMs: number; outputLimit: number }
export interface RunnerExecResult {
  exitCode: number | null;
  termination: "exited" | "signalled" | "timedOut";
  /** One page of retained output starting at outputOffset. */
  output: number[];
  outputBytes: number;
  truncated: boolean;
  outputOffset: number;
  retainedBytes: number;
}
/** Advertised in node.hello; every bound is enforced by the runner. */
export interface RunnerLimits {
  maxFrameBytes: number;
  requestTimeoutMs: number;
  maxCommandBytes: number;
  maxPathBytes: number;
  maxExecTimeoutMs: number;
  maxOutputBytes: number;
  outputPageBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
}
export interface RunnerDescription { softwareVersion: string; capabilities: string[]; limits: RunnerLimits }
export interface RunnerFile { content: Buffer; offset: number; size: number; eof: boolean; sha256: string | null }
export interface RunnerWriteResult { sha256: string; size: number }
export interface RunnerFileStat {
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  modifiedMs: number;
  sha256: string | null;
}
export interface TrustedRunnerHealth {
  lifecycle: "ready" | "draining" | "faulted" | "recoveryRequired";
  active: boolean;
  operationRecords: number;
  operationCapacity: number;
  error: "ENVIRONMENT_MISSING" | "IO_ERROR" | "UNSUPPORTED" | null;
  softwareVersion: string;
  protocolVersion: 2;
  activeWorkspaces: number;
  retainedWorkspaces: number;
  workspaceBytes: number;
  workspaceCapacity: number;
  workspaceByteLimit: number;
}
export interface RunnerRepositorySource { url: string; branch: string }
export interface RunnerWorkspace {
  threadId: string;
  state: "available" | "released";
  kind: "git" | "copy" | "retained";
  retained: boolean;
  baseRemote?: string;
  baseRef?: string;
  baseOid?: string;
}
export type RunnerOperation =
  | { state: "Accepted" | "Running" | "Unknown" }
  | { state: "Succeeded"; result: RunnerExecResult }
  | { state: "Written"; result: RunnerWriteResult }
  | { state: "Failed"; error: string; completionUnknown: boolean }
  | { state: "Interrupted"; completionUnknown: true };
interface IrohConfig {
  version: 1; binding: NodeBinding; controlKey: string; serverPeer: string;
  address?: string;
  network: "loopback" | "direct" | "relay"; intentDirectory: string;
}
interface Intent {
  operationId: string; nodeId: string; environmentId: number; threadId: string;
  serverPeer: string; controlPeer: string; spec: RunnerExecSpec;
}

export class IrohNodeError extends ExecutionNodeError {
  readonly operationId?: string;
  readonly remoteCode: string;
  constructor(remoteCode: string, operationId?: string, completionUnknown = false, detail?: string) {
    const code: NodeErrorCode = completionUnknown || remoteCode === "OUTCOME_UNKNOWN" ? "COMPLETION_UNKNOWN"
      : remoteCode === "UNSUPPORTED" ? "OPERATION_UNSUPPORTED"
      : remoteCode === "UNAUTHORIZED" ? "WRONG_NODE"
      : remoteCode === "ENVIRONMENT_STOPPED" ? "OPERATION_UNSUPPORTED"
      : remoteCode as NodeErrorCode;
    super(code);
    this.operationId = operationId;
    this.remoteCode = remoteCode;
    this.message = detail && detail !== "runner request rejected" && detail !== "runner state could not be confirmed"
      ? detail
      : `${code}${remoteCode === "INCOMPATIBLE_PROTOCOL" ? ": cubed and cube-runner do not share protocol version 2; upgrade the older component" : ""}${operationId ? `: operation ${operationId}` : ""}${this.completionUnknown ? "; inspect the saved operation before executing again; remote work was not cancelled" : ""}`;
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
function validateSpec(spec: RunnerExecSpec): RunnerExecSpec {
  const row = shape(spec, ["command", "guestCwd", "timeoutMs", "outputLimit"]);
  if (typeof row.command !== "string" || !row.command || row.command.includes("\0") || Buffer.byteLength(row.command) > 8192
    || typeof row.guestCwd !== "string" || !row.guestCwd || row.guestCwd.includes("\0") || path.posix.isAbsolute(row.guestCwd) || Buffer.byteLength(row.guestCwd) > 4096
    || !integer(row.timeoutMs, 1, MAX_TIMEOUT_MS) || !integer(row.outputLimit, 0, MAX_OUTPUT)) invalid();
  return { command: row.command, guestCwd: row.guestCwd, timeoutMs: row.timeoutMs, outputLimit: row.outputLimit };
}
function operation(value: unknown): RunnerOperation {
  const row = record(value);
  switch (row.state) {
    case "Accepted": case "Running": case "Unknown": shape(row, ["state"]); return { state: row.state };
    case "Interrupted":
      shape(row, ["state", "completionUnknown"]);
      if (row.completionUnknown !== true) invalid();
      return { state: "Interrupted", completionUnknown: true };
    case "Failed":
      shape(row, ["state", "error", "completionUnknown"]);
      if (!FAILURES.has(String(row.error)) || typeof row.completionUnknown !== "boolean") invalid();
      return { state: "Failed", error: String(row.error), completionUnknown: row.completionUnknown };
    case "Written": {
      shape(row, ["state", "result"]);
      return { state: "Written", result: writeResult(row.result) };
    }
    case "Succeeded": {
      shape(row, ["state", "result"]);
      const result = shape(row.result, ["exitCode", "termination", "output", "outputBytes", "truncated", "outputOffset", "retainedBytes"]);
      if (!(result.exitCode === null || integer(result.exitCode, 0, 255))
        || !["exited", "signalled", "timedOut"].includes(String(result.termination))
        || !Array.isArray(result.output) || result.output.length > MAX_OUTPUT || !result.output.every(b => integer(b, 0, 255))
        || !integer(result.retainedBytes, 0, MAX_OUTPUT) || !integer(result.outputOffset, 0, result.retainedBytes)
        || result.outputOffset + result.output.length > result.retainedBytes
        || !integer(result.outputBytes, result.retainedBytes) || typeof result.truncated !== "boolean"
        || (result.termination === "exited") !== (result.exitCode !== null)
        || (!result.truncated && result.outputBytes !== result.retainedBytes)) invalid();
      return { state: "Succeeded", result: result as unknown as RunnerExecResult };
    }
    default: return invalid();
  }
}
function writeResult(value: unknown): RunnerWriteResult {
  const row = shape(value, ["sha256", "size"]);
  if (typeof row.sha256 !== "string" || !SHA.test(row.sha256) || !integer(row.size, 0, MAX_WRITE)) invalid();
  return { sha256: row.sha256, size: row.size };
}
function limits(value: unknown): RunnerLimits {
  const keys = ["maxFrameBytes", "requestTimeoutMs", "maxCommandBytes", "maxPathBytes", "maxExecTimeoutMs", "maxOutputBytes",
    "outputPageBytes", "maxReadBytes", "maxWriteBytes"] as const;
  const row = shape(value, [...keys]);
  if (row.maxFrameBytes !== MAX_FRAME || !integer(row.requestTimeoutMs, 1, RPC_TIMEOUT_MS)
    || keys.some(key => !integer(row[key], 1))) invalid();
  return Object.fromEntries(keys.map(key => [key, row[key]])) as unknown as RunnerLimits;
}
function workspacePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || path.posix.isAbsolute(value) || Buffer.byteLength(value) > 4096) invalid();
  return value;
}
function epochField(epoch: number | undefined): { epoch?: number } {
  if (epoch === undefined) return {};
  if (!integer(epoch, 1)) invalid();
  return { epoch };
}
function base64(value: unknown, limit: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4) invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) invalid();
  return bytes;
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
function loadConfig(filename: string): { config: IrohConfig; hash: string } {
  const bytes = readPrivate(filename, 16384);
  const raw = record(json(bytes));
  const network = raw.network;
  const row = network === "relay"
    ? shape(raw, ["version", "binding", "controlKey", "serverPeer", "network", "intentDirectory"])
    : shape(raw, ["version", "binding", "controlKey", "serverPeer", "address", "network", "intentDirectory"]);
  if (row.version !== 1 || typeof row.serverPeer !== "string" || !PEER.test(row.serverPeer)
    || typeof row.controlKey !== "string" || !path.isAbsolute(row.controlKey)
    || typeof row.intentDirectory !== "string" || !path.isAbsolute(row.intentDirectory)
    || !["loopback", "direct", "relay"].includes(String(row.network))) invalid();
  try { EndpointId.fromBytes(Array.from(Buffer.from(row.serverPeer, "hex"))); } catch { return invalid(); }
  let location: Pick<IrohConfig, "address">;
  if (row.network === "relay") {
    location = {};
  } else {
    const target = socketAddress(row.address);
    if (row.network === "loopback" && !target.loopback) invalid();
    location = { address: target.address };
  }
  return { config: { version: 1, binding: binding(row.binding), controlKey: row.controlKey, serverPeer: row.serverPeer,
    ...location, network: row.network as IrohConfig["network"], intentDirectory: row.intentDirectory },
    hash: createHash("sha256").update(bytes).digest("hex") };
}
function writeNew(filename: string, bytes: Buffer): void {
  localIO(() => {
    const fd = fs.openSync(filename, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  });
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
function remoteError(result: Record<string, unknown>, id?: string): IrohNodeError | undefined {
  if (result.type !== "Error") return;
  shape(result, ["type", "code", "message", "completionUnknown"], ["operationId"]);
  if (typeof result.code !== "string" || !CODES.has(result.code) || typeof result.message !== "string" || result.message.length > 256
    || typeof result.completionUnknown !== "boolean" || !(result.operationId === undefined || result.operationId === id)) invalid();
  return new IrohNodeError(result.code, id, result.completionUnknown, result.message);
}

function requestId(query?: Record<string, unknown>): string | undefined {
  return typeof query?.operationId === "string" ? query.operationId
    : typeof query?.idempotencyKey === "string" ? query.idempotencyKey : undefined;
}

export class IrohExecutionNodeClient implements ExecutionNodeClient {
  readonly locality = "remote" as const;
  readonly nodeId: string;
  readonly binding: Readonly<NodeBinding>;
  contact: NodeContact = "unobserved";
  private readonly config: IrohConfig;
  private readonly installationBinding: Readonly<NodeBinding>;
  private readonly configPath: string;
  readonly configHash: string;
  private readonly observe?: (environmentId: number, observation: EnvironmentObservation) => void;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(options: { configPath: string; configHash?: string; threadId?: string; observe?: (environmentId: number, observation: EnvironmentObservation) => void }) {
    shape(options, ["configPath"], ["configHash", "threadId", "observe"]);
    const { config, hash } = loadConfig(options.configPath);
    if (options.configHash !== undefined && options.configHash !== hash) throw new IrohNodeError("CONFLICT");
    if (options.threadId !== undefined && !ID.test(options.threadId)) invalid();
    this.installationBinding = Object.freeze({ ...config.binding });
    this.binding = Object.freeze({ ...config.binding, threadId: options.threadId ?? config.binding.threadId });
    this.nodeId = config.binding.nodeId;
    this.config = config;
    this.configPath = options.configPath;
    this.configHash = hash;
    this.observe = options.observe;
    // Reading config is not opening a conversation's environment: construction
    // reads no key or intent, binds no socket, and performs no contact/provision.
  }
  private environment(id: number): void {
    if (!Number.isSafeInteger(id) || id !== this.binding.environmentId) throw new IrohNodeError("ENVIRONMENT_MISSING");
  }
  private assertConfig(): void {
    if (createHash("sha256").update(readPrivate(this.configPath, 16384)).digest("hex") !== this.configHash) throw new IrohNodeError("CONFLICT");
  }
  private identity(): { key: SecretKey; peer: string } {
    const bytes = readPrivate(this.config.controlKey, 32);
    if (bytes.length !== 32) invalid();
    const key = SecretKey.fromBytes(Array.from(bytes));
    bytes.fill(0);
    return { key, peer: Buffer.from(key.public().toBytes()).toString("hex") };
  }
  private intentPath(id: string): string {
    if (typeof id !== "string" || !ID.test(id)) invalid();
    const directory = localIO(() => fs.lstatSync(this.config.intentDirectory));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) invalid();
    return path.join(this.config.intentDirectory, `${id}.json`);
  }
  private intent(id: string, controlPeer: string): Intent {
    const value = shape(json(readPrivate(this.intentPath(id), MAX_FRAME)), ["operationId", "nodeId", "environmentId", "threadId", "serverPeer", "controlPeer", "spec"]);
    if (value.operationId !== id || value.nodeId !== this.nodeId || value.environmentId !== this.binding.environmentId || value.threadId !== this.binding.threadId
      || value.serverPeer !== this.config.serverPeer || value.controlPeer !== controlPeer) throw new IrohNodeError("WRONG_NODE", id);
    return { operationId: id, nodeId: this.nodeId, environmentId: this.binding.environmentId, threadId: this.binding.threadId,
      serverPeer: this.config.serverPeer, controlPeer, spec: validateSpec(value.spec as RunnerExecSpec) };
  }
  private hello(value: unknown): Record<string, unknown> {
    const hello = shape(value, ["type", "nodeId", "profiles", "capabilities", "limits"],
      ["binding", "protocolVersion", "minimumProtocolVersion", "softwareVersion"]);
    try { Schema.decodeUnknownSync(ProtocolCompatibility)(hello); }
    catch { throw new IrohNodeError("INCOMPATIBLE_PROTOCOL"); }
    if (hello.type !== "Hello" || hello.nodeId !== this.nodeId
      || hello.binding === undefined || !equalBinding(binding(hello.binding), this.installationBinding)) throw new IrohNodeError("WRONG_NODE");
    if (!Array.isArray(hello.profiles) || (!hello.profiles.includes("runner") && !hello.profiles.includes("host"))
      || !hello.profiles.every(x => typeof x === "string")
      || !Array.isArray(hello.capabilities) || !hello.capabilities.every(x => typeof x === "string")) invalid();
    hello.limits = limits(hello.limits);
    return hello;
  }
  /** A native endpoint per RPC, in THIS process. Calls are serialized because
   * concurrent endpoints cannot safely publish the same Iroh identity. */
  private async request(key: SecretKey, query?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const previous = this.requestTail;
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.requestTail = previous.then(() => turn, () => turn);
    const id = requestId(query);
    let onAbort: (() => void) | undefined;
    const interrupted = signal && new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new IrohNodeError("NODE_UNAVAILABLE", id));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal?.aborted) throw new IrohNodeError("NODE_UNAVAILABLE", id);
      await (interrupted ? Promise.race([previous, interrupted]) : previous);
      return await this.requestOne(key, query, signal);
    } finally {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      release();
    }
  }
  /** Owning the endpoint per call lets a deadline close pending connect/read
   * operations. Late bind/connect completions are closed too; no retry task. */
  private async requestOne(key: SecretKey, query?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = requestId(query);
    if (signal?.aborted) throw new IrohNodeError("NODE_UNAVAILABLE", id);
    this.assertConfig();
    const mutating = ["exec.start", "exec.cancel", "fs.write", "workspace.allocate", "workspace.allocate.v2", "workspace.release"].includes(String(query?.method));
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
        reject(new IrohNodeError(possibleDelivery ? "OUTCOME_UNKNOWN" : "NODE_UNAVAILABLE", id, possibleDelivery));
      };
      combined.addEventListener("abort", onAbort, { once: true });
    });
    const timeoutMs = query && ["workspace.allocate", "workspace.allocate.v2", "workspace.release"].includes(String(query.method))
      ? WORKSPACE_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const work = async () => {
      endpoint = await builder.bind();
      if (finished || combined.aborted) { close(); throw new Error("request ended before bind"); }
      connection = await endpoint.connect(address, ALPN);
      if (finished || combined.aborted) { close(); throw new Error("request ended before connect"); }
      if (!connection.remoteId().equals(peer)) throw new IrohNodeError("WRONG_NODE", id);
      let stream = await connection.openBi();
      await stream.send.writeAll(frame({ method: "node.hello", protocolVersion: PROTOCOL }));
      await stream.send.finish();
      const response = await readFrame(stream);
      const error = remoteError(response);
      if (error) throw error;
      const hello = this.hello(response); // full immutable thread/env/node binding
      if (!query) return hello;
      if (!(hello.capabilities as string[]).includes(query.method as string)) throw new IrohNodeError("UNSUPPORTED", id);
      if (query.method === "workspace.allocate"
        && !(hello.capabilities as string[]).includes("workspace.fresh-base")) throw new IrohNodeError("INCOMPATIBLE_PROTOCOL");
      combined.throwIfAborted();
      stream = await connection.openBi();
      combined.throwIfAborted();
      possibleDelivery = mutating;
      await stream.send.writeAll(requestBytes!);
      await stream.send.finish();
      const result = await readFrame(stream);
      const failure = remoteError(result, id);
      if (failure) {
        this.contact = "available";
        if (result.code === "ENVIRONMENT_MISSING" && query.method === "environment.inspect") this.observe?.(this.binding.environmentId, { status: "missing", observedAt: Date.now() });
        throw failure;
      }
      switch (query.method) {
        case "node.status": {
          shape(result, ["type", "nodeId", "binding", "status"],
            ["protocolVersion", "minimumProtocolVersion", "softwareVersion"]);
          if (result.type !== "Status" || result.nodeId !== this.nodeId || !equalBinding(binding(result.binding), this.installationBinding)) invalid();
          try { Schema.decodeUnknownSync(ProtocolCompatibility)(result); }
          catch { throw new IrohNodeError("INCOMPATIBLE_PROTOCOL"); }
          const status = shape(result.status, ["lifecycle", "active", "operationRecords", "operationCapacity", "error",
            "activeWorkspaces", "retainedWorkspaces", "workspaceBytes", "workspaceCapacity", "workspaceByteLimit"]);
          if (!["ready", "draining", "faulted", "recoveryRequired"].includes(String(status.lifecycle)) || typeof status.active !== "boolean"
            || !integer(status.operationRecords, 0) || !integer(status.operationCapacity, 1)
            || status.operationRecords > status.operationCapacity
            || !integer(status.activeWorkspaces, 0) || !integer(status.retainedWorkspaces, 0)
            || !integer(status.workspaceBytes, 0) || !integer(status.workspaceCapacity, 1) || !integer(status.workspaceByteLimit, 1)
            || status.activeWorkspaces > status.workspaceCapacity
            || ![null, "ENVIRONMENT_MISSING", "IO_ERROR", "UNSUPPORTED"].includes(status.error as null | string)) invalid();
          break;
        }
        case "environment.inspect":
          shape(result, ["type", "binding", "state"]);
          if (result.type !== "Environment" || result.state !== "ready" || !equalBinding(binding(result.binding), this.installationBinding)) invalid();
          break;
        case "workspace.allocate": case "workspace.allocate.v2": case "workspace.release": {
          shape(result, ["type", "workspace"]);
          if (result.type !== "Workspace") invalid();
          const workspace = shape(result.workspace, ["threadId", "state", "kind", "retained"], ["baseRemote", "baseRef", "baseOid"]);
          if (workspace.threadId !== this.binding.threadId || !["available", "released"].includes(String(workspace.state))
            || !["git", "copy", "retained"].includes(String(workspace.kind)) || typeof workspace.retained !== "boolean"
            || (workspace.baseRemote !== undefined && (typeof workspace.baseRemote !== "string" || workspace.baseRemote.length > 4096))
            || (workspace.baseRef !== undefined && (typeof workspace.baseRef !== "string" || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(workspace.baseRef)))
            || (workspace.baseOid !== undefined && (typeof workspace.baseOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(workspace.baseOid)))) invalid();
          break;
        }
        case "exec.start":
          shape(result, ["type", "operationId"]);
          if (result.type !== "Accepted" || result.operationId !== id) invalid();
          break;
        case "operation.get": case "exec.cancel":
          shape(result, ["type", "operationId", "operation"]);
          if (result.type !== "Operation" || result.operationId !== id) invalid();
          result.operation = operation(result.operation);
          break;
        case "fs.read": {
          shape(result, ["type", "path", "file"]);
          if (result.type !== "File" || result.path !== query.path) invalid();
          const file = shape(result.file, ["content", "offset", "size", "eof", "sha256"]);
          const content = base64(file.content, (hello.limits as RunnerLimits).maxReadBytes);
          if (!integer(file.offset, 0) || file.offset !== (query.offset ?? 0) || !integer(file.size, 0) || typeof file.eof !== "boolean"
            || content.length > ((query.limit as number | undefined) ?? (hello.limits as RunnerLimits).maxReadBytes)
            || !(file.sha256 === null || (typeof file.sha256 === "string" && SHA.test(file.sha256)))) invalid();
          result.file = { content, offset: file.offset, size: file.size, eof: file.eof, sha256: file.sha256 } satisfies RunnerFile;
          break;
        }
        case "fs.write":
          shape(result, ["type", "idempotencyKey", "result"]);
          if (result.type !== "Written" || result.idempotencyKey !== id) invalid();
          result.result = writeResult(result.result);
          break;
        case "fs.stat": {
          shape(result, ["type", "path", "stat"]);
          if (result.type !== "Stat" || result.path !== query.path) invalid();
          const stat = shape(result.stat, ["kind", "size", "mode", "modifiedMs", "sha256"]);
          if (!["file", "directory", "symlink", "other"].includes(String(stat.kind)) || !integer(stat.size, 0) || !integer(stat.mode, 0, 0o7777)
            || !Number.isSafeInteger(stat.modifiedMs) || !(stat.sha256 === null || (typeof stat.sha256 === "string" && SHA.test(stat.sha256)))) invalid();
          break;
        }
        default: invalid();
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
        if (id && !error.operationId) throw new IrohNodeError(error.remoteCode, id, error.completionUnknown);
        throw error;
      }
      this.contact = "unavailable";
      throw new IrohNodeError(possibleDelivery ? "OUTCOME_UNKNOWN" : "NODE_UNAVAILABLE", id, possibleDelivery);
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
  async status(environmentId: number): Promise<EnvironmentObservation> {
    this.environment(environmentId); this.assertConfig();
    const health = await this.health();
    if (health.lifecycle === "draining" || health.lifecycle === "recoveryRequired") throw new IrohNodeError("DRAINING");
    if (health.lifecycle === "faulted") {
      if (health.error === "ENVIRONMENT_MISSING") this.observe?.(environmentId, { status: "missing", observedAt: Date.now() });
      throw new IrohNodeError(health.error ?? "IO_ERROR");
    }
    await this.request(this.identity().key, { method: "environment.inspect", env: environmentId });
    const observation = { status: "Running", observedAt: Date.now() };
    this.observe?.(environmentId, observation);
    return observation;
  }
  async health(): Promise<TrustedRunnerHealth> {
    this.assertConfig();
    const result = await this.request(this.identity().key, { method: "node.status" });
    const status = result.status as Omit<TrustedRunnerHealth, "softwareVersion" | "protocolVersion">;
    return { ...status, softwareVersion: result.softwareVersion as string, protocolVersion: PROTOCOL };
  }
  /** Authenticated hello only: capabilities and limits of the pinned runner. */
  async describe(signal?: AbortSignal): Promise<RunnerDescription> {
    signal?.throwIfAborted(); this.assertConfig();
    const hello = await this.request(this.identity().key, undefined, signal);
    return { softwareVersion: hello.softwareVersion as string, capabilities: [...hello.capabilities as string[]], limits: hello.limits as RunnerLimits };
  }
  private threadField(): { threadId?: string } {
    return this.binding.threadId === this.installationBinding.threadId ? {} : { threadId: this.binding.threadId };
  }
  /** Dispatch under a caller-owned stable identity. The runner deduplicates:
   * a repeated ID with the same spec is a no-op, a changed spec is CONFLICT. */
  async startOperation(operationId: string, spec: RunnerExecSpec, options: { epoch?: number; signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted(); this.assertConfig();
    if (typeof operationId !== "string" || !ID.test(operationId)) invalid();
    spec = validateSpec(spec);
    await this.request(this.identity().key, { method: "exec.start", operationId, env: this.binding.environmentId,
      ...this.threadField(), ...epochField(options.epoch), spec }, options.signal);
  }
  /** Read-only. A terminal result carries one output page from `cursor`. */
  async inspectOperation(operationId: string, options: { cursor?: number; signal?: AbortSignal } = {}): Promise<RunnerOperation> {
    options.signal?.throwIfAborted(); this.assertConfig();
    if (typeof operationId !== "string" || !ID.test(operationId) || !(options.cursor === undefined || integer(options.cursor, 0))) invalid();
    return (await this.request(this.identity().key, { method: "operation.get", env: this.binding.environmentId, operationId,
      ...(options.cursor ? { cursor: options.cursor } : {}) }, options.signal)).operation as RunnerOperation;
  }
  /** Real cancellation: the runner SIGKILLs the command's process group.
   * Returns the state seen right after the request; poll for the outcome. */
  async cancelOperation(operationId: string, options: { epoch?: number; signal?: AbortSignal } = {}): Promise<RunnerOperation> {
    options.signal?.throwIfAborted(); this.assertConfig();
    if (typeof operationId !== "string" || !ID.test(operationId)) invalid();
    return (await this.request(this.identity().key, { method: "exec.cancel", env: this.binding.environmentId, operationId,
      ...this.threadField(), ...epochField(options.epoch) }, options.signal)).operation as RunnerOperation;
  }
  /** The complete retained output of a Succeeded result, page by page. */
  async collectOutput(operationId: string, result: RunnerExecResult, signal?: AbortSignal): Promise<RunnerExecResult> {
    const output = [...result.output];
    while (result.outputOffset + output.length < result.retainedBytes) {
      const page = await this.inspectOperation(operationId, { cursor: result.outputOffset + output.length, signal });
      if (page.state !== "Succeeded" || page.result.outputOffset !== result.outputOffset + output.length || !page.result.output.length) invalid();
      output.push(...page.result.output);
    }
    return { ...result, output };
  }
  async readFile(file: string, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<RunnerFile> {
    options.signal?.throwIfAborted(); this.assertConfig();
    if (!(options.offset === undefined || integer(options.offset, 0)) || !(options.limit === undefined || integer(options.limit, 1))) invalid();
    const result = await this.request(this.identity().key, { method: "fs.read", env: this.binding.environmentId, ...this.threadField(),
      path: workspacePath(file), ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }) }, options.signal);
    return result.file as RunnerFile;
  }
  /** Atomic replacement under an idempotency key. The same key and request
   * returns the original result without writing; a changed request is CONFLICT.
   * `expectedSha` is the SHA-256 of the whole current file. */
  async writeFile(file: string, content: Uint8Array, options: { idempotencyKey: string; expectedSha?: string; createParents?: boolean; epoch?: number; signal?: AbortSignal }): Promise<RunnerWriteResult> {
    options.signal?.throwIfAborted(); this.assertConfig();
    if (!(content instanceof Uint8Array) || content.length > MAX_WRITE || typeof options.idempotencyKey !== "string" || !ID.test(options.idempotencyKey)
      || !(options.expectedSha === undefined || (typeof options.expectedSha === "string" && SHA.test(options.expectedSha)))
      || !(options.createParents === undefined || typeof options.createParents === "boolean")) invalid();
    const result = await this.request(this.identity().key, { method: "fs.write", env: this.binding.environmentId, ...this.threadField(),
      ...epochField(options.epoch), idempotencyKey: options.idempotencyKey, path: workspacePath(file),
      content: Buffer.from(content).toString("base64"), ...(options.expectedSha === undefined ? {} : { expectedSha: options.expectedSha }),
      createParents: options.createParents ?? false }, options.signal);
    return result.result as RunnerWriteResult;
  }
  async stat(file: string, options: { signal?: AbortSignal } = {}): Promise<RunnerFileStat> {
    options.signal?.throwIfAborted(); this.assertConfig();
    const result = await this.request(this.identity().key, { method: "fs.stat", env: this.binding.environmentId, ...this.threadField(),
      path: workspacePath(file) }, options.signal);
    return result.stat as RunnerFileStat;
  }
  async check(environmentId: number): Promise<void> {
    this.environment(environmentId); this.assertConfig();
    await this.request(this.identity().key);
  }
  async allocateWorkspace(allocation: WorkspaceAllocation): Promise<RunnerWorkspace> {
    if (this.binding.threadId === this.installationBinding.threadId) return { threadId: this.binding.threadId, state: "available", kind: "copy", retained: true };
    const result = await this.request(this.identity().key, { method: "workspace.allocate.v2", threadId: this.binding.threadId, allocation });
    return result.workspace as RunnerWorkspace;
  }
  async releaseWorkspace(): Promise<RunnerWorkspace> {
    if (this.binding.threadId === this.installationBinding.threadId) return { threadId: this.binding.threadId, state: "released", kind: "copy", retained: true };
    const result = await this.request(this.identity().key, { method: "workspace.release", threadId: this.binding.threadId });
    return result.workspace as RunnerWorkspace;
  }
  /** Pi owns the durable intent. The runner owns deduplication and results.
   * Repeated dispatch uses exactly the same session-scoped identity; the runner
   * rejects changed arguments and never re-executes a retained operation,
   * including Interrupted. Runner journals do not evict operation identities. */
  async resumeExec(sessionId: string, invocationId: string, spec: RunnerExecSpec, signal?: AbortSignal, epoch?: number): Promise<RunnerExecResult & { operationId: string }> {
    signal?.throwIfAborted(); this.assertConfig();
    if (!sessionId || !invocationId) invalid();
    spec = validateSpec(spec);
    const operationId = `pi-${createHash("sha256").update(JSON.stringify([this.binding, sessionId, invocationId])).digest("hex")}`;
    // Unlike the legacy prepare/submit API, Pi has already committed the
    // intent. No second local operation journal or sent marker is necessary.
    await this.startOperation(operationId, spec, { epoch, signal });
    for (;;) {
      const state = await this.inspectOperation(operationId, { signal });
      if (state.state === "Succeeded") return { ...await this.collectOutput(operationId, state.result, signal), operationId };
      if (state.state === "Failed") throw new IrohNodeError(state.error, operationId, state.completionUnknown);
      if (state.state === "Interrupted" || state.state === "Unknown") throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true);
      if (state.state === "Written") throw new IrohNodeError("CONFLICT", operationId);
      await delay(100, undefined, { signal });
    }
  }
  async prepareExec(environmentId: number, spec: RunnerExecSpec, signal?: AbortSignal): Promise<{ operationId: string }> {
    this.environment(environmentId); signal?.throwIfAborted(); this.assertConfig();
    spec = validateSpec(spec);
    const { peer } = this.identity();
    const operationId = `op-${randomUUID()}`;
    const intent: Intent = { operationId, nodeId: this.nodeId, environmentId, threadId: this.binding.threadId, serverPeer: this.config.serverPeer, controlPeer: peer, spec };
    writeNew(this.intentPath(operationId), Buffer.from(JSON.stringify(intent)));
    return { operationId }; // durable intent, no network or remote acceptance yet
  }
  async submitExec(environmentId: number, operationId: string, signal?: AbortSignal): Promise<{ operationId: string }> {
    this.environment(environmentId); signal?.throwIfAborted(); this.assertConfig();
    const identity = this.identity();
    const intent = this.intent(operationId, identity.peer);
    try { writeNew(`${this.intentPath(operationId)}.sent`, Buffer.from("possibly delivered; reconcile operation.get; never remove to retry\n")); }
    catch { throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true); }
    await this.request(identity.key, { method: "exec.start", operationId, env: environmentId, spec: intent.spec }, signal);
    return { operationId };
  }
  async operation(environmentId: number, operationId: string, signal?: AbortSignal): Promise<RunnerOperation> {
    this.environment(environmentId); signal?.throwIfAborted(); this.assertConfig();
    const identity = this.identity();
    this.intent(operationId, identity.peer);
    return (await this.request(identity.key, { method: "operation.get", env: environmentId, operationId }, signal)).operation as RunnerOperation;
  }
  async exec(environmentId: number, spec: RunnerExecSpec, signal?: AbortSignal): Promise<RunnerExecResult & { operationId: string }> {
    this.environment(environmentId);
    spec = validateSpec(spec);
    const deadline = AbortSignal.timeout(spec.timeoutMs + 10000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const { operationId } = await this.prepareExec(environmentId, spec, combined);
    try { await this.submitExec(environmentId, operationId, combined); } // exactly once
    catch (error) {
      if (error instanceof IrohNodeError) throw new IrohNodeError(error.remoteCode, operationId, error.completionUnknown);
      throw Object.assign(new Error("command submission ended before dispatch"), { code: "ABORT_ERR", operationId, completionUnknown: false });
    }
    let terminalFailure: IrohNodeError | undefined;
    try {
      while (true) {
        const state = await this.operation(environmentId, operationId, combined);
        if (state.state === "Succeeded") return { ...await this.collectOutput(operationId, state.result, combined), operationId };
        if (state.state === "Failed") {
          terminalFailure = new IrohNodeError(state.error, operationId, state.completionUnknown);
          throw terminalFailure;
        }
        if (state.state !== "Accepted" && state.state !== "Running") throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true);
        await delay(100, undefined, { signal: combined });
      }
    } catch (error) {
      if (error === terminalFailure || (error instanceof IrohNodeError && error.completionUnknown)) throw error;
      throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true);
    }
  }
}
