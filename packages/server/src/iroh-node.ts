/** Direct in-process iroh client. No subprocess, stdio bridge, local execution
 * fallback or automatic command resubmission. Config/keys/intents stay on the
 * control plane; production enrollment/tool routing is separate integration. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";
// The 1.1.0 tarball publishes index.js/index.d.ts at its root, while its
// manifest incorrectly points at iroh-js/. Pin and use the published subpath.
import { Endpoint, EndpointAddr, EndpointId, SecretKey, type Connection, type BiStream } from "@number0/iroh/index.js";
import { ExecutionNodeError, type ExecutionNodeClient, type EnvironmentObservation, type NodeContact, type NodeErrorCode } from "./execution-node-contract.ts";

const MAX_FRAME = 65536;
const RPC_TIMEOUT_MS = 5000;
const ALPN = Array.from(Buffer.from("cubeyard/node/1"));
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NODE_ID = /^node-[a-zA-Z0-9-]{1,123}$/;
const PEER = /^[0-9a-f]{64}$/;
const CODES = new Set(["NODE_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNSUPPORTED", "UNAUTHORIZED", "WRONG_NODE", "INVALID_REQUEST", "CONFLICT", "CAPACITY_EXCEEDED", "ENVIRONMENT_MISSING", "ENVIRONMENT_STOPPED", "IO_ERROR"]);
export interface NodeBinding { nodeId: string; environmentId: number; threadId: string }
export interface HostExecSpec { command: string; guestCwd: string; timeoutMs: number; outputLimit: number }
export interface HostExecResult {
  exitCode: number | null;
  termination: "exited" | "signalled" | "timedOut";
  output: number[];
  outputBytes: number;
  truncated: boolean;
}
export type HostOperation =
  | { state: "Accepted" | "Running" | "Unknown" }
  | { state: "Succeeded"; result: HostExecResult }
  | { state: "Failed"; error: string; completionUnknown: boolean }
  | { state: "Interrupted"; completionUnknown: true };
interface IrohConfig {
  version: 1; binding: NodeBinding; controlKey: string; serverPeer: string;
  address: string; network: "loopback" | "direct"; intentDirectory: string;
}
interface Intent {
  operationId: string; nodeId: string; environmentId: number; threadId: string;
  serverPeer: string; controlPeer: string; spec: HostExecSpec;
}

export class IrohNodeError extends ExecutionNodeError {
  readonly operationId?: string;
  readonly remoteCode: string;
  constructor(remoteCode: string, operationId?: string, completionUnknown = false) {
    const code: NodeErrorCode = completionUnknown || remoteCode === "OUTCOME_UNKNOWN" ? "COMPLETION_UNKNOWN"
      : remoteCode === "UNSUPPORTED" ? "OPERATION_UNSUPPORTED"
      : remoteCode === "UNAUTHORIZED" ? "WRONG_NODE"
      : remoteCode === "ENVIRONMENT_STOPPED" ? "OPERATION_UNSUPPORTED"
      : remoteCode as NodeErrorCode;
    super(code);
    this.operationId = operationId;
    this.remoteCode = remoteCode;
    this.message = `${code}${operationId ? `: operation ${operationId}` : ""}${this.completionUnknown ? "; inspect the saved operation before executing again; remote work was not cancelled" : ""}`;
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
function validateSpec(spec: HostExecSpec): HostExecSpec {
  const row = shape(spec, ["command", "guestCwd", "timeoutMs", "outputLimit"]);
  if (typeof row.command !== "string" || !row.command || row.command.includes("\0") || Buffer.byteLength(row.command) > 8192
    || typeof row.guestCwd !== "string" || !row.guestCwd || row.guestCwd.includes("\0") || path.posix.isAbsolute(row.guestCwd) || Buffer.byteLength(row.guestCwd) > 4096
    || !integer(row.timeoutMs, 1, 60000) || !integer(row.outputLimit, 0, 8192)) invalid();
  return { command: row.command, guestCwd: row.guestCwd, timeoutMs: row.timeoutMs, outputLimit: row.outputLimit };
}
function operation(value: unknown): HostOperation {
  const row = record(value);
  switch (row.state) {
    case "Accepted": case "Running": case "Unknown": shape(row, ["state"]); return { state: row.state };
    case "Interrupted":
      shape(row, ["state", "completionUnknown"]);
      if (row.completionUnknown !== true) invalid();
      return { state: "Interrupted", completionUnknown: true };
    case "Failed":
      shape(row, ["state", "error", "completionUnknown"]);
      if (row.error !== "IO_ERROR" || typeof row.completionUnknown !== "boolean") invalid();
      return { state: "Failed", error: row.error, completionUnknown: row.completionUnknown };
    case "Succeeded": {
      shape(row, ["state", "result"]);
      const result = shape(row.result, ["exitCode", "termination", "output", "outputBytes", "truncated"]);
      if (!(result.exitCode === null || integer(result.exitCode, 0, 255))
        || !["exited", "signalled", "timedOut"].includes(String(result.termination))
        || !Array.isArray(result.output) || result.output.length > 8192 || !result.output.every(b => integer(b, 0, 255))
        || !integer(result.outputBytes, result.output.length) || typeof result.truncated !== "boolean"
        || (result.termination === "exited") !== (result.exitCode !== null)
        || (!result.truncated && result.outputBytes !== result.output.length)) invalid();
      return { state: "Succeeded", result: result as unknown as HostExecResult };
    }
    default: return invalid();
  }
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
function loadConfig(filename: string): { config: IrohConfig; hash: string } {
  const bytes = readPrivate(filename, 16384);
  const row = shape(json(bytes), ["version", "binding", "controlKey", "serverPeer", "address", "network", "intentDirectory"]);
  if (row.version !== 1 || typeof row.serverPeer !== "string" || !PEER.test(row.serverPeer)
    || typeof row.controlKey !== "string" || !path.isAbsolute(row.controlKey)
    || typeof row.intentDirectory !== "string" || !path.isAbsolute(row.intentDirectory)
    || !["loopback", "direct"].includes(String(row.network)) || typeof row.address !== "string") invalid();
  try { EndpointId.fromBytes(Array.from(Buffer.from(row.serverPeer, "hex"))); } catch { invalid(); }
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(row.address);
  if (!match || !isIP(match[1] ?? match[2]) || !integer(Number(match[3]), 1, 65535)) invalid();
  const host = match[1] ?? match[2];
  let loopback: boolean;
  if (isIP(host) === 4) {
    const first = Number(host.split(".")[0]);
    if (host === "0.0.0.0" || host === "255.255.255.255" || (first >= 224 && first <= 239)) invalid();
    loopback = first === 127;
  } else {
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    // No scoped or mapped addresses: use a plain IPv4 or unicast IPv6 literal.
    if (normalized === "::" || normalized.startsWith("ff") || normalized.startsWith("::ffff:")) invalid();
    loopback = normalized === "::1";
  }
  if (row.network === "loopback" && !loopback) invalid();
  return { config: { version: 1, binding: binding(row.binding), controlKey: row.controlKey, serverPeer: row.serverPeer,
    address: row.address, network: row.network as IrohConfig["network"], intentDirectory: row.intentDirectory },
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
  return new IrohNodeError(result.code, id, result.completionUnknown);
}

export class IrohExecutionNodeClient implements ExecutionNodeClient {
  readonly locality = "remote" as const;
  readonly nodeId: string;
  readonly binding: Readonly<NodeBinding>;
  contact: NodeContact = "unobserved";
  private readonly config: IrohConfig;
  private readonly configPath: string;
  readonly configHash: string;
  private readonly observe?: (environmentId: number, observation: EnvironmentObservation) => void;

  constructor(options: { configPath: string; configHash?: string; observe?: (environmentId: number, observation: EnvironmentObservation) => void }) {
    shape(options, ["configPath"], ["configHash", "observe"]);
    const { config, hash } = loadConfig(options.configPath);
    if (options.configHash !== undefined && options.configHash !== hash) throw new IrohNodeError("CONFLICT");
    this.binding = Object.freeze({ ...config.binding });
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
      serverPeer: this.config.serverPeer, controlPeer, spec: validateSpec(value.spec as HostExecSpec) };
  }
  private hello(value: unknown): Record<string, unknown> {
    const hello = shape(value, ["type", "nodeId", "protocolVersion", "profiles", "capabilities", "limits"], ["binding"]);
    if (hello.type !== "Hello" || hello.protocolVersion !== 1 || hello.nodeId !== this.nodeId
      || hello.binding === undefined || !equalBinding(binding(hello.binding), this.binding)) throw new IrohNodeError("WRONG_NODE");
    if (!Array.isArray(hello.profiles) || !hello.profiles.includes("host") || !hello.profiles.every(x => typeof x === "string")
      || !Array.isArray(hello.capabilities) || !hello.capabilities.every(x => typeof x === "string")) invalid();
    const limits = shape(hello.limits, ["maxFrameBytes", "requestTimeoutMs"]);
    if (limits.maxFrameBytes !== MAX_FRAME || !integer(limits.requestTimeoutMs, 1, RPC_TIMEOUT_MS)) invalid();
    return hello;
  }
  /** A native endpoint per RPC, in THIS process. Owning it per call lets a
   * deadline close pending connect/read operations without disrupting siblings.
   * Late bind/connect completions are closed too; no background retry task. */
  private async request(key: SecretKey, query?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    this.assertConfig();
    const id = typeof query?.operationId === "string" ? query.operationId : undefined;
    const mutating = query?.method === "exec.start";
    const requestBytes = query ? frame(query) : undefined;
    const builder = Endpoint.builder();
    builder.applyMinimal(); // no n0 relay or address lookup; see npm NAT caveat in HOST.md
    builder.secretKey(key.toBytes());
    builder.alpns([]); // caller endpoint has no server-side application protocols
    if (this.config.network === "loopback") {
      // Each bind replaces that family's wildcard default in @number0/iroh.
      // Both must be explicit: the binding does not expose clearIpTransports().
      builder.bindAddr("127.0.0.1:0");
      builder.bindAddr("[::1]:0");
    }
    const peer = EndpointId.fromBytes(Array.from(Buffer.from(this.config.serverPeer, "hex")));
    const address = new EndpointAddr(peer, null, [this.config.address]);
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
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    const work = async () => {
      endpoint = await builder.bind();
      if (finished || combined.aborted) { close(); throw new Error("request ended before bind"); }
      connection = await endpoint.connect(address, ALPN);
      if (finished || combined.aborted) { close(); throw new Error("request ended before connect"); }
      if (!connection.remoteId().equals(peer)) throw new IrohNodeError("WRONG_NODE", id);
      let stream = await connection.openBi();
      await stream.send.writeAll(frame({ method: "node.hello", protocolVersion: 1 }));
      await stream.send.finish();
      const response = await readFrame(stream);
      const error = remoteError(response);
      if (error) throw error;
      const hello = this.hello(response); // full immutable thread/env/node binding
      if (!query) return hello;
      if (!(hello.capabilities as string[]).includes(query.method as string)) throw new IrohNodeError("UNSUPPORTED", id);
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
        case "environment.inspect":
          shape(result, ["type", "binding", "state"]);
          if (result.type !== "Environment" || result.state !== "ready" || !equalBinding(binding(result.binding), this.binding)) invalid();
          break;
        case "exec.start":
          shape(result, ["type", "operationId"]);
          if (result.type !== "Accepted" || result.operationId !== id) invalid();
          break;
        case "operation.get":
          shape(result, ["type", "operationId", "operation"]);
          if (result.type !== "Operation" || result.operationId !== id) invalid();
          result.operation = operation(result.operation);
          break;
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
    await this.request(this.identity().key, { method: "environment.inspect", env: environmentId });
    const observation = { status: "Running", observedAt: Date.now() };
    this.observe?.(environmentId, observation);
    return observation;
  }
  async check(environmentId: number): Promise<void> {
    this.environment(environmentId); this.assertConfig();
    await this.request(this.identity().key);
  }
  async wake(environmentId: number): Promise<void> { this.environment(environmentId); throw new IrohNodeError("UNSUPPORTED"); }
  async sleep(environmentId: number): Promise<void> { this.environment(environmentId); throw new IrohNodeError("UNSUPPORTED"); }
  async openPortal(environmentId: number, _port: number): Promise<Duplex> { this.environment(environmentId); throw new IrohNodeError("UNSUPPORTED"); }
  async prepareExec(environmentId: number, spec: HostExecSpec, signal?: AbortSignal): Promise<{ operationId: string }> {
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
  async operation(environmentId: number, operationId: string, signal?: AbortSignal): Promise<HostOperation> {
    this.environment(environmentId); signal?.throwIfAborted(); this.assertConfig();
    const identity = this.identity();
    this.intent(operationId, identity.peer);
    return (await this.request(identity.key, { method: "operation.get", env: environmentId, operationId }, signal)).operation as HostOperation;
  }
  async exec(environmentId: number, spec: HostExecSpec, signal?: AbortSignal): Promise<HostExecResult & { operationId: string }> {
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
        if (state.state === "Succeeded") return { ...state.result, operationId };
        if (state.state === "Failed") {
          terminalFailure = new IrohNodeError(state.error, operationId, state.completionUnknown);
          throw terminalFailure;
        }
        if (state.state === "Interrupted" || state.state === "Unknown") throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true);
        await delay(100, undefined, { signal: combined });
      }
    } catch (error) {
      if (error === terminalFailure || (error instanceof IrohNodeError && error.completionUnknown)) throw error;
      throw new IrohNodeError("OUTCOME_UNKNOWN", operationId, true);
    }
  }
}
