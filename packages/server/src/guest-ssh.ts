/** How cubed reaches the guest helper (`cube-guest`) inside a thread's VM.
 *
 * One call is one helper request: a JSON header line plus an optional raw
 * body on stdin, a JSON header line plus an optional raw body on stdout. The
 * helper answers its own errors as `{error: {code, message}}`; anything else
 * (no answer, a broken connection, ssh's own exit status 255) is a transport
 * failure, and for a mutation its outcome is unknown.
 *
 * `SshGuestTransport` runs the system OpenSSH client through the gateway:
 * `ProxyCommand` is `cube-gateway dial`, which reaches the guest's sshd
 * inside the VM's LAN; nothing listens on the runner. Host keys are pinned
 * exactly (cubed generated them), and a ControlMaster per VM makes each call
 * a cheap channel on one connection. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GuestOp = "hello" | "exec" | "get" | "cancel" | "read" | "write" | "stat" | "services" | "install" | "portal";
export interface GuestAnswer { header: Record<string, unknown>; body: Buffer }
export interface GuestCallOptions { body?: Uint8Array; signal?: AbortSignal; timeoutMs?: number }

export interface GuestTransport {
  call(op: GuestOp, header: Record<string, unknown>, options?: GuestCallOptions): Promise<GuestAnswer>;
  /** Ends any persistent connection; later calls open a new one. */
  close(): Promise<void>;
}

/** The guest could not be reached or gave no answer. */
export class GuestTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuestTransportError";
  }
}

const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;

/** Request bytes for the helper. */
export function encodeGuestRequest(header: Record<string, unknown>, body?: Uint8Array): Buffer {
  const fields = body ? { ...header, length: body.length } : header;
  return Buffer.concat([Buffer.from(`${JSON.stringify(fields)}\n`), body ?? Buffer.alloc(0)]);
}

/** Parses the helper's answer; throws GuestTransportError when there is none. */
export function decodeGuestAnswer(stdout: Buffer): GuestAnswer {
  const end = stdout.indexOf(10);
  if (end < 0) throw new GuestTransportError("the guest helper gave no answer");
  let header: unknown;
  try { header = JSON.parse(stdout.subarray(0, end).toString("utf8")); }
  catch (cause) { throw new GuestTransportError("the guest helper answered something that is not JSON", { cause }); }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new GuestTransportError("the guest helper answer is not an object");
  return { header: header as Record<string, unknown>, body: stdout.subarray(end + 1) };
}

/** Runs one helper call as a child process: `argv` gets the request on stdin. */
export function runGuestProcess(argv: readonly string[], request: Buffer, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GuestAnswer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new GuestTransportError("guest call aborted")); return; }
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", abort);
      if (error) { reject(error); return; }
      const stdout = Buffer.concat(chunks);
      try {
        const answer = decodeGuestAnswer(stdout);
        resolve(answer);
      } catch (cause) {
        const status = exitCode === 255 ? "ssh could not reach the guest" : `exit status ${exitCode}`;
        reject(new GuestTransportError(`${status}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join("; ")}` : ""}`, { cause }));
      }
    };
    const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
    const abort = () => { kill(); finish(new GuestTransportError("guest call aborted")); };
    const timer = setTimeout(() => { kill(); finish(new GuestTransportError("the guest did not answer in time")); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let drain: NodeJS.Timeout | undefined;
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) { kill(); finish(new GuestTransportError("the guest answer is too large")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", error => finish(new GuestTransportError(`cannot start ${path.basename(argv[0])}: ${error.message}`, { cause: error })));
    child.on("exit", code => {
      exitCode = code;
      // A background ControlMaster may keep a copy of a pipe open; do not
      // wait for it forever once the client itself has exited.
      drain = setTimeout(() => finish(), 1000);
    });
    child.on("close", () => finish());
    child.stdin.on("error", () => {});
    child.stdin.end(request);
  });
}

/** ssh's `-o` value: whitespace-separated lists need quoting. */
function sshPath(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}
/** A ProxyCommand runs through /bin/sh and expands `%` tokens. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''").replace(/%/g, "%%")}'`;
}

/** A short directory for ControlMaster sockets (unix socket paths stay
 * under 104 bytes; ssh appends 17 characters while creating one). */
export function controlDirectory(preferred: string): string {
  const candidate = path.join(preferred, "ssh");
  const directory = Buffer.byteLength(path.join(candidate, "0".repeat(12))) + 17 < 100
    ? candidate : path.join(os.tmpdir(), `cubed-ssh-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

export interface SshGuestOptions {
  vmId: string;
  /** `id_ed25519` (client key) and `known_hosts` (the pinned host key). */
  keyDirectory: string;
  /** Where ControlMaster sockets live (see controlDirectory). */
  controlDirectory: string;
  /** cube-gateway binary and control socket, for `cube-gateway dial`. */
  gateway: { binary: string; control: string };
  ssh?: string;
}

export class SshGuestTransport implements GuestTransport {
  readonly vmId: string;
  private readonly options: SshGuestOptions;
  private readonly controlPath: string;

  constructor(options: SshGuestOptions) {
    if (!/^[0-9a-f]{16}$/.test(options.vmId)) throw new Error("invalid vm id");
    this.options = options;
    this.vmId = options.vmId;
    this.controlPath = path.join(options.controlDirectory, createHash("sha256").update(options.vmId).digest("hex").slice(0, 12));
  }

  /** The OpenSSH command line for one helper operation. */
  argv(op: GuestOp | null, extra: string[] = []): string[] {
    const { keyDirectory, gateway } = this.options;
    const proxy = [gateway.binary, "dial", "--control", gateway.control, "--vm", this.vmId, "--port", "22"].map(shellWord).join(" ");
    return [this.options.ssh ?? "ssh", "-F", "none",
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
      "-i", path.join(keyDirectory, "id_ed25519"),
      "-o", `UserKnownHostsFile=${sshPath(path.join(keyDirectory, "known_hosts"))}`, "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=cube-vm-${this.vmId}`,
      "-o", `ProxyCommand=${proxy}`,
      "-o", "ControlMaster=auto", "-o", `ControlPath=${sshPath(this.controlPath)}`, "-o", "ControlPersist=120",
      "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=20",
      "-o", "LogLevel=ERROR", ...extra, "root@cube-vm", ...(op ? [op] : [])];
  }

  async call(op: GuestOp, header: Record<string, unknown>, options: GuestCallOptions = {}): Promise<GuestAnswer> {
    return runGuestProcess(this.argv(op), encodeGuestRequest(header, options.body), {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir(), LANG: "C.UTF-8" },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /** Ends this VM's ControlMaster, if one runs. */
  async close(): Promise<void> {
    if (!fs.existsSync(this.controlPath)) return;
    const argv = this.argv(null, ["-O", "exit"]);
    await new Promise<void>(resolve => {
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
      child.on("error", () => { clearTimeout(timer); resolve(); });
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
