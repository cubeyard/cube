/** cubed's client for runner protocol 4 (`cubeyard/runner/4`): one Iroh
 * connection per runner, one QUIC stream per call (packages/node-transport/
 * proto/runner.proto). A `RunnerSession` says hello on every new connection,
 * keeps one `watch` stream open (the runner and its machines, as the runner
 * reports them: cubed never polls a guest's hello for readiness), answers
 * `call`s and opens a `guest` stream per guest operation
 * (`RunnerGuestTransport`) and a `dial` stream per connection to a port of
 * a machine (the portal's, masterplan B-6). It also takes the streams the runner opens on
 * the connection: `credential` (runner-credentials.ts) and `report`, whose
 * refusals it logs; it never answers a report. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { Endpoint, EndpointAddr, EndpointId, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { CallResultSchema, CallSchema, Code, EgressReportSchema, HelloAnswerSchema, OpenSchema, StreamAnswerSchema, WatchEvent_Type, WatchEventSchema,
  type CallResult, type HelloAnswer, type Machine, type Runner } from "./gen/runner_pb.js";
import { carryCredential, MAX_CREDENTIAL_HEADER, type CredentialRoute } from "./runner-credentials.ts";
import { createLogger, type Logger } from "./log.ts";
import { decodeGuestAnswer, encodeGuestRequest, GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp,
  type GuestTransport } from "./guest-ssh.ts";

export const PROTOCOL = 4;
const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const MAX_FRAME = 1024 * 1024;
const MAX_GUEST_ANSWER = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 15000;
/** `machine_stop` and `machine_delete` (which stops first): berth vm gives
 * the agent 30 s to shut down (SHUTDOWN_WAIT), then QEMU 20 s to quit
 * (QUIT_TIMEOUT) before it kills it, and a delete then removes the
 * directory; about 50 s at worst before the answer. 45 s covered only the
 * common path (masterplan R14). */
export const STOP_TIMEOUT_MS = 15000;
/** A call's deadline: the stopping verbs wait for the runner's whole stop. */
export function callTimeout(verb: string | undefined): number {
  return verb === "machineStop" || verb === "machineDelete" ? STOP_TIMEOUT_MS : CALL_TIMEOUT_MS;
}
const GUEST_TIMEOUT_MS = 60000;
/** Bytes per read from a dial stream (the binding copies each into an array). */
const DIAL_READ_BYTES = 256 * 1024;
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

/** The route of runners' credential streams for sessions not given one
 * (cubed's own, set at its start); none: every such stream is refused. */
let defaultCredentials: CredentialRoute | null = null;
export function routeCredentials(route: CredentialRoute | null): void { defaultCredentials = route; }

export interface SessionOptions {
  cubedVersion?: string;
  /** Where this session's runner's credential streams go (default: `routeCredentials`). */
  credentials?: CredentialRoute;
  /** The registry's identity of the runner (`runnerSession` sets it). */
  admission?: { configPath: string; configHash: string };
  log?: Logger;
}

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
  private readonly options: SessionOptions;
  private readonly log: Logger;

  constructor(config: SessionConfig, options: SessionOptions = {}) {
    this.config = config;
    this.nodeId = config.binding.nodeId;
    this.cubedVersion = options.cubedVersion ?? "";
    this.options = options;
    this.log = options.log ?? createLogger("runner-session");
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
      this.accept(connection);
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
      // A new connection, perhaps to a restarted runner whose versions began
      // again (berth keeps them in memory): its watch reports every machine.
      this.machines.clear();
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
  async call(verb: NonNullable<MessageInitShape<typeof CallSchema>["verb"]>, timeoutMs = callTimeout(verb.case)): Promise<Exclude<CallResult["result"], { case: "error" } | { case: undefined }>> {
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
          // Every machine follows as PUT: the view starts again.
          if (event.type === WatchEvent_Type.RESET) { this.machines.clear(); continue; }
          if (event.resource.case === "machine") {
            if (event.type === WatchEvent_Type.DELETE && event.resource.value.ref) this.machines.delete(machineKey(event.resource.value.ref));
            else this.remember(event.resource.value);
          } else if (event.resource.case === "runner") { this.runner = event.resource.value; this.notify(); }
        }
      } catch { /* the connection ended; the next call reconnects and watches again */ }
      finally { this.watching = false; this.notify(); }
    })();
  }

  /** The streams the runner opens on `connection`, until it ends. */
  private accept(connection: Connection): void {
    void (async () => {
      for (;;) {
        let stream: BiStream;
        try { stream = await connection.acceptBi(); } catch { return; }
        void this.runnerStream(stream).catch(error => this.log.warn("runner stream failed", { runner: this.nodeId, error }));
      }
    })();
  }

  private async runnerStream(stream: BiStream): Promise<void> {
    const text = await readFrame(stream);
    const opened = parse(OpenSchema, text);
    const kind = opened.kind;
    if (kind.case === "report") {
      // Refusals for diagnosis (C phase); read so they do not pile up.
      for (;;) {
        let report;
        try { report = parse(EgressReportSchema, await readFrame(stream)); } catch { return; }
        this.log.info("egress refused", { runner: this.nodeId, thread: report.ref?.owner, vm: report.ref?.id, host: report.host,
          reason: report.reason, droppedBefore: report.droppedBefore ? Number(report.droppedBefore) : undefined });
      }
    }
    if (kind.case === "credential") {
      if (Buffer.byteLength(text) > MAX_CREDENTIAL_HEADER) {
        await stream.send.writeAll(frame(StreamAnswerSchema, { error: { code: Code.INVALID_ARGUMENT, reason: "size", message: "a credential header is at most 64 KiB" } }));
        await stream.send.finish();
        return;
      }
      const header = kind.value;
      const carried = await carryCredential(stream, header, this.options.credentials ?? defaultCredentials,
        { nodeId: this.nodeId, admission: this.options.admission ?? null });
      const fields = { runner: this.nodeId, thread: header.ref?.owner, vm: header.ref?.id, host: header.host, credential: header.credential };
      if (carried.refused) this.log.info("credential request refused", { ...fields, reason: carried.refused.reason, message: carried.refused.message });
      else this.log.debug("credential request carried", { ...fields, up: carried.up, down: carried.down, error: carried.error ?? undefined });
      return;
    }
    await stream.send.writeAll(frame(StreamAnswerSchema, { error: { code: Code.INVALID_ARGUMENT, reason: "open", message: `a runner does not open ${kind.case ?? "unknown"} streams` } }));
    await stream.send.finish();
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

  /** A TCP connection to `port` of machine `ref` at fence `epoch`: a `dial`
   * stream, then, after the runner's `StreamAnswer`, its bytes. A refusal
   * throws `RunnerError`. The runner allows ports 1024 to 65535 of a running
   * machine and gives the guest 10 s to answer. */
  async dial(ref: MachineRef, epoch: number, port: number): Promise<Duplex> {
    const connection = await this.connect();
    let stream: BiStream | undefined;
    const work = (async () => {
      stream = await connection.openBi();
      await stream.send.writeAll(frame(OpenSchema, { kind: { case: "dial", value: { ref: { owner: ref.owner, id: ref.id }, fence: { epoch: BigInt(epoch) }, port } } }));
      const refused = refusal(await readFrame(stream));
      if (refused) { await stream.send.finish().catch(() => {}); throw refused; }
      return dialStream(stream);
    })();
    try { return await within(CALL_TIMEOUT_MS, work, () => unavailable(`runner ${this.nodeId} did not answer a dial to port ${port}`)); }
    catch (error) {
      work.then(socket => socket.destroy(), () => {});
      if (!(error instanceof RunnerError)) void stream?.send.reset(0n).catch(() => {});
      if (error instanceof RunnerError) throw error;
      throw unavailable(`runner ${this.nodeId}: dial failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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

/** A dial stream's bytes as a Duplex. Each direction ends on its own:
 * `end()` finishes the stream (the runner passes the FIN to the guest) and
 * the guest's FIN ends reading. `destroy()` without an error acts as
 * net.Socket's `destroySoon()`, a socket's close: reading stops
 * (STOP_SENDING, so the runner drops the guest's connection if the guest
 * goes on sending), and an open writable side first ends, so every write
 * it accepted goes, in order, then FIN. `destroy(error)` resets the
 * stream. A lost connection is an error, never an end. */
function dialStream(stream: BiStream): Duplex { return new DialStream(stream); }

class DialStream extends Duplex {
  private readonly stream: BiStream;
  private reading = false;
  private closing = false;
  constructor(stream: BiStream) {
    super({ allowHalfOpen: true });
    this.stream = stream;
  }
  override _read(): void {
    if (this.reading) return;
    this.reading = true;
    this.stream.recv.read(DIAL_READ_BYTES).then(chunk => {
      this.reading = false;
      this.push(chunk.length ? Buffer.from(chunk) : null);
    }, error => this.destroy(error instanceof Error ? error : new Error(String(error))));
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.stream.send.writeAll(Array.from(chunk)).then(() => callback(), callback);
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.stream.send.finish().then(() => callback(), callback);
  }
  override destroy(error?: Error): this {
    if (error || this.destroyed || this.writableFinished) return super.destroy(error);
    if (!this.readableEnded) void this.stream.recv.stop(0n).catch(() => {});
    if (!this.closing) {
      this.closing = true;
      // A write that fails destroys with its error (a reset) instead.
      this.once("finish", () => super.destroy());
      if (!this.writableEnded) this.end();
    }
    return this;
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.writableFinished) void this.stream.send.reset(0n).catch(() => {});
    if (!this.readableEnded) void this.stream.recv.stop(0n).catch(() => {});
    callback(error);
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
    session = new RunnerSession(config, { ...options, admission: { configPath: admission.configPath, configHash: admission.configHash } });
    sessions.set(key, session);
  }
  return session;
}

export async function closeRunnerSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(open.map(session => session.close()));
}
