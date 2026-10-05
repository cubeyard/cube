/** Explicit operator admission; never provisions or modifies the runner.
 * The runner config is version 2 (protocol 3, VM runners):
 * {"version":2,"binding":{"nodeId","threadId","environmentId"},"controlKey":"/abs/control.key",
 *  "serverPeer":"<runner peer>","network":"loopback|direct|relay","address":"host:port"} (no address for relay), mode 0600. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Registry } from "../packages/server/src/registry.ts";
import { IrohRunnerClient } from "../packages/server/src/iroh-node.ts";

const { values } = parseArgs({ options: {
  state: { type: "string" }, config: { type: "string" },
  "trusted-runner": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (!values.state || !values.config || !values["trusted-runner"]
  || ![values.state, values.config].every(p => path.isAbsolute(p))) {
  throw new Error("usage: node scripts/enroll-runner.ts --state /abs/host-state --config /abs/private-runner.json --trusted-runner");
}
const client = new IrohRunnerClient({ configPath: values.config });
const registry = new Registry(path.join(values.state, "registry.sqlite"));
try {
  // Each runner needs its own control identity: cubed serializes calls per
  // runner, and two endpoints publishing one Iroh identity break each other
  // (relay especially).
  const controlKey = (configPath: string) => {
    try { return fs.readFileSync(JSON.parse(fs.readFileSync(configPath, "utf8")).controlKey); } catch { return undefined; }
  };
  const mine = controlKey(values.config);
  const retired = new Set(registry.runnerStatuses().filter(status => status.retiredAt).map(status => status.id));
  const shared = registry.listRunners().find(runner => runner.nodeId !== client.binding.nodeId && !retired.has(runner.threadId)
    && mine && controlKey(runner.configPath)?.equals(mine));
  if (shared) throw new Error(`control key already used by runner ${shared.nodeId}; create a separate control key for each runner`);
  // An authenticated protocol-3 hello: a protocol-2 runner is refused here.
  const described = await client.describe();
  const health = await client.health();
  registry.enrollRunner({ ...client.binding, configPath: values.config, configHash: client.configHash });
  console.log(JSON.stringify({ ...client.binding, profile: "vm-runner", admitted: true, softwareVersion: described.softwareVersion,
    platform: described.platform, baseImageSha256: described.baseImageSha256, maxActiveVms: health.maxActiveVms,
    next: "restart cubed if this runner's network mode is wider than the others; start a thread in any ready project" }));
} finally { registry.close(); }
