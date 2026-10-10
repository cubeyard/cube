/** cubed's client for runner protocol 4 (`cubeyard/runner/4`): one Iroh
 * connection per runner, one QUIC stream per call (packages/node-transport/
 * proto/runner.proto). A `RunnerSession` says hello on every new connection,
 * keeps one `watch` stream open (the runner and its machines, as the runner
 * reports them: cubed never polls a guest's hello for readiness), answers
 * `call`s and opens a `guest` stream per guest operation
 * (`RunnerGuestTransport`). */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { Endpoint, EndpointAddr, EndpointId, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { CallResultSchema, CallSchema, Code, HelloAnswerSchema, OpenSchema, StreamAnswerSchema, WatchEvent_Type, WatchEventSchema,
  type CallResult, type HelloAnswer, type Machine, type Runner } from "./gen/runner_pb.js";
import { decodeGuestAnswer, encodeGuestRequest, GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp,
  type GuestTransport } from "./guest-ssh.ts";

export const PROTOCOL = 4;
const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const MAX_FRAME = 1024 * 1024;
const MAX_GUEST_ANSWER = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 15000;
const GUEST_TIMEOUT_MS = 60000;
const PEER = /^[0-9a-f]{64}$/;
const NODE_ID = /^node-[a-zA-Z0-9-]{1,123}$/;

export type RunnerNetwork = "loopback" | "direct" | "relay";
/** A protocol-4 runner config: version 2 with `protocol: 4`, mode 0600.
 * `binding` is the registry's identity for the runner, as for protocol 3. */
export interface SessionConfig {
  version: 2; protocol: 4;
  binding: { nodeId: string; threadId: string; environmentId: number };
  controlKey: string; serverPeer: string; network: RunnerNetwork; address?: string;
}

/** A runner's refusal (`Error` in runner.proto), or no answer at all
 * (`UNAVAILABLE`, with `completionUnknown` when a request may have arrived). */
export class RunnerError extends Error {
  readonly code: keyof typeof Code;
  readonly reason: string;
  readonly completionUnknown: boolean;
  constructor(code: keyof typeof Code, reason: string, message: string, completionUnknown = false) {
    super(`${code}${reason ? `/${reason}` : ""}: ${message}`);
    this.name = "RunnerError";
    this.code = code;
    this.reason = reason;
    this.completionUnknown = completionUnknown;
  }
}

function unavailable(message: string, completionUnknown = false): RunnerError {
  return new RunnerError("UNAVAILABLE", "", message, completionUnknown);
}

/** Reads and checks a protocol-4 runner config; the same file always has the same hash. */
export function loadSessionConfig(filename: string): { config: SessionConfig; hash: string } {
  if (!path.isAbsolute(filename)) throw new Error("the runner config must be an absolute path");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error(`${filename} must be a private (0600) regular file`);
    bytes = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const raw = JSON.parse(bytes.toString("utf8")) as Partial<SessionConfig> & Record<string, unknown>;
  const allowed = new Set(["version", "protocol", "binding", "controlKey", "serverPeer", "network", "address"]);
  const binding = raw.binding;
  if (raw.version !== 2 || raw.protocol !== PROTOCOL || Object.keys(raw).some(key => !allowed.has(key))
    || !binding || typeof binding.nodeId !== "string" || !NODE_ID.test(binding.nodeId) || typeof binding.threadId !== "string"
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(binding.threadId) || !Number.isSafeInteger(binding.environmentId) || binding.environmentId < 1
    || typeof raw.controlKey !== "string" || !path.isAbsolute(raw.controlKey) || typeof raw.serverPeer !== "string" || !PEER.test(raw.serverPeer)
    || !["loopback", "direct", "relay"].includes(String(raw.network))
    || (raw.network === "relay" ? raw.address !== undefined : typeof raw.address !== "string")) {
    throw new Error(`${filename} is not a protocol-4 runner config ({"version":2,"protocol":4,"binding":{"nodeId","threadId","environmentId"},"controlKey","serverPeer","network","address"})`);
  }
  return { config: raw as SessionConfig, hash: createHash("sha256").update(bytes).digest("hex") };
}

/** u32 big-endian length, then the message as proto3 JSON. */
function frame<D extends DescMessage>(schema: D, value: MessageInitShape<D>): number[] {
  const payload = Buffer.from(toJsonString(schema, create(schema, value)));
  if (payload.length > MAX_FRAME) throw new Error("frame exceeds limit");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
}

async function readFrame(stream: BiStream): Promise<string> {
  const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
  if (length === 0 || length > MAX_FRAME) throw new Error("invalid frame length");
  return Buffer.from(await stream.recv.readExact(length)).toString("utf8");
}

function parse<D extends DescMessage>(schema: D, text: string): MessageShape<D> {
  return fromJsonString(schema, text, { ignoreUnknownFields: true });
}

/** An answer frame that is a `StreamAnswer` carrying an error. */
function refusal(text: string): RunnerError | null {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const answer = parse(StreamAnswerSchema, text);
  const error = answer.error;
  if (!error) return null;
  return new RunnerError((Code[error.code] ?? "CODE_UNSPECIFIED") as keyof typeof Code, error.reason, error.message, error.completionUnknown);
}

function within<T>(ms: number, work: Promise<T>, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A machine: its owner (a thread id) and its 16-hex id. */
export interface MachineRef { owner: string; id: string }
export function machineKey(ref: MachineRef): string { return `${ref.owner}/${ref.id}`; }

export class RunnerSession {
  readonly nodeId: string;
  readonly config: SessionConfig;
  /** The runner as it last described itself (hello, then watch). */
  runner: Runner | null = null;
  capabilities: string[] = [];
  /** The machines as the watch last reported them. */
  readonly machines = new Map<string, Machine>();
  private endpoint: Endpoint | null = null;
  private connection: Promise<Connection> | null = null;
  private watching = false;
  private closed = false;
  private readonly waiters = new Set<() => void>();
  private readonly cubedVersion: string;

  constructor(config: SessionConfig, options: { cubedVersion?: string } = {}) {
    this.config = config;
    this.nodeId = config.binding.nodeId;
    this.cubedVersion = options.cubedVersion ?? "";
  }

  /** The connection, after a hello on it; a new one when the last closed. */
  private connect(): Promise<Connection> {
    if (this.closed) return Promise.reject(unavailable("the runner session is closed"));
    if (this.connection) return this.connection;
    const attempt = within(CONNECT_TIMEOUT_MS, this.open(), () => unavailable(`runner ${this.nodeId} does not answer`));
    this.connection = attempt;
    attempt.then(connection => {
      void connection.closed().catch(() => "").then(() => { if (this.connection === attempt) this.connection = null; });
      this.watch(attempt);
    }, () => { if (this.connection === attempt) this.connection = null; });
    return attempt;
  }

  private async open(): Promise<Connection> {
    if (!this.endpoint) {
      const builder = Endpoint.builder();
      if (this.config.network === "relay") builder.applyN0();
      else builder.applyMinimal();
      const bytes = fs.readFileSync(this.config.controlKey);
      if (bytes.length !== 32) throw new Error("the control key must be 32 bytes");
      builder.secretKey(SecretKey.fromBytes(Array.from(bytes)).toBytes());
      bytes.fill(0);
      builder.alpns([]);
      if (this.config.network === "loopback") { builder.bindAddr("127.0.0.1:0"); builder.bindAddr("[::1]:0"); }
      this.endpoint = await builder.bind();
    }
    const peer = EndpointId.fromBytes(Array.from(Buffer.from(this.config.serverPeer, "hex")));
    const address = this.config.network === "relay" ? new EndpointAddr(peer) : new EndpointAddr(peer, null, [this.config.address!]);
    let connection: Connection;
    try { connection = await this.endpoint.connect(address, ALPN); }
    catch (error) { throw unavailable(`runner ${this.nodeId} does not answer: ${error instanceof Error ? error.message : String(error)}`); }
    if (!connection.remoteId().equals(peer)) { connection.close(0n, []); throw new RunnerError("PERMISSION_DENIED", "wrong_node", "the runner's key changed"); }
    try {
      const stream = await connection.openBi();
      await stream.send.writeAll(frame(OpenSchema, { kind: { case: "hello", value: { protocol: PROTOCOL, expectNode: this.nodeId, cubedVersion: this.cubedVersion } } }));
      await stream.send.finish();
      const text = await readFrame(stream);
      const refused = refusal(text);
      if (refused) throw refused;
      const hello = parse(HelloAnswerSchema, text);
      if (hello.protocol !== PROTOCOL || hello.runner?.nodeId !== this.nodeId) {
        throw new RunnerError("FAILED_PRECONDITION", "incompatible_protocol", `runner ${this.nodeId} answered as ${hello.runner?.nodeId ?? "nobody"} on protocol ${hello.protocol}`);
      }
      this.runner = hello.runner;
      this.capabilities = [...hello.capabilities];
      this.notify();
      return connection;
    } catch (error) {
      connection.close(0n, []);
      if (error instanceof RunnerError) throw error;
      throw unavailable(`runner ${this.nodeId} did not say hello: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The runner, from a fresh hello when none was said yet. */
  async hello(): Promise<HelloAnswer> {
    await this.connect();
    return create(HelloAnswerSchema, { protocol: PROTOCOL, capabilities: this.capabilities, runner: this.runner! });
  }

  /** One verb; a refusal throws `RunnerError`. */
  async call(verb: NonNullable<MessageInitShape<typeof CallSchema>["verb"]>, timeoutMs = CALL_TIMEOUT_MS): Promise<Exclude<CallResult["result"], { case: "error" } | { case: undefined }>> {
    const connection = await this.connect();
    let sent = false;
    const work = (async () => {
      const stream = await connection.openBi();
      sent = true;
      await stream.send.writeAll(frame(OpenSchema, { kind: { case: "call", value: create(CallSchema, { verb }) } }));
      await stream.send.finish();
      return parse(CallResultSchema, await readFrame(stream));
    })();
    let answer: CallResult;
    try { answer = await within(timeoutMs, work, () => unavailable(`runner ${this.nodeId} did not answer ${verb.case}`, true)); }
    catch (error) {
      if (error instanceof RunnerError) throw error;
      throw unavailable(`runner ${this.nodeId}: ${verb.case} failed: ${error instanceof Error ? error.message : String(error)}`, sent);
    }
    const result = answer.result;
    if (result.case === "error") {
      throw new RunnerError((Code[result.value.code] ?? "CODE_UNSPECIFIED") as keyof typeof Code, result.value.reason, result.value.message, result.value.completionUnknown);
    }
    if (result.case === undefined) throw unavailable(`runner ${this.nodeId} gave an empty answer to ${verb.case}`);
    if (result.case === "machine") this.remember(result.value);
    return result;
  }

  /** A verb that answers with the machine. */
  async machine(verb: NonNullable<MessageInitShape<typeof CallSchema>["verb"]>): Promise<Machine> {
    const result = await this.call(verb);
    if (result.case !== "machine") throw unavailable(`runner ${this.nodeId} answered ${result.case} to ${verb.case}`);
    return result.value;
  }

  /** Waits until the watch reports `ref` as `predicate` wants it. */
  async until(ref: MachineRef, predicate: (machine: Machine) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<Machine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.connect();
      const current = this.machines.get(machineKey(ref));
      if (current && predicate(current)) return current;
      if (signal?.aborted) throw new Error("aborted");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`runner ${this.nodeId}: machine ${ref.id} did not reach the expected state in ${Math.round(timeoutMs / 1000)} s`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(left, 5000));
        function done() { clearTimeout(timer); resolve(); }
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private notify(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  private remember(machine: Machine): void {
    if (!machine.ref) return;
    const key = machineKey(machine.ref);
    const known = this.machines.get(key);
    if (!known || (known.meta?.version ?? 0n) <= (machine.meta?.version ?? 0n)) this.machines.set(key, machine);
    this.notify();
  }

  /** One watch per connection: the runner sends everything after a RESET,
   * then each change. It ends with its connection. */
  private watch(connected: Promise<Connection>): void {
    if (this.watching) return;
    this.watching = true;
    void (async () => {
      try {
        const connection = await connected;
        const stream = await connection.openBi();
        await stream.send.writeAll(frame(OpenSchema, { kind: { case: "watch", value: { sinceVersion: 0n } } }));
        await stream.send.finish();
        for (;;) {
          const event = parse(WatchEventSchema, await readFrame(stream));
          if (event.type === WatchEvent_Type.RESET) continue;
          if (event.resource.case === "machine") {
            if (event.type === WatchEvent_Type.DELETE && event.resource.value.ref) this.machines.delete(machineKey(event.resource.value.ref));
            else this.remember(event.resource.value);
          } else if (event.resource.case === "runner") { this.runner = event.resource.value; this.notify(); }
        }
      } catch { /* the connection ended; the next call reconnects and watches again */ }
      finally { this.watching = false; this.notify(); }
    })();
  }

  /** The guest helper of machine `ref`, fenced by `fence()` at each call. */
  guest(ref: MachineRef, fence: () => number): RunnerGuestTransport {
    return new RunnerGuestTransport(this, ref, fence);
  }

  /** @internal One guest stream (RunnerGuestTransport). */
  async guestCall(ref: MachineRef, epoch: number, op: GuestOp, request: Buffer, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<GuestAnswer> {
    let connection: Connection;
    try { connection = await this.connect(); }
    catch (error) { throw new GuestTransportError(error instanceof Error ? error.message : String(error), { cause: error }); }
    let stream: BiStream | undefined;
    const work = (async () => {
      stream = await connection.openBi();
      await stream.send.writeAll(frame(OpenSchema, { kind: { case: "guest", value: { ref: { owner: ref.owner, id: ref.id }, fence: { epoch: BigInt(epoch) }, op } } }));
      await stream.send.writeAll(Array.from(request));
      await stream.send.finish();
      const refused = refusal(await readFrame(stream));
      if (refused) throw new GuestTransportError(`runner ${this.nodeId}: ${refused.message}`, { cause: refused });
      const bytes = Buffer.from(await stream.recv.readToEnd(MAX_GUEST_ANSWER));
      return decodeGuestAnswer(bytes);
    })();
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new GuestTransportError("guest call aborted"));
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await within(options.timeoutMs ?? GUEST_TIMEOUT_MS, Promise.race([work, aborted]), () => new GuestTransportError("the guest did not answer in time"));
    } catch (error) {
      // The runner lets the operation finish; only this answer is dropped.
      void stream?.recv.stop(0n).catch(() => {});
      work.catch(() => {});
      if (error instanceof GuestTransportError) throw error;
      throw new GuestTransportError(`runner ${this.nodeId}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { options.signal?.removeEventListener("abort", onAbort); }
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = await this.connection?.catch(() => null);
    connection?.close(0n, []);
    this.connection = null;
    await this.endpoint?.close();
    this.endpoint = null;
    this.notify();
  }
}

/** `GuestTransport` over a runner's `guest` stream: the same request and
 * answer bytes `cube-guest call OP` reads and writes. A runner refusal or a
 * lost stream is a transport failure, as an ssh failure is for protocol 3. */
export class RunnerGuestTransport implements GuestTransport {
  readonly ref: MachineRef;
  private readonly session: RunnerSession;
  private readonly fence: () => number;
  constructor(session: RunnerSession, ref: MachineRef, fence: () => number) {
    this.session = session;
    this.ref = ref;
    this.fence = fence;
  }
  call(op: GuestOp, header: Record<string, unknown>, options: GuestCallOptions = {}): Promise<GuestAnswer> {
    return this.session.guestCall(this.ref, this.fence(), op, encodeGuestRequest(header, options.body),
      { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  }
  async close(): Promise<void> {}
}

const sessions = new Map<string, RunnerSession>();
/** This process's one session per runner admission: one connection and one
 * Iroh identity per runner. */
export function runnerSession(admission: { configPath: string; configHash: string }, options: { cubedVersion?: string } = {}): RunnerSession {
  const key = `${admission.configPath}\0${admission.configHash}`;
  let session = sessions.get(key);
  if (!session) {
    const { config, hash } = loadSessionConfig(admission.configPath);
    if (hash !== admission.configHash) throw new RunnerError("FAILED_PRECONDITION", "config_changed", `${admission.configPath} changed since the runner was enrolled`);
    session = new RunnerSession(config, options);
    sessions.set(key, session);
  }
  return session;
}

export async function closeRunnerSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(open.map(session => session.close()));
}
