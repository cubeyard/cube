import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-api-"));
const models = createModels();
const faux = fauxProvider(); models.setProvider(faux.provider);
const app = await createCubed({ state, models });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const write = (route: string, body: unknown, method = "POST") => fetch(`${base}${route}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
try {
  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { host: "untrusted.example" } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { origin: "http://untrusted.example" } })).status, 403);
  assert.equal((await write("/api/models", {})).status, 404);
  assert.equal((await write("/api/github/auth", {}, "PUT")).status, 404);
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST", body: "{}" })).status, 415);
  for (const repositories of [[null], [{ url: "org/repo", base: {} }], [{ url: "org/repo", checkoutName: "../outside" }]]) {
    assert.equal((await write("/api/projects", { name: "invalid", repositories })).status, 409);
  }
  assert.equal(app.registry.listProjects().length, 0, "invalid input must not allocate metadata");
  const created = await write("/api/projects", { name: "fresh", repositories: [] });
  assert.equal(created.status, 200);
  const { project } = await created.json();
  assert.equal(project.availableRunnerCount, 0);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/nonsense`, { method: "DELETE" })).status, 404);
  assert(app.registry.getProject(project.id), "unknown subroute must not delete project");
  const input = { projectId: project.id, requestId: "retry", text: "inspect workspace", model: { provider: faux.getModel().provider, id: faux.getModel().id } };
  assert.equal((await write("/api/threads", input)).status, 409);
  app.registry.enrollRunner({ projectId: project.id, nodeId: "broken-node", threadId: "broken-thread", environmentId: 1,
    configPath: path.join(state, "absent.json"), configHash: "missing" });
  const accepted = await write("/api/threads", input);
  assert.equal(accepted.status, 200, "activation failure must not lose accepted allocation");
  assert.deepEqual(await accepted.json(), { id: "broken-thread" });
  assert.deepEqual(await (await write("/api/threads", input)).json(), { id: "broken-thread" });
  const { threads } = await (await fetch(`${base}/api/threads`)).json();
  assert.equal(threads.length, 1); assert.equal(threads[0].state, "error");
  assert.match(threads[0].error, /IO_ERROR/);
  assert.equal((await fetch(`${base}/api/threads/broken-thread/history/extra`)).status, 404);
  console.log("ok: host/origin and JSON guards, method/path routing, repository validation, durable allocation despite failed activation");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
