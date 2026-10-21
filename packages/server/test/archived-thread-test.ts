/**
 * An archived thread takes no new work: its prompt, history and stop routes
 * answer 404 "thread not found", while its retained disk can still be
 * discarded. runner-vm-cubed-test's G1 step (cubed closes mid-command, the
 * command is reattached) once prompted a thread it had archived earlier and
 * failed here, with this answer, on its first native run (server1 S4,
 * candidate 8a434535): a real-VM step must prompt a live thread.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-archived-"));
const models = createModels();
const faux = fauxProvider(); models.setProvider(faux.provider);
const app = await createCubed({ state, models, claude: null, gateway: null });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const call = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
try {
  app.registry.enrollRunner({ nodeId: "node-archived", threadId: "runner-archived", environmentId: 1, configPath: "/private/archived.json", configHash: "archived", protocol: 4, kind: "vm" });
  const project = (await call("/api/projects", "POST", { name: "archived", repositories: [] })).body.project as { id: string };
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  // Archived first: that frees the runner's one slot for the live thread.
  const gone = app.registry.createThread(project.id, "gone", model, "hello", "pi");
  app.registry.finishRelease(gone.id);
  const live = app.registry.createThread(project.id, "live", model, "hello", "pi");

  // A live thread's routes are found (whatever its machine is doing).
  assert.notEqual((await call(`/api/threads/${live.id}/history`)).status, 404, "a live thread's history is found");

  // The archived one: the exact answer S4 got, for every route a turn uses.
  const prompt = await call(`/api/threads/${gone.id}/prompt`, "POST", { text: "tool {}", requestId: "ca-1" });
  assert.deepEqual([prompt.status, prompt.body], [404, { error: "thread not found" }], "an archived thread takes no prompt");
  assert.deepEqual((await call(`/api/threads/${gone.id}/history`)).status, 404, "nor gives its history to a turn");
  assert.deepEqual((await call(`/api/threads/${gone.id}/stop`, "POST", {})).status, 404, "nor a stop");
  assert.equal(faux.state.callCount, 0, "no model call for an archived thread");
  console.log("ok: an archived thread answers 404 thread not found to prompt, history and stop; a real-VM step must prompt a live thread");
} finally {
  app.server.closeAllConnections();
  await app.close();
  fs.rmSync(state, { recursive: true, force: true });
}
