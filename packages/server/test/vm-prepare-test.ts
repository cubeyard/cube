/** What a new thread machine's disk is made from, decided by ThreadVms
 * before allocation, against a fake runner client (no VM): a matching
 * template is used and obsolete ones are removed; one build per runner and
 * key (a thread that comes meanwhile starts fresh); a failed build falls back
 * to a fresh machine and is not retried at once; a template that vanished
 * before allocation falls back too; a build machine a crash left behind is
 * deleted first, on the runner it was made on; templates off or an older
 * runner mean fresh machines. The build itself runs in scripts/test-vm-templates.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewaySupervisor } from "../src/gateway.ts";
import { IrohNodeError, type IrohRunnerClient, type RunnerTemplate } from "../src/iroh-node.ts";
import { Registry, type Thread } from "../src/registry.ts";
import { ThreadVms } from "../src/vm.ts";
import { TEMPLATE_FORMAT, templateKey } from "../src/vm-template.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-prepare-"));
const model = { provider: "faux", id: "faux" };
const IMAGE = "0".repeat(64);
type Ref = { threadId: string; vmId: string };

try {
  const registry = new Registry(path.join(root, "registry.sqlite"));
  const project = (id: string) => ({ id, name: id, status: "ready" as const, error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1,
    repositories: [], hooks: { preSetup: "echo prepare", preResume: "" } });
  registry.saveProject(project("p1"));
  const enroll = (id: string, environmentId: number) => registry.enrollRunner({ nodeId: `node-${id}`, threadId: id, environmentId, configPath: `/private/${id}.json`, configHash: id });
  enroll("r1", 1);
  registry.recordRunnerSlots("r1", 8);

  const calls: string[] = [];
  let templates: RunnerTemplate[] = [];
  let capabilities = ["vm.publish"];
  let buildAllocate: (ref: Ref) => Promise<unknown> = async () => { throw new IrohNodeError("IO_ERROR", false, "disk full"); };
  const vanished = new Set<string>();
  const machines = new Map<string, string>();
  const fake = (name: string) => ({
    target: { peer: "0".repeat(64), network: "loopback" as const, address: "127.0.0.1:1" },
    nodeId: `node-${name}`,
    health: async () => ({ lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 8,
      retainedVms: 0, retainedBytes: 0, softwareVersion: "0.8.0", protocolVersion: 3 }),
    describe: async () => ({ softwareVersion: "0.8.0", capabilities, platform: "linux-x86_64", baseImageSha256: IMAGE,
      limits: { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 2, maxMemoryMiB: 4096, maxDiskGiB: 32, maxSeedBytes: 65536, maxActiveVms: 8 } }),
    vmInspect: async (ref: Ref) => {
      const state = machines.get(`${name}:${ref.vmId}`);
      if (!state) throw new IrohNodeError("NOT_FOUND");
      return { vm: { vmId: ref.vmId, threadId: ref.threadId, state, interrupted: false, diskBytes: 0 }, consoleTail: null };
    },
    vmAllocate: async (ref: Ref, _epoch: number, _disk: number, template?: string) => {
      const thread = registry.getThread(ref.threadId)!;
      if (ref.vmId !== thread.vm!.vmId) { calls.push(`${name}:build-allocate`); return buildAllocate(ref); }
      calls.push(`${name}:allocate:${template ?? "base"}`);
      if (template && vanished.has(template)) throw new IrohNodeError("NOT_FOUND", false, "the template is not available on this runner");
      return { vmId: ref.vmId, threadId: ref.threadId, state: "allocated", interrupted: false, diskBytes: 0, ...(template ? { template } : {}) };
    },
    vmRelease: async (ref: Ref, _epoch: number, retain: boolean) => {
      calls.push(`${name}:release:${ref.vmId}:${retain}`);
      machines.set(`${name}:${ref.vmId}`, "released");
      return { vmId: ref.vmId, threadId: ref.threadId, state: "released", interrupted: false, diskBytes: 0 };
    },
    templateList: async () => templates,
    templateRemove: async (id: string) => { calls.push(`${name}:remove:${id}`); return templates.find(template => template.id === id)!; },
    vmStart: async () => { throw new Error("fixture stops here"); },
  });
  const gateway = { binary: "/bin/false", unavailable: null, control: "/nonexistent", onRestart: () => {},
    ensureNetwork: async () => {}, ready: async () => ({ client: { detach: async () => {} }, hello: { peer: "0".repeat(64), caPem: "" } }) };
  const vms = (enabled = true) => new ThreadVms({ registry, threads: path.join(root, "threads"), run: path.join(root, "run"),
    gateway: gateway as unknown as GatewaySupervisor, sizes: { vcpus: 1, memoryMiB: 1024, diskGiB: 8 }, templates: { enabled, ttlMs: 3600000 },
    runnerClient: admission => fake(admission.configHash) as unknown as IrohRunnerClient, log: { info() {}, warn() {}, error() {}, debug() {} } as never });
  const threadVms = vms();
  let requests = 0;
  const start = async (machinesOf = threadVms): Promise<Thread> => {
    const thread = registry.createThread("p1", `t${++requests}`, model, "hello");
    await assert.rejects(machinesOf.start(thread), /fixture stops here/);
    return registry.getThread(thread.id)!;
  };
  const meta = (projectId: string) => JSON.stringify({ format: TEMPLATE_FORMAT, projectId, setupBlob: "none", commit: null });
  const template = (id: string, key: string, createdAt = Date.now(), projectId = "p1"): RunnerTemplate =>
    ({ id, key, meta: meta(projectId), state: "ready", diskGiB: 8, bytes: 1, createdAt, users: 0 });
  const sample = registry.createThread("p1", "sample", model, "sample");
  const key = templateKey({ allocation: sample.allocation, hooks: sample.allocation.hooks!, runner: { baseImageSha256: IMAGE, platform: "linux-x86_64" }, diskGiB: 8 });
  registry.finishRelease(sample.id);

  // A matching template is used; expired ones and those of deleted projects are removed.
  templates = [template("a000000000000001", key), template("a000000000000002", key, Date.now() - 7200000), template("a000000000000003", "f".repeat(64), Date.now(), "gone")];
  const used = await start();
  assert.deepEqual(used.vm!.preparation, { source: "template", templateId: "a000000000000001", setupBlob: "none" });
  assert.deepEqual(calls, ["r1:remove:a000000000000002", "r1:remove:a000000000000003", "r1:allocate:a000000000000001"]);
  console.log("ok: a matching fresh template is used; expired and orphaned templates are removed");

  // One build per runner and key: a thread that comes meanwhile starts fresh.
  templates = [];
  calls.length = 0;
  let fail!: (error: Error) => void;
  buildAllocate = () => new Promise((_resolve, reject) => { fail = reject; });
  const first = registry.createThread("p1", "first", model, "hello");
  const building = assert.rejects(threadVms.start(first), /fixture stops here/);
  while (!calls.includes("r1:build-allocate")) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(registry.getThread(first.id)!.vm!.build, "the build machine is recorded on its thread");
  const meanwhile = await start();
  assert.deepEqual(meanwhile.vm!.preparation, { source: "fresh", reason: "another thread is preparing this project's template" });
  // The build fails: its thread starts fresh, the build record goes, and the key backs off.
  fail(new IrohNodeError("IO_ERROR", false, "disk full"));
  await building;
  const failed = registry.getThread(first.id)!;
  assert.equal(failed.vm!.preparation!.source, "fresh");
  assert.match(failed.vm!.preparation!.reason!, /the template build failed: disk full/);
  assert.equal(failed.vm!.build, undefined);
  calls.length = 0;
  const after = await start();
  assert.deepEqual(after.vm!.preparation, { source: "fresh", reason: "the project's last template build failed" });
  assert.deepEqual(calls, ["r1:allocate:base"], "no second build right away");
  console.log("ok: one build per runner and key; a failed build starts its thread fresh and backs off");

  // A template removed between listing and allocation: fresh instead.
  templates = [template("a000000000000004", key)];
  vanished.add("a000000000000004");
  calls.length = 0;
  const raced = await start();
  assert.deepEqual(calls, ["r1:allocate:a000000000000004", "r1:allocate:base"]);
  assert.equal(raced.vm!.preparation!.source, "fresh");
  console.log("ok: a template that vanished before allocation falls back to the base image");

  // A build machine a crash left behind is deleted first, on its own runner.
  const left = registry.createThread("p1", "left", model, "hello");
  enroll("r2", 2);
  registry.updateThreadVm(left.id, { build: { vmId: "b000000000000001", placeholders: {}, key, runnerId: "r2" } });
  machines.set("r2:b000000000000001", "stopped");
  calls.length = 0;
  await assert.rejects(threadVms.start(left), /fixture stops here/);
  assert.deepEqual(calls.slice(0, 1), ["r2:release:b000000000000001:false"]);
  assert.equal(registry.getThread(left.id)!.vm!.build, undefined);
  console.log("ok: a build machine left by a crash is released (not retained) on the runner it was made on");

  // Templates off, or a runner before 0.8.0: fresh machines.
  calls.length = 0;
  assert.deepEqual((await start(vms(false))).vm!.preparation, { source: "fresh", reason: "templates are off (CUBED_TEMPLATES=off)" });
  capabilities = [];
  assert.deepEqual((await start()).vm!.preparation, { source: "fresh", reason: "the runner has no machine templates (cube-runner 0.8.0+)" });
  assert.deepEqual(calls.map(call => call.replace(/^r\d:/, "")), ["allocate:base", "allocate:base"]);
  console.log("ok: templates off or an older runner: machines start from the base image");
  registry.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
