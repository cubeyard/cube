/** Read-only runner observation: what a runner reported, how fresh it is,
 * cubed's slots, and what stays unknown. Runner reports are faked; the
 * hello fields themselves are covered in iroh-node-test.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { TrustedRunnerHealth, VmLimits } from "../src/iroh-node.ts";
import { Registry, type Project } from "../src/registry.ts";
import { describeRunners, NOT_REPORTED, observeRunners } from "../src/runner-observe.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-observe-"));
const limits: VmLimits = { maxFrameBytes: 1 << 20, requestTimeoutMs: 30_000, maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64, maxSeedBytes: 65536, maxActiveVms: 2 };
// What cubed recorded before it kept the hello's fields.
const legacy: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.6.0", protocolVersion: 3 };
const runner = (id: string, maxActiveVms?: number) => ({ nodeId: `node-${id}`, environmentId: 1, threadId: id,
  configPath: path.join(root, `${id}.json`), configHash: id, ...(maxActiveVms ? { maxActiveVms } : {}) });
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
    assert.match(silent.unknown.join("\n"), /has not answered a probe/);
    assert.deepEqual(view.notReported, NOT_REPORTED);

    const at = 1_000_000;
    registry.recordRunnerProbe("wide", { health: { ...legacy, softwareVersion: "0.8.0", maxActiveVms: 2, activeVms: 2, runningVms: 2,
      platform: "linux-x86_64", capabilities: ["node.hello", "node.status", "vm.publish"], limits } }, at);
    registry.createThread("p", "one", { provider: "fixture", id: "m" }, "one");
    registry.createThread("p", "two", { provider: "fixture", id: "m" }, "two");
    view = observeRunners(registry, 60_000, at + 30_000);
    const wide = view.runners.find(row => row.id === "wide")!;
    assert.equal(wide.report?.fresh, true);
    assert.equal(wide.report?.softwareVersion, "0.8.0");
    assert.deepEqual([wide.report?.os, wide.report?.arch, wide.report?.accelerator], ["linux", "x86_64", "kvm"]);
    assert.deepEqual(wide.report?.vmLimits, { maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64 });
    assert.equal(wide.slots.totalSource, "reported");
    assert.equal(wide.slots.total, 2);
    // Two threads went to the wider runner; the silent one is assumed to have one slot.
    assert.equal(wide.slots.reserved + view.runners.find(row => row.id === "silent")!.slots.reserved, 2);
    assert.deepEqual(wide.unknown, [], "a fresh, complete report leaves only the protocol's unknowns");

    // Without a newer probe the same report grows stale.
    const old = observeRunners(registry, 60_000, at + 10 * 60_000).runners.find(row => row.id === "wide")!;
    assert.equal(old.report?.fresh, false);
    assert.match(old.unknown.join("\n"), /not the runner's state now/);
    assert.match(describeRunners(observeRunners(registry, 60_000, at + 10 * 60_000)), /last reported 10 min ago \(stale\): cube-runner 0\.8\.0/);

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
    assert.deepEqual([retiring.pool.runners, retiring.pool.allocatable], [4, 3], "retired runners leave the pool, retiring ones take no threads");
    const text = describeRunners(retiring);
    assert.match(text, /node-leaving \(id leaving; retiring\)[^]*not taking threads/);
    assert.ok(!text.includes("node-done"), "a retired runner is not listed");
    // A probe failure that names a local file stays out of the model's text.
    registry.recordRunnerProbe("silent", { error: "ENOENT: no such file or directory, open '/private/silent.json'" }, at);
    assert.match(describeRunners(observeRunners(registry, 60_000, at + 1000)), /node-silent[^]*unreachable since 1 s ago \(probe failed; details in \/api\/runners\)/);
    assert.ok(!describeRunners(observeRunners(registry, 60_000, at + 1000)).includes("/private/"));
    registry.close();
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
    await until(() => app.registry.runnerStatuses().every(row => row.lastAttemptAt), "both runners are probed");
    let view = await observed();
    const old = view.runners.find(row => row.id === "old")!;
    assert.equal(old.report?.softwareVersion, "0.6.0");
    assert.equal(old.report?.platform, null, "a report without the hello's fields leaves the platform unknown");
    assert.match(old.unknown.join("\n"), /predates cubed keeping them/);
    assert.equal(view.runners.find(row => row.id === "gone")!.report, null);

    // The runner updates itself: only its own report says so.
    reports.set("node-old", { ...legacy, softwareVersion: "0.8.0", maxActiveVms: 3, platform: "macos-aarch64", capabilities: ["node.status"], limits });
    await until(() => app.registry.runnerStatuses().find(row => row.id === "old")?.health?.softwareVersion === "0.8.0", "the new version is probed");
    view = await observed();
    const updated = view.runners.find(row => row.id === "old")!;
    assert.deepEqual([updated.report?.os, updated.report?.arch, updated.report?.accelerator, updated.slots.total], ["macos", "aarch64", "hvf", 3]);
    const text = describeRunners(view);
    assert.match(text, /cube-runner 0\.8\.0, protocol 3, macos-aarch64 with HVF/);
    assert.match(text, /at most 3 at once \(its effective bound\)/);
    assert.match(text, /node-gone .*\n  contact: unreachable/);
    assert.match(text, /capacity mode: whether --max-active-vms is auto/);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/runners/observed`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "read-only");
    console.log("ok: runner observation (reports, staleness, slots, unknowns, API)");
  } finally { await app.close(); }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
