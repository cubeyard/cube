/** Test only: the real guest helper (packages/server/guest/cube-guest.py)
 * under a temporary root, with a process launcher instead of systemd
 * (local-guest.py). It stands in for a thread VM reached over SSH; the same
 * contract runs against a real VM in scripts/smoke-node-adapter.ts. Not
 * runner acceptance. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encodeGuestRequest, runGuestProcess, type GuestAnswer, type GuestCallOptions, type GuestOp, type GuestTransport } from "../src/guest-ssh.ts";
import type { ThreadMachines } from "../src/vm.ts";
import type { Thread } from "../src/registry.ts";

const LAUNCHER = path.join(import.meta.dirname, "local-guest.py");

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
    try { execFileSync("pkill", ["-KILL", "-f", `${LAUNCHER} ${this.root} `], { stdio: "ignore" }); } catch { /* none left */ }
  }
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
  async start(thread: Thread): Promise<{ booted: boolean }> {
    this.starts++;
    const fresh = !this.guests.has(thread.id) || this.rebooted.delete(thread.id);
    const guest = this.guest(thread);
    const hooks = path.join(guest.root, "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    for (const [name, script] of [["pre-setup", thread.allocation.hooks?.preSetup], ["pre-resume", thread.allocation.hooks?.preResume]] as const) {
      if (script?.trim()) fs.writeFileSync(path.join(hooks, name), script.startsWith("#!") ? script : `#!/bin/bash\n${script}`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(guest.root, "env"), `CUBE_HOOKS=${hooks}\nCUBE_RUN=${path.join(guest.root, "run")}\nHOME=${path.join(guest.root, "home")}\n`);
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
  async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    this.guest(thread).stop();
    this.released.set(thread.id, retain);
    if (!retain) fs.rmSync(path.join(this.root, thread.id), { recursive: true, force: true });
    return { retained: retain };
  }
  async discard(thread: Thread): Promise<void> {
    this.discarded.add(thread.id);
    fs.rmSync(path.join(this.root, thread.id), { recursive: true, force: true });
  }
  async close(): Promise<void> { for (const guest of this.guests.values()) guest.stop(); }
}
