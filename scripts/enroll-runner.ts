/** Explicit operator admission; never provisions or modifies the runner.
 * The same as `cubed runners enroll --config … --state …` (packages/server/src/runner-enroll.ts).
 * The runner config is version 2 (protocol 3, VM runners):
 * {"version":2,"binding":{"nodeId","threadId","environmentId"},"controlKey":"/abs/control.key",
 *  "serverPeer":"<runner peer>","network":"loopback|direct|relay","address":"host:port"} (no address for relay), mode 0600. */
import path from "node:path";
import { parseArgs } from "node:util";
import { enrollRunner } from "../packages/server/src/runner-enroll.ts";

const { values } = parseArgs({ options: {
  state: { type: "string" }, config: { type: "string" },
  "trusted-runner": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (!values.state || !values.config || !values["trusted-runner"]
  || ![values.state, values.config].every(p => path.isAbsolute(p))) {
  throw new Error("usage: node scripts/enroll-runner.ts --state /abs/host-state --config /abs/private-runner.json --trusted-runner");
}
console.log(JSON.stringify(await enrollRunner({ state: values.state, configPath: values.config })));
