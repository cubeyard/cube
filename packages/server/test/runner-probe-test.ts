import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { TrustedRunnerHealth } from "../src/iroh-node.ts";

// A runner that updates itself must show its new version without anyone
// pressing check: cubed probes enrolled runners in the background.
const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-probe-"));
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.6.0", protocolVersion: 3 };
let reachable = true;
const app = await createCubed({ state, models: createModels(), claude: null, gateway: null, runnerProbeIntervalMs: 20,
  runnerHealth: async () => { if (!reachable) throw new Error("NODE_UNAVAILABLE"); return { ...health }; } });
const view = () => app.registry.runnerStatuses().find(runner => runner.id === "probe-binding")!;
const until = async (test: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(test(), what);
};
try {
  app.registry.enrollRunner({ nodeId: "node-probe", threadId: "probe-binding", environmentId: 1,
    configPath: path.join(state, "probe.json"), configHash: "probe" });
  await until(() => view().health?.softwareVersion === "0.6.0", "an enrolled runner is probed without a manual check");
  health.softwareVersion = "0.8.0"; health.activeVms = 1; health.runningVms = 1;
  await until(() => view().health?.softwareVersion === "0.8.0", "a self-updated runner shows its new version");
  assert.equal(view().health?.activeVms, 1);
  reachable = false;
  await until(() => view().contactStatus === "unreachable", "an unreachable runner is shown as such");
  console.log("ok: cubed probes enrolled runners in the background (version, machines, reachability)");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
