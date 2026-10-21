import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { TrustedRunnerHealth } from "../src/runner-types.ts";

// A runner that updates itself must show its new version without anyone
// pressing check: cubed probes enrolled runners in the background. A
// protocol-3 runner (retired) is never probed.
const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-probe-"));
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.6.0", protocolVersion: 4, kind: "vm" };
const asked: string[] = [];
let reachable = true;
const app = await createCubed({ state, models: createModels(), claude: null, gateway: null, runnerProbeIntervalMs: 20,
  runnerHealth: async runner => { asked.push(runner.nodeId); if (!reachable) throw new Error("NODE_UNAVAILABLE"); return { ...health }; } });
const view = () => app.registry.runnerStatuses().find(runner => runner.id === "probe-binding")!;
const until = async (test: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(test(), what);
};
try {
  app.registry.enrollRunner({ nodeId: "node-probe", threadId: "probe-binding", environmentId: 1,
    configPath: path.join(state, "probe.json"), configHash: "probe", protocol: 4, kind: "vm" });
  app.registry.enrollRunner({ nodeId: "node-p3", threadId: "p3-binding", environmentId: 2, configPath: path.join(state, "p3.json"), configHash: "p3" });
  await until(() => view().health?.softwareVersion === "0.6.0", "an enrolled runner is probed without a manual check");
  health.softwareVersion = "0.8.0"; health.activeVms = 1; health.runningVms = 1;
  await until(() => view().health?.softwareVersion === "0.8.0", "a self-updated runner shows its new version");
  assert.equal(view().health?.activeVms, 1);
  reachable = false;
  await until(() => view().contactStatus === "unreachable", "an unreachable runner is shown as such");
  assert.ok(asked.length >= 3 && asked.every(node => node === "node-probe"), `the protocol-3 runner is never probed: ${asked.join(" ")}`);
  assert.equal(app.registry.runnerStatuses().find(runner => runner.id === "p3-binding")!.lastAttemptAt, null);
  console.log("ok: cubed probes enrolled runners in the background (version, machines, reachability), never a protocol-3 runner");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
