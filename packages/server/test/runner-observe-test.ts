/** Read-only runner observation: what a runner reported, how fresh it is,
 * cubed's slots, and what stays unknown; and a protocol-3 runner (retired)
 * whose row and last report stay readable but which is never probed, placed
 * on or counted as capacity. Runner reports are faked; the hello fields
 * themselves are covered in runner-vm-machines-test.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { diskState, type TrustedRunnerHealth, type VmLimits } from "../src/runner-types.ts";
import { Registry, type Project } from "../src/registry.ts";
import { describeRunners, localDisk, NOT_REPORTED, observeRunners } from "../src/runner-observe.ts";

const GiB = 2 ** 30;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-observe-"));
const limits: VmLimits = { maxFrameBytes: 1 << 20, requestTimeoutMs: 30_000, maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64, maxSeedBytes: 65536, maxActiveVms: 2 };
// What cubed recorded before it kept the hello's fields.
const legacy: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.6.0", protocolVersion: 4 };
/** A berth vm. */
const runner = (id: string, maxActiveVms?: number) => ({ nodeId: `node-${id}`, environmentId: 1, threadId: id,
  configPath: path.join(root, `${id}.json`), configHash: id, ...(maxActiveVms ? { maxActiveVms } : {}), protocol: 4 as const, kind: "vm" as const });
/** A runner enrolled with protocol 3 (cube-runner) before it was retired: no `protocol` in its row. */
const p3 = (id: string, maxActiveVms?: number) => ({ nodeId: `node-${id}`, environmentId: 1, threadId: id,
  configPath: path.join(root, `${id}.json`), configHash: id, ...(maxActiveVms ? { maxActiveVms } : {}) });
/** A protocol-3 runner's last report, as cube-runner 0.8 sent it. */
const p3Report: TrustedRunnerHealth = { ...legacy, protocolVersion: 3, softwareVersion: "0.8.4", maxActiveVms: 2, retainedVms: 6, retainedBytes: 6 * 2 ** 30,
  platform: "macos-aarch64", capabilities: ["node.status"], limits: { maxFrameBytes: 1 << 20, requestTimeoutMs: 30_000, maxVcpus: 4, maxMemoryMiB: 8192,
  maxDiskGiB: 64, maxSeedBytes: 65536, maxActiveVms: 2 } };
const until = async (test: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(test(), what);
};

try {
  // --- the registry alone: slots, freshness, never-probed runners ---
  {
    const registry = new Registry(path.join(root, "registry.sqlite"));
    const project: Project = { id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] };
    registry.saveProject(project);
    assert.equal(describeRunners(observeRunners(registry, 60_000)), "no runners enrolled");
    registry.enrollRunner(runner("silent"));
    registry.enrollRunner(runner("wide"));
    let view = observeRunners(registry, 60_000);
    const silent = view.runners.find(row => row.id === "silent")!;
    assert.equal(silent.report, null, "a runner that never answered has no report");
    assert.equal(silent.contact.status, "unknown");
    assert.deepEqual(silent.slots, { total: 1, totalSource: "assumed", reserved: 0, free: 1, allocatable: true },
      "a bound the runner never advertised is shown as assumed");
    assert.equal(silent.byName, false, "a berth vm is in the pool");
    assert.match(silent.unknown.join("\n"), /has not answered a probe/);
    assert.deepEqual(view.notReported, NOT_REPORTED);

    const at = 1_000_000;
    registry.recordRunnerProbe("wide", { health: { ...legacy, softwareVersion: "0.8.0", maxActiveVms: 2, activeVms: 2, runningVms: 2,
      platform: "linux-x86_64", capabilities: ["node.hello", "node.status", "template.publish"], limits,
      disk: { freeBytes: 10 * GiB, freeInodes: 500_000, committedBytes: 3 * GiB, reserveBytes: 2 * GiB, reserveInodes: 10_000 } } }, at);
    registry.createThread("p", "one", { provider: "fixture", id: "m" }, "one", "pi", undefined, { runnerId: "wide" });
    registry.createThread("p", "two", { provider: "fixture", id: "m" }, "two", "pi", undefined, { runnerId: "wide" });
    view = observeRunners(registry, 60_000, at + 30_000);
    const wide = view.runners.find(row => row.id === "wide")!;
    assert.equal(wide.report?.fresh, true);
    assert.equal(wide.report?.softwareVersion, "0.8.0");
    assert.deepEqual([wide.report?.os, wide.report?.arch, wide.report?.accelerator], ["linux", "x86_64", "kvm"]);
    assert.deepEqual(wide.report?.vmLimits, { maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64 });
    assert.equal(wide.slots.totalSource, "reported");
    assert.equal(wide.slots.total, 2);
    // Two threads started on the wider runner by name; the silent one is assumed to have one slot.
    assert.deepEqual([wide.slots.reserved, view.runners.find(row => row.id === "silent")!.slots.reserved], [2, 0]);
    assert.deepEqual(wide.unknown, [], "a fresh, complete report leaves only the protocol's unknowns");
    // 10 GiB free less 3 GiB committed is under 4 × the 2 GiB reserve.
    assert.deepEqual(wide.report?.disk, { freeBytes: 10 * GiB, freeInodes: 500_000, committedBytes: 3 * GiB, reserveBytes: 2 * GiB, reserveInodes: 10_000, state: "low" });
    assert.match(describeRunners(view), /node-wide[^]*\n {2}disk: 10\.0 GiB free, 3\.0 GiB of it committed to template builds \(an estimate\), 500000 inodes free; reserve 2\.0 GiB; low\n/);

    // The disk's state, as berth's rule (disk.rs) decides a new machine; unknown is never zero.
    const disk = (freeBytes: number | null, committedBytes: number | null, freeInodes: number | null = null) =>
      diskState({ freeBytes, freeInodes, committedBytes, reserveBytes: 2 * GiB, reserveInodes: 10_000 });
    assert.deepEqual([disk(8 * GiB, 0), disk(8 * GiB - 1, 0), disk(2 * GiB, 0), disk(2 * GiB - 1, 0), disk(5 * GiB, 3 * GiB + 1),
      disk(100 * GiB, 0, 9_999), disk(100 * GiB, 0, 10_000), disk(null, 0), disk(2 * GiB, null), diskState(undefined)],
    ["ok", "low", "low", "refusing", "refusing", "refusing", "ok", "unknown", "low", "unknown"]);
    // A report without disk fields (an older berth): unknown, said so.
    registry.enrollRunner(runner("older"));
    registry.recordRunnerProbe("older", { health: { ...legacy, platform: "linux-x86_64", capabilities: [], limits } }, at);
    const undisked = observeRunners(registry, 60_000, at + 1000).runners.find(row => row.id === "older")!;
    assert.equal(undisked.report?.disk, null);
    assert.deepEqual(undisked.unknown, ["disk: the runner does not report its free space (a berth before it did)"]);
    registry.beginRunnerRetirement("older");
    registry.finishRunnerRetirement("older", "test", at, at + 1);
    // cubed's own directories, measured for real (nothing is written).
    const own = localDisk(root);
    assert.ok(own.freeBytes !== null && own.freeBytes > 0, JSON.stringify(own));
    assert.deepEqual(localDisk(path.join(root, "missing")), { freeBytes: null, freeInodes: null, low: false });

    // Without a newer probe the same report grows stale.
    const old = observeRunners(registry, 60_000, at + 10 * 60_000).runners.find(row => row.id === "wide")!;
    assert.equal(old.report?.fresh, false);
    assert.match(old.unknown.join("\n"), /not the runner's state now/);
    assert.match(describeRunners(observeRunners(registry, 60_000, at + 10 * 60_000)), /last reported 10 min ago \(stale\): berth 0\.8\.0/);

    // A failed probe keeps the last report, marked stale, and the runner unreachable.
    registry.recordRunnerProbe("wide", { error: "NODE_UNAVAILABLE" }, at + 60_000);
    const lost = observeRunners(registry, 60_000, at + 61_000).runners.find(row => row.id === "wide")!;
    assert.equal(lost.contact.status, "unreachable");
    assert.equal(lost.report?.softwareVersion, "0.8.0");
    assert.equal(lost.report?.fresh, false);
    assert.equal(lost.slots.total, 2, "scheduling keeps the last advertised bound");

    // An older cubed on the same registry records health but keeps no report:
    // the newer health wins over the kept report.
    const older = new DatabaseSync(path.join(root, "registry.sqlite"));
    older.prepare("UPDATE runner_operator SET last_attempt_at=?,last_contact_at=?,unreachable_since=NULL,last_error=NULL,health=? WHERE runner_id='wide'")
      .run(at + 120_000, at + 120_000, JSON.stringify({ ...legacy, softwareVersion: "0.8.2" }));
    older.close();
    const newer = observeRunners(registry, 60_000, at + 121_000).runners.find(row => row.id === "wide")!;
    assert.deepEqual([newer.report?.softwareVersion, newer.report?.fresh, newer.report?.platform], ["0.8.2", true, null]);

    // A platform cubed does not know, a retiring and a retired runner.
    registry.enrollRunner(runner("odd"));
    registry.recordRunnerProbe("odd", { health: { ...legacy, platform: "freebsd-riscv64", capabilities: [], limits } }, at);
    const odd = observeRunners(registry, 60_000, at + 1000).runners.find(row => row.id === "odd")!;
    assert.deepEqual([odd.report?.platform, odd.report?.os, odd.report?.accelerator], ["freebsd-riscv64", null, null]);
    assert.match(odd.unknown.join("\n"), /not one cubed knows/);
    registry.enrollRunner(runner("leaving"));
    registry.enrollRunner(runner("done"));
    registry.recordRunnerProbe("done", { health: legacy }, at);
    registry.beginRunnerRetirement("leaving");
    registry.beginRunnerRetirement("done");
    registry.finishRunnerRetirement("done", "test", at, at + 1);
    const retiring = observeRunners(registry, 60_000, at + 2000);
    const leaving = retiring.runners.find(row => row.id === "leaving")!;
    assert.equal(leaving.retirement, "retiring");
    assert.deepEqual([leaving.slots.free, leaving.slots.allocatable], [0, false]);
    assert.equal(retiring.runners.find(row => row.id === "done")!.retirement, "retired");
    assert.deepEqual([retiring.pool.runners, retiring.pool.allocatable], [4, 3], "retired runners are not counted; a retiring one takes no thread");
    const text = describeRunners(retiring);
    assert.match(text, /node-leaving \(id leaving; retiring\)[^]*not taking threads/);
    assert.ok(!text.includes("node-done"), "a retired runner is not listed");
    // A probe failure that names a local file stays out of the model's text.
    registry.recordRunnerProbe("silent", { error: "ENOENT: no such file or directory, open '/private/silent.json'" }, at);
    assert.match(describeRunners(observeRunners(registry, 60_000, at + 1000)), /node-silent[^]*unreachable since 1 s ago \(probe failed; details in \/api\/runners\)/);
    assert.ok(!describeRunners(observeRunners(registry, 60_000, at + 1000)).includes("/private/"));

    // A protocol-4 VM runner (berth vm) is in the pool; a host runner is not.
    registry.enrollRunner({ ...runner("berth", 3), protocol: 4, kind: "vm" });
    registry.enrollRunner({ ...runner("bhost", 2), protocol: 4, kind: "host" });
    const pooled = observeRunners(registry, 60_000, at + 1000);
    const berth = pooled.runners.find(row => row.id === "berth")!;
    const bhost = pooled.runners.find(row => row.id === "bhost")!;
    assert.deepEqual([berth.kind, berth.byName, berth.slots.allocatable, berth.slots.free], ["vm", false, true, 3]);
    assert.deepEqual([bhost.kind, bhost.byName, bhost.slots.allocatable, bhost.slots.free], ["host", true, false, 2]);
    assert.deepEqual([pooled.pool.allocatable, pooled.pool.slots], [retiring.pool.allocatable + 1, retiring.pool.slots + 3], "the berth vm joins the pool, the host runner does not");
    const pooledText = describeRunners(pooled);
    assert.match(pooledText, /node-berth[^]*protocol-4 VM runner \(berth vm\): in the pool;[^]*cubed's slots: 0 reserved by open threads of 3, 3 free\n/);
    assert.match(pooledText, /node-bhost[^]*HOST runner[^]*2 free for threads started on it by name/);
    assert.ok(!/not in the pool yet/.test(pooledText));
    registry.close();
  }

  // --- capacity by protocol: p4 vm the pool, p4 host by name, what is not current; p3 none, with its unarchived threads ---
  {
    const registry = new Registry(path.join(root, "capacity.sqlite"));
    registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
    const model = { provider: "fixture", id: "m" };
    const at = 5_000_000;
    registry.enrollRunner(runner("fresh", 4));
    registry.enrollRunner(runner("stale", 2));
    registry.enrollRunner(runner("mute"));
    registry.enrollRunner(p3("retired"));
    registry.enrollRunner(p3("old3", 2));
    registry.enrollRunner({ ...runner("host4", 2), protocol: 4, kind: "host" });
    registry.recordRunnerProbe("retired", { health: legacy }, at - 1000);
    registry.beginRunnerRetirement("retired");
    registry.finishRunnerRetirement("retired", "test", at - 1000, at - 500);
    registry.recordRunnerProbe("fresh", { health: { ...legacy, kind: "vm", softwareVersion: "0.1.0", maxActiveVms: 4, activeVms: 2, platform: "linux-x86_64", capabilities: [] } }, at);
    registry.recordRunnerProbe("stale", { health: { ...legacy, maxActiveVms: 2, platform: "linux-x86_64", capabilities: [] } }, at - 10 * 60_000);
    // The protocol-3 runner's last report, from before it was retired.
    registry.recordRunnerProbe("old3", { health: p3Report }, at - 86_400_000);
    // Two open threads on the protocol-3 runner from when it took threads, and one archived.
    const before = new DatabaseSync(path.join(root, "capacity.sqlite"));
    before.prepare("UPDATE runner SET data=json_set(data,'$.protocol',4,'$.kind','vm') WHERE id='old3'").run();
    for (const id of ["a", "d"]) registry.createThread("p", id, model, id, "pi", undefined, { runnerId: "old3" });
    registry.applyPhase(registry.threadByRequest("p", "d")!.id, { type: "released" });
    registry.createThread("p", "b", model, "b", "pi", undefined, { runnerId: "old3" });
    before.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='old3'").run();
    before.close();
    // One pooled thread on a berth vm; one thread on the host runner by name.
    registry.createThread("p", "e", model, "e");
    registry.createThread("p", "f", model, "f", "pi", undefined, { runnerId: "host4" });
    const view = observeRunners(registry, 60_000, at + 1000);
    const byId = (id: string) => view.runners.find(row => row.id === id)!;
    assert.deepEqual(["fresh", "stale", "mute", "retired", "old3", "host4"].map(id => [byId(id).protocol, byId(id).kind]),
      [[4, "vm"], [4, "vm"], [4, "vm"], [3, "vm"], [3, "vm"], [4, "host"]]);
    assert.deepEqual(view.capacity.p3, { runners: 1, openThreads: 2 },
      "the protocol-3 runner still enrolled and its unarchived threads (the archived one is not); the retired runner is not counted");
    const { vm: vmGroup } = view.capacity.p4;
    assert.deepEqual([vmGroup.slots, vmGroup.reserved, vmGroup.free], [view.pool.slots, view.pool.reserved, view.pool.free],
      "the pool is the p4 VM runners: neither p3 nor the host runner");
    assert.deepEqual(view.capacity.p4, {
      vm: { runners: 3, slots: 4 + 2 + 1, reserved: 1, free: 6, stale: ["stale"], unreported: ["mute"] },
      host: { runners: 1, slots: 2, reserved: 1, free: 1, stale: [], unreported: ["host4"] },
    }, "reserved slots are cubed's open threads (1), not the machines fresh reports hosting (2)");
    assert.equal(byId("fresh").report?.activeVms, 2);
    // The protocol-3 runner: its last report is readable as it was; it has no slots.
    const old3 = byId("old3");
    assert.deepEqual([old3.byName, old3.slots.allocatable, old3.slots.free, old3.slots.reserved], [false, false, 0, 2]);
    assert.deepEqual([old3.report?.softwareVersion, old3.report?.protocolVersion, old3.report?.retainedVms, old3.report?.fresh], ["0.8.4", 3, 6, false]);
    assert.match(old3.unknown.join("\n"), /protocol 3 \(cube-runner\) is no longer supported, so cubed does not contact this runner/);
    assert.equal(byId("host4").report, null);
    assert.match(byId("host4").unknown.join("\n"), /has not answered a probe/);
    const text = describeRunners(view);
    const first = text.split("\n")[0];
    assert.match(first, /^capacity: p4 \(protocol 4, berth\) VM runners \(the pool, which takes any thread that names no runner\) 6 of 7 slots free on 3 runners \(not current: node-stale from its last, stale report; node-mute never reported \(1 slot assumed\)\), host runners \(only threads started on the runner by name\) 1 of 2 slots free on 1 runner \(not current: node-host4 never reported \(bound from enrollment\)\)\./);
    assert.match(first, /not the machines a runner hosts\. 1 protocol-3 runners \(cube-runner, no longer supported: never contacted, no slots\) are still enrolled, with 2 unarchived threads\.$/);
    assert.match(text, /node-fresh[^]*reported: berth 0\.1\.0, protocol 4/, "a p4 runner's software is berth");
    assert.match(text, /node-old3 \(id old3\)\n  protocol-3 VM runner \(cube-runner\): NO LONGER SUPPORTED\. cubed never contacts it[^\n]*\n  contact: not contacted \(protocol 3\); last answer 24 h ago\n  last reported 24 h ago \(stale\): cube-runner 0\.8\.4, protocol 3, macos-aarch64 with HVF[^]*6 retained disks[^]*2 reserved by open threads of 2, not taking threads/);
    registry.close();
    console.log("ok: capacity by protocol (p4 vm the pool, p4 host by name, stale and unreported); a protocol-3 runner's row and last report readable, no slots, its unarchived threads counted");
  }

  // --- cubed: background probes, the API and OptChat's text ---
  const reports = new Map<string, TrustedRunnerHealth>([["node-old", { ...legacy }]]);
  const app = await createCubed({ state: path.join(root, "cubed"), models: createModels(), claude: null, gateway: null, runnerProbeIntervalMs: 20,
    runnerHealth: async target => { const health = reports.get(target.nodeId); if (!health) throw new Error("NODE_UNAVAILABLE"); return { ...health }; } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert(address && typeof address === "object");
    const observed = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/runners/observed`);
      assert.equal(response.status, 200);
      return await response.json() as ReturnType<typeof observeRunners>;
    };
    app.registry.enrollRunner(runner("old"));
    app.registry.enrollRunner(runner("gone"));
    app.registry.enrollRunner(p3("legacy3", 2));
    app.registry.recordRunnerProbe("legacy3", { health: p3Report }, 1_000);
    reports.set("node-legacy3", { ...p3Report, softwareVersion: "probed" });
    await until(() => app.registry.runnerStatuses().filter(row => row.id !== "legacy3").every(row => row.lastAttemptAt), "both berth runners are probed");
    let view = await observed();
    const old = view.runners.find(row => row.id === "old")!;
    assert.equal(old.report?.softwareVersion, "0.6.0");
    assert.equal(old.report?.platform, null, "a report without the hello's fields leaves the platform unknown");
    assert.match(old.unknown.join("\n"), /predates cubed keeping them/);
    assert.equal(view.runners.find(row => row.id === "gone")!.report, null);
    assert.deepEqual(view.runners.map(row => row.protocol), [4, 4, 3]);
    assert.deepEqual(view.capacity.p4.vm.unreported, ["gone"], "the background probe never reached it");

    // The runner updates itself: only its own report says so.
    reports.set("node-old", { ...legacy, softwareVersion: "0.8.0", maxActiveVms: 3, platform: "macos-aarch64", capabilities: ["node.status"], limits });
    await until(() => app.registry.runnerStatuses().find(row => row.id === "old")?.health?.softwareVersion === "0.8.0", "the new version is probed");
    view = await observed();
    const updated = view.runners.find(row => row.id === "old")!;
    assert.deepEqual([updated.report?.os, updated.report?.arch, updated.report?.accelerator, updated.slots.total], ["macos", "aarch64", "hvf", 3]);
    const text = describeRunners(view);
    assert.match(text, /berth 0\.8\.0, protocol 4, macos-aarch64 with HVF/);
    assert.match(text, /at most 3 at once \(its effective bound\)/);
    assert.match(text, /node-gone .*\n  protocol-4 VM runner \(berth vm\): in the pool[^\n]*\n  contact: unreachable/);
    // The protocol-3 runner was never probed: its last report is the one from before.
    const legacy3 = view.runners.find(row => row.id === "legacy3")!;
    assert.deepEqual([legacy3.report?.softwareVersion, legacy3.contact.lastAttemptAt], ["0.8.4", 1_000], "cubed never contacted the protocol-3 runner");
    assert.match(text, /node-legacy3 [^]*NO LONGER SUPPORTED/);
    assert.match(text, /capacity mode: whether --max-active-vms is auto/);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/runners/observed`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "read-only");
    console.log("ok: runner observation (reports, staleness, slots, unknowns, API)");
  } finally { await app.close(); }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
