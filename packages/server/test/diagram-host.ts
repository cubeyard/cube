/** cubed for the diagram browser test: one artifact whose revision was
 * written before cubed checked diagrams (straight into the store), with a
 * diagram that draws and one that does not. No model, no runner; disposable
 * state. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import { LocalMachines } from "./local-guest.ts";

export async function startDiagramHost(options: { web: string; body: string; title: string }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-diagram-browser-"));
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  const seed = new ArtifactStore(path.join(state, "artifacts.sqlite"));
  const id = seed.write({ kind: "optchat" }, { title: options.title, body: options.body, projectId: null }, { agent: "optchat" }, "seed").revision.artifact;
  seed.close();
  const app = await createCubed({ state, models: createModels(), machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null, web: options.web });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  await fetch(`${url}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { url, id,
    async close() { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
