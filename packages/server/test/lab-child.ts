/** Lab: one cubed process on an existing lab state, killed from outside. argv: scratch tps slots */
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";
import { labModels } from "./lab-host.ts";

const [scratch, tps, slots] = process.argv.slice(2);
const made = labModels(Number(tps));
const machines = new LocalMachines(path.join(scratch!, "machines"));
const app = await createCubed({ state: path.join(scratch!, "state"), models: made.models, machines, claude: null, gateway: null, portal: null, skillSource: null });
if (app.registry.runnerCount() === 0) {
  app.registry.enrollRunner({ nodeId: "node-lab", environmentId: 1, threadId: "runner-lab", configPath: "/private/lab.json", configHash: "lab", maxActiveVms: Number(slots), protocol: 4, kind: "vm" });
}
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
process.stdout.write(`${JSON.stringify({ port: (app.server.address() as AddressInfo).port, model: made.model })}\n`);
