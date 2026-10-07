/** A machine this cubed attached that still runs but whose guest stopped
 * answering over the gateway: the next start (the recovery loop's) checks
 * the guest, attaches the same machine again (vm.start on a running VM only
 * replaces its frame connection) and waits for it, instead of returning at
 * once and leaving the workspace to fail on ssh every time. Against a fake
 * runner with the real runner's fence; nothing is allocated, moved or
 * released, and an uncertain or fenced start leaves the thread where it is.
 * No VM; not runner acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewaySupervisor } from "../src/gateway.ts";
import { GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp, type GuestTransport } from "../src/guest-ssh.ts";
import { IrohNodeError, type IrohRunnerClient } from "../src/iroh-node.ts";
import { placement, Registry, type Thread } from "../src/registry.ts";
import { RunnerWait, ThreadVms } from "../src/vm.ts";
import { WORKSPACE_LIMIT_KEYS } from "../src/workspace.ts";

type Ref = { threadId: string; vmId: string };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-reattach-"));
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const hello = { version: "test", ready: true, capabilities: [], epoch: 1, limits: Object.fromEntries(WORKSPACE_LIMIT_KEYS.map(key => [key, 1 << 20])) };

/** A guest that answers, or not, as the test says. */
class FakeGuest implements GuestTransport {
  answers = true;
  calls = 0;
  closes = 0;
  async call(op: GuestOp, _header: Record<string, unknown>, _options?: GuestCallOptions): Promise<GuestAnswer> {
    assert.equal(op, "hello");
    this.calls++;
    if (!this.answers) throw new GuestTransportError("ssh could not reach the guest: Connection timed out during banner exchange");
    return { header: hello, body: Buffer.alloc(0) };
  }
  async close(): Promise<void> { this.closes++; }
}

/** One runner (runner.rs rules): every mutation fences the thread's epoch. */
class FakeRunner {
  readonly vms = new Map<string, string>();
  epoch = 0;
  readonly calls: string[] = [];
  /** The next start is applied but its answer is lost. */
  loseStart = false;
  private fence(epoch: number) {
    if (epoch < this.epoch) throw new IrohNodeError("LEASE_STALE", false, "LEASE_STALE");
    this.epoch = epoch;
  }
  private record(ref: Ref) { return { vmId: ref.vmId, threadId: ref.threadId, state: this.vms.get(ref.vmId)!, interrupted: false, diskBytes: 0 }; }
  client() {
    return {
      nodeId: "node-mac",
      target: { peer: "0".repeat(64), network: "loopback" as const, address: "127.0.0.1:1" },
      health: async () => ({ lifecycle: "ready", draining: false, error: null, activeVms: this.vms.size, runningVms: this.vms.size, maxActiveVms: 1,
        retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 3 }),
      describe: async () => ({ softwareVersion: "test", capabilities: [], platform: "macos-aarch64", baseImageSha256: "0".repeat(64),
        limits: { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 2, maxMemoryMiB: 4096, maxDiskGiB: 32, maxSeedBytes: 65536, maxActiveVms: 1 } }),
      vmInspect: async (ref: Ref) => {
        this.calls.push("inspect");
        if (!this.vms.has(ref.vmId)) throw new IrohNodeError("NOT_FOUND");
        return { vm: this.record(ref), consoleTail: null };
      },
      vmAllocate: async (ref: Ref, epoch: number) => {
        this.calls.push("allocate");
        this.fence(epoch);
        this.vms.set(ref.vmId, "allocated");
        return this.record(ref);
      },
      vmStart: async (ref: Ref, epoch: number) => {
        this.calls.push("start");
        this.fence(epoch);
        this.vms.set(ref.vmId, "running");
        if (this.loseStart) { this.loseStart = false; throw new IrohNodeError("OUTCOME_UNKNOWN", true); }
        return this.record(ref);
      },
      vmRelease: async () => { this.calls.push("release"); throw new Error("nothing is released here"); },
      templateList: async () => [],
    };
  }
}

const registry = new Registry(path.join(root, "registry.sqlite"));
registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
registry.enrollRunner({ nodeId: "node-mac", threadId: "mac", environmentId: 1, configPath: "/private/mac.json", configHash: "mac", maxActiveVms: 1 });
const runner = new FakeRunner();
const guest = new FakeGuest();
const attaches: string[] = [];
const links = new Map<string, { link: string; lastError: string | null }>();
const gatewayClient = {
  attach: async (vmId: string, spec: { frameToken: string }) => { attaches.push(spec.frameToken); links.set(vmId, { link: "up", lastError: null }); return links.get(vmId); },
  status: async (vmId: string) => links.get(vmId) ?? null,
  detach: async (vmId: string) => { links.delete(vmId); },
};
const gateway = { binary: "/bin/false", unavailable: null, control: "/nonexistent", onRestart: () => {}, ensureNetwork: async () => {},
  ready: async () => ({ client: gatewayClient, hello: { peer: "0".repeat(64), caPem: "" } }) };

class TestVms extends ThreadVms {
  override guest(_thread: Thread) { return guest as never; }
}
const warnings: string[] = [];
const vms = new TestVms({ registry, threads: path.join(root, "threads"), run: path.join(root, "run"), gateway: gateway as unknown as GatewaySupervisor,
  sizes: { vcpus: 1, memoryMiB: 1024, diskGiB: 8 }, templates: { enabled: false, ttlMs: 3600000 }, readyTimeoutMs: 3000,
  runnerClient: () => runner.client() as unknown as IrohRunnerClient,
  log: { ...silent, warn: (message: string) => { warnings.push(message); } } as never });
const thread = registry.createThread("p", "r1", { provider: "faux", id: "faux" }, "hello");
const reached = () => runner.calls.filter(call => call !== "inspect");

try {
  // A first start allocates and boots the machine.
  assert.deepEqual(await vms.start(thread), { booted: true });
  assert.deepEqual(reached(), ["allocate", "start"]);
  assert.equal(attaches.length, 1);
  assert.equal(placement(registry.getThread(thread.id)!), "allocated");

  // Attached, running, answering: only checked.
  runner.calls.length = 0;
  const before = guest.calls;
  assert.deepEqual(await vms.start(thread), { booted: false });
  assert.deepEqual(reached(), [], "a machine whose guest answers is not started again");
  assert.equal(guest.calls, before + 1, "the check asks the guest itself, not only the runner");
  console.log("ok: an attached machine whose guest answers is only checked");

  // The runner says running and the gateway has it, but ssh cannot reach the
  // guest. The next start attaches the same machine again and waits for it.
  guest.answers = false;
  runner.calls.length = 0;
  const epoch = runner.epoch;
  const closes = guest.closes;
  const starting = vms.start(thread, { onBoot: () => { guest.answers = true; } });
  assert.deepEqual(await starting, { booted: false }, "a running machine attached again was not booted");
  assert.deepEqual(reached(), ["start"], "only vm.start (a new frame connection), no allocation, no release");
  assert.ok(runner.epoch > epoch, "the start is fenced by a newer epoch");
  assert.equal(attaches.length, 2);
  assert.notEqual(attaches[1], attaches[0], "the gateway gets a new frame token: a new link to the same machine");
  assert.equal(guest.closes, closes + 1, "the stale ssh connection is closed first");
  assert.ok(warnings.includes("machine runs but its guest does not answer; attaching it again"));
  assert.equal(registry.getThread(thread.id)!.runnerId, "mac");
  console.log("ok: a running machine whose guest stopped answering is attached again and waited for, not trusted");

  // A guest that stays unreachable: the start fails after the ready wait,
  // saying so; the machine is not moved, released or allocated anew, and
  // the next start (the recovery loop's retry) tries the guest again.
  guest.answers = false;
  runner.calls.length = 0;
  await assert.rejects(vms.start(thread), /the machine did not become ready: ssh could not reach the guest/);
  assert.deepEqual(reached(), ["start"]);
  assert.equal(registry.getThread(thread.id)!.runnerId, "mac");
  assert.equal(placement(registry.getThread(thread.id)!), "allocated");
  runner.calls.length = 0;
  guest.answers = true;
  assert.deepEqual(await vms.start(thread), { booted: false }, "the retry finds the guest answering");
  assert.deepEqual(reached(), []);
  console.log("ok: a guest that stays unreachable fails the start after the ready wait; the retry asks it again");

  // The re-attach's answer is lost (the runner applied it): the start fails,
  // the thread stays on its runner, and the retry fences with a newer epoch.
  guest.answers = false;
  runner.loseStart = true;
  runner.calls.length = 0;
  await assert.rejects(vms.start(thread));
  assert.deepEqual(reached(), ["start"], "an uncertain start never allocates or moves the machine");
  assert.equal(registry.getThread(thread.id)!.runnerId, "mac");
  assert.equal(placement(registry.getThread(thread.id)!), "allocated");
  // The lost answer counts as lost contact: the thread waits for its runner
  // (and stays on it) until the runner answers ready again.
  await assert.rejects(vms.start(thread), (error: Error) => error instanceof RunnerWait && /this thread's machine is on it and stays there/.test(error.message));
  assert.equal(registry.getThread(thread.id)!.runnerId, "mac");
  registry.recordRunnerProbe("mac", { health: await runner.client().health() as never });
  guest.answers = true;
  runner.calls.length = 0;
  const lost = runner.epoch;
  assert.deepEqual(await vms.start(thread), { booted: false });
  assert.ok(runner.epoch > lost);
  console.log("ok: a re-attach whose answer is lost leaves the thread on its runner; the retry is fenced anew");

  // A newer owner fenced the machine: this cubed's re-attach is refused and
  // takes nothing over.
  guest.answers = false;
  runner.epoch = Number.MAX_SAFE_INTEGER;
  runner.calls.length = 0;
  const attached = attaches.length;
  await assert.rejects(vms.start(thread), /LEASE_STALE/);
  assert.deepEqual(reached(), ["start"]);
  assert.equal(registry.getThread(thread.id)!.runnerId, "mac");
  assert.equal(attaches.length, attached, "a refused start attaches nothing");
  console.log("ok: a re-attach fenced by a newer owner is refused and changes nothing");
} finally {
  await vms.close();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
