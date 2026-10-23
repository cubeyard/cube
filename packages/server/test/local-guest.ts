/** Test only: the real guest helper (packages/server/guest/cube-guest.py)
 * under a temporary root, with a process launcher instead of systemd
 * (local-guest.py). It stands in for a thread machine's guest; the same
 * helper runs on a real `berth host` in runner-host-test.ts, and keel's
 * cube-agent keeps its contract (keel-agent-contract-test.ts). Not runner
 * acceptance. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { decodeGuestAnswer, encodeGuestRequest, GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp,
  type GuestTransport } from "../src/guest-transport.ts";
import { clean } from "../src/vm-diagnostics.ts";
import { readStartupLog, type StartOptions, type StartupLog, type ThreadMachines } from "../src/vm.ts";
import type { Thread } from "../src/registry.ts";
import { hookFileContent } from "../src/vm-seed.ts";

const LAUNCHER = path.join(import.meta.dirname, "local-guest.py");
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/** Runs one helper call as a child process: `argv` gets the request on stdin. */
function runGuestProcess(argv: readonly string[], request: Buffer, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GuestAnswer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new GuestTransportError("guest call aborted")); return; }
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) { reject(error); return; }
      try { resolve(decodeGuestAnswer(Buffer.concat(chunks))); }
      catch (cause) {
        const status = exitCode === 255 ? "the guest could not be reached" : `exit status ${exitCode}`;
        const said = clean(stderr).trim().split("\n").slice(-2).join("; ").slice(0, 512);
        reject(new GuestTransportError(`${status}${said ? `: ${said}` : ""}`, { cause }));
      }
    };
    const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
    const abort = () => { kill(); finish(new GuestTransportError("guest call aborted")); };
    const timer = setTimeout(() => { kill(); finish(new GuestTransportError("the guest did not answer in time")); }, options.timeoutMs ?? 60000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) { kill(); finish(new GuestTransportError("the guest answer is too large")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on("error", error => finish(new GuestTransportError(`cannot start ${path.basename(argv[0]!)}: ${error.message}`, { cause: error })));
    child.on("exit", code => { exitCode = code; });
    child.on("close", () => finish());
    child.stdin.on("error", () => {});
    child.stdin.end(request);
  });
}

export class LocalGuestTransport implements GuestTransport {
  readonly root: string;
  /** The guest's /workspace. */
  readonly workspace: string;
  /** Scopes workspace keys and binds Pi storage, as a VM's binding does. */
  readonly binding: string;
  calls = 0;
  /** Tests make the machine unreachable with this. */
  offline = false;

  constructor(root: string) {
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(root, "state"), { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
    this.workspace = path.join(this.root, "workspace");
    this.binding = `local:${this.root}`;
  }
  async call(op: GuestOp, header: Record<string, unknown>, options: GuestCallOptions = {}): Promise<GuestAnswer> {
    this.calls++;
    const argv = this.offline ? ["/bin/sh", "-c", "exit 255"] : ["python3", LAUNCHER, this.root, "call", op];
    return runGuestProcess(argv, encodeGuestRequest(header, options.body), {
      ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
  async close(): Promise<void> {}
  /** Kills every command still running; the test process must not leak. */
  stop(): void {
    const ops = path.join(this.root, "state", "ops");
    for (const id of fs.existsSync(ops) ? fs.readdirSync(ops) : []) {
      for (const name of ["wrap.pid", "supervisor.pid"]) {
        try { process.kill(-Number(fs.readFileSync(path.join(ops, id, name), "utf8")), "SIGKILL"); } catch { /* gone */ }
      }
    }
    // `cube service` services run in process groups of their own.
    const services = path.join(this.root, "services");
    for (const name of fs.existsSync(services) ? fs.readdirSync(services).filter(name => name.endsWith(".pid")) : []) {
      try { process.kill(-Number(fs.readFileSync(path.join(services, name), "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
    try { execFileSync("pkill", ["-KILL", "-f", `${LAUNCHER} ${this.root} `], { stdio: "ignore" }); } catch { /* none left */ }
  }
  /** The agent's `cube` command in this guest (its shim runs local-guest.py). */
  cubeCommand(): string { return `python3 ${LAUNCHER} ${this.root} cli`; }
}

/** Thread machines on local guests: one temporary root per thread. */
export class LocalMachines implements ThreadMachines {
  readonly root: string;
  readonly guests = new Map<string, LocalGuestTransport>();
  released = new Map<string, boolean>();
  starts = 0;
  constructor(root: string) { this.root = root; fs.mkdirSync(root, { recursive: true }); }
  guest(thread: Thread): LocalGuestTransport {
    let guest = this.guests.get(thread.id);
    if (!guest) { guest = new LocalGuestTransport(path.join(this.root, thread.id)); this.guests.set(thread.id, guest); }
    return guest;
  }
  /** Like a real machine's seed: the project's hooks as executable files,
   * and where the scripts find them and their per-boot marker. */
  async start(thread: Thread, options: StartOptions = {}): Promise<{ booted: boolean }> {
    this.starts++;
    const fresh = !this.guests.has(thread.id) || this.rebooted.delete(thread.id);
    if (fresh) options.onBoot?.();
    const guest = this.guest(thread);
    const hooks = path.join(guest.root, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    for (const [name, script] of [["pre-setup", thread.allocation.hooks?.preSetup], ["pre-resume", thread.allocation.hooks?.preResume]] as const) {
      if (script?.trim()) fs.writeFileSync(path.join(hooks, name), hookFileContent(script), { mode: 0o755 });
    }
    // keel's note of Java's keystore is on the boot's tmpfs (/run/cube/runner-ca).
    fs.writeFileSync(path.join(guest.root, "env"), `CUBE_HOOKS=${hooks}\nCUBE_RUN=${path.join(guest.root, "run")}\nCUBE_RUNNER_CA=${path.join(guest.root, "run", "runner-ca")}\nHOME=${path.join(guest.root, "home")}\n`);
    return { booted: fresh };
  }
  private readonly rebooted = new Set<string>();
  /** A reboot: the per-boot marker (a tmpfs in a real guest) is gone and
   * the next start boots the machine. */
  reboot(thread: Thread): void {
    fs.rmSync(path.join(this.guest(thread).root, "run"), { recursive: true, force: true });
    this.rebooted.add(thread.id);
  }
  readonly discarded = new Set<string>();
  /** Threads whose machine does not stop in time: the runner keeps the disk. */
  readonly stuck = new Set<string>();
  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    this.guest(thread).stop();
    this.released.set(thread.id, retain);
    if (this.stuck.has(thread.id)) return { retained: true };
    if (!retain) fs.rmSync(path.join(this.root, thread.id), { recursive: true, force: true });
    return { retained: retain };
  }
  async discard(thread: Thread): Promise<void> {
    this.discarded.add(thread.id);
    fs.rmSync(path.join(this.root, thread.id), { recursive: true, force: true });
  }
  async close(): Promise<void> { for (const guest of this.guests.values()) guest.stop(); }
  /** As RunnerMachines reads it; the guest's root stands for its /. */
  async startupLog(thread: Thread): Promise<StartupLog | null> {
    return this.guests.has(thread.id) ? readStartupLog(this.guest(thread), "thread", "/home/.cache/cube") : null;
  }
  running(thread: Thread): boolean { return this.guests.has(thread.id) && !this.released.has(thread.id); }
  /** A local guest's services listen on 127.0.0.1 (its service host). */
  dial(thread: Thread, port: number): Promise<net.Socket> {
    if (!this.running(thread)) return Promise.reject(new Error("the thread's machine is not running"));
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
      socket.once("error", reject);
    });
  }
}
