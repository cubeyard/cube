/** Run as the control-plane operator with cubed stopped, never as an agent tool.
 * Does not initialize, provision, seed, execute on, or modify the trusted runner. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { Registry } from "../packages/server/src/registry.ts";
import { IrohExecutionNodeClient } from "../packages/server/src/iroh-node.ts";

const { values } = parseArgs({ options: {
  database: { type: "string" }, project: { type: "string" }, config: { type: "string" },
  "cubes-root": { type: "string" }, "trusted-runner": { type: "boolean" },
  // Deprecated input retained for cube-host 0.1.1 operator automation.
  "trusted-host": { type: "boolean" }, "server-stopped": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (!values.database || !values.project || !values.config || !values["cubes-root"]
  || !(values["trusted-runner"] || values["trusted-host"]) || !values["server-stopped"]
  || ![values.database, values.config, values["cubes-root"]].every(p => path.isAbsolute(p))) {
  throw new Error("usage: node scripts/enroll-runner.ts --database /abs/cubed.db --project PROJECT --config /abs/private-runner.json --cubes-root /abs/cubes --trusted-runner --server-stopped");
}
if (!fs.lstatSync(values.database).isFile()) throw new Error("existing control-plane registry required");
if (values["trusted-host"]) console.error("cube: --trusted-host is deprecated; use --trusted-runner");

const program = Effect.scoped(Effect.gen(function*() {
  const client = new IrohExecutionNodeClient({ configPath: values.config! });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => new Registry(values.database!)),
    registry => Effect.sync(() => registry.close()),
  );
  if (!registry.getProject(values.project!)) throw new Error("existing project required");
  const { environmentId, threadId, nodeId } = client.binding;
  if (registry.getCubeById(environmentId) || registry.getThread(threadId)
    || registry.trustedRunnerAdmissions().some(row => row.nodeId === nodeId)
    || nodeId === registry.localNodeId) throw new Error("fresh runner, environment and thread identities required");
  yield* Effect.promise(() => client.status(environmentId)); // authenticate the full immutable binding
  const name = `t-${randomUUID().slice(0, 8)}`;
  const root = path.join(values["cubes-root"]!, name);
  if (fs.existsSync(root)) throw new Error("new control-plane metadata directory required");
  registry.enrollTrustedRunner({ nodeId, environmentId, threadId, configPath: values.config!, configHash: client.configHash,
    projectId: values.project!, name, workspacePath: path.join(root, "workspace"),
    piSessionPath: path.join(root, "sessions", `${threadId}.jsonl`) });
  console.log(JSON.stringify({ nodeId, environmentId, threadId, name, profile: "trusted-runner", admitted: true,
    next: "start cubed; open the new thread; runner file/repository transfer is not yet supported" }));
}));

await Effect.runPromise(program);
