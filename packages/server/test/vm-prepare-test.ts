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
import { TEMPLATE_FORMAT, missingTemplate, templateKey, templateParts } from "../src/vm-template.ts";

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
  assert.deepEqual(meanwhile.vm!.preparation, { source: "fresh", reason: "the project has no template on this runner yet; another thread is preparing the project's template now" });
  // The build fails: its thread starts fresh, the build record goes, and the key backs off.
  fail(new IrohNodeError("IO_ERROR", false, "disk full"));
  await building;
  const failed = registry.getThread(first.id)!;
  assert.equal(failed.vm!.preparation!.source, "fresh");
  assert.match(failed.vm!.preparation!.reason!, /the template build failed: disk full/);
  assert.equal(failed.vm!.build, undefined);
  calls.length = 0;
  const after = await start();
  assert.equal(after.vm!.preparation!.source, "fresh");
  assert.match(after.vm!.preparation!.reason!, /^the project has no template on this runner yet; the last build of one failed under a minute ago \(disk full\); cube tries again in 60 min, or at once with a new commit or another machine size$/);
  assert.deepEqual(calls, ["r1:allocate:base"], "no second build right away");
  // The steps the thread shows: what the lookup found, and where the build stopped.
  const shown = (thread: Thread) => registry.getThread(thread.id)!.vm!.steps!.map(step => `${step.name} ${step.state}: ${step.detail ?? ""}`);
  assert.deepEqual(shown(failed), ["lookup ok: the project has no template on this runner yet: building one",
    "build-boot failed: IO_ERROR: disk full; no template was published", "boot failed: fixture stops here"]);
  assert.deepEqual(shown(meanwhile), ["lookup ok: no template: the project has no template on this runner yet; another thread is preparing the project's template now", "boot failed: fixture stops here"]);
  assert.match(shown(after)[0]!, /^lookup ok: no template: .*the last build of one failed/);
  // Another machine size is not held back by the failed build: it builds at once.
  registry.saveProject({ ...project("p1"), machine: { memoryMiB: 2048 } });
  buildAllocate = async () => { throw new IrohNodeError("IO_ERROR", false, "disk full"); };
  calls.length = 0;
  const bigger = await start();
  assert.deepEqual(bigger.allocation.machine, { memoryMiB: 2048 });
  assert.deepEqual(calls, ["r1:build-allocate", "r1:allocate:base"], "a build with the new size");
  assert.match(shown(bigger)[1]!, /^build-boot failed: .*disk full/);
  registry.saveProject(project("p1"));
  console.log("ok: one build per runner and key; a failed build starts its thread fresh and backs off, except for another machine size; the steps say so");

  // Nor is a new commit of the primary repository: the fix may be in it.
  const repository = (oid: string) => ({ id: "r", projectId: "p2", position: 0, url: "https://example.invalid/p2.git", base: "main", checkoutName: "workspace",
    status: "ready" as const, error: null, resolvedBase: "refs/heads/main", baseOid: oid, checkedAt: 1 });
  registry.saveProject({ ...project("p2"), repositories: [repository("a".repeat(40))] });
  const inProject = async (name: string) => {
    const thread = registry.createThread("p2", name, model, "hello");
    await assert.rejects(threadVms.start(thread), /fixture stops here/);
    registry.finishRelease(thread.id);
    return registry.getThread(thread.id)!;
  };
  calls.length = 0;
  await inProject("c1");
  await inProject("c2");
  assert.deepEqual(calls, ["r1:build-allocate", "r1:allocate:base", "r1:allocate:base"], "one failed build, then the backoff");
  registry.saveProject({ ...project("p2"), repositories: [repository("b".repeat(40))] });
  calls.length = 0;
  await inProject("c3");
  assert.deepEqual(calls, ["r1:build-allocate", "r1:allocate:base"], "a new commit builds again at once");
  console.log("ok: a new commit is not held back by the failed build of an older one");

  // Why there is no template: an expired one, or what changed since the project's last one.
  const keyed = registry.createThread("p1", "keyed", model, "hello");
  const parts = templateParts({ allocation: keyed.allocation, hooks: keyed.allocation.hooks!, runner: { baseImageSha256: IMAGE, platform: "linux-x86_64" }, diskGiB: 8 });
  const withParts = (id: string, key: string, createdAt: number, changed: Partial<typeof parts> = {}): RunnerTemplate => ({ ...template(id, key, createdAt),
    meta: JSON.stringify({ format: TEMPLATE_FORMAT, projectId: "p1", setupBlob: "none", commit: null, parts: { ...parts, ...changed } }) });
  const why = (list: RunnerTemplate[]) => missingTemplate(list, { projectId: "p1", key, parts, now: Date.now(), ttlMs: 24 * 3600000 });
  assert.equal(why([]), "the project has no template on this runner yet");
  assert.equal(why([withParts("c000000000000001", key, Date.now() - 25 * 3600000)]), "template c000000000000001 expired (prepared 25 h ago; templates are reused for 24 h)");
  assert.equal(why([withParts("c000000000000002", "e".repeat(64), Date.now() - 3600000, { preSetup: "0".repeat(16) })]), "the pre-setup hook changed since template c000000000000002");
  assert.equal(why([withParts("c000000000000003", "e".repeat(64), Date.now(), { repositories: "1".repeat(16), disk: "2".repeat(16) })]),
    "the project's repositories, the disk size changed since template c000000000000003");
  assert.equal(why([template("c000000000000004", "e".repeat(64))]), "template c000000000000004 was prepared with other settings", "a template from before parts were kept");
  registry.finishRelease(keyed.id);
  console.log("ok: a missing template is explained: none yet, expired, or what changed since the last one");

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

  // cubed stopped in the middle of a build; when it is back another thread
  // has published a template. The next activation (which first marks what
  // was left running interrupted, Conversations.activate) deletes the build
  // machine and uses the template; nothing stays running.
  templates = [template("a000000000000005", key)];
  const crashed = registry.createThread("p1", "crashed", model, "hello");
  for (const name of ["lookup", "build-boot"] as const) {
    registry.beginStartupStep(crashed.id, { name });
    registry.endStartupStep(crashed.id, { name, state: "ok" });
  }
  registry.beginStartupStep(crashed.id, { name: "build-prepare" });
  registry.updateThreadVm(crashed.id, { build: { vmId: "b000000000000002", placeholders: {}, key, runnerId: "r1" } });
  machines.set("r1:b000000000000002", "running");
  calls.length = 0;
  registry.interruptStartupSteps(crashed.id);
  await assert.rejects(threadVms.start(crashed), /fixture stops here/);
  assert.deepEqual(calls, ["r1:release:b000000000000002:false", "r1:allocate:a000000000000005"]);
  assert.deepEqual(shown(crashed), ["lookup ok: ", "build-boot ok: ", "build-prepare interrupted: ", "lookup ok: template a000000000000005, prepared under a minute ago",
    "boot failed: fixture stops here"]);
  // A preparation try marked interrupted that ended in the guest meanwhile ends in its place.
  registry.beginStartupStep(crashed.id, { name: "prepare", attempt: 1 });
  registry.interruptStartupSteps(crashed.id);
  registry.endStartupStep(crashed.id, { name: "prepare", attempt: 1, state: "ok", detail: "pre-setup ok" }, Date.now(), true);
  assert.deepEqual(shown(crashed).slice(-1), ["prepare ok: pre-setup ok"], "one entry for the try, not two");
  registry.finishRelease(crashed.id);
  console.log("ok: after a build cubed did not finish, a template is used and no step stays running; an interrupted try that ended meanwhile ends in its place");

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
