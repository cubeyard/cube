/** Explicit operator admission; never provisions or modifies the runner. */
import path from "node:path";
import { parseArgs } from "node:util";
import { Registry } from "../packages/server/src/registry.ts";
import { IrohExecutionNodeClient } from "../packages/server/src/iroh-node.ts";

const { values } = parseArgs({ options: {
  state: { type: "string" }, project: { type: "string" }, config: { type: "string" },
  "trusted-runner": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (!values.state || !values.project || !values.config || !values["trusted-runner"]
  || ![values.state, values.config].every(p => path.isAbsolute(p))) {
  throw new Error("usage: node scripts/enroll-runner.ts --state /abs/host-state --project PROJECT --config /abs/private-runner.json --trusted-runner");
}
const client = new IrohExecutionNodeClient({ configPath: values.config });
const registry = new Registry(path.join(values.state, "registry.sqlite"));
try {
  await client.status(client.binding.environmentId);
  registry.enrollRunner({ ...client.binding, configPath: values.config, configHash: client.configHash, projectId: values.project });
  console.log(JSON.stringify({ ...client.binding, profile: "trusted-runner", admitted: true,
    next: "start a thread in this project; its workspace must already be prepared on the runner" }));
} finally { registry.close(); }
