import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
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
  assert.deepEqual(await (await fetch(`${base}/api/jev`)).json(), { configured: false });
  const jevSecret = "jev-secret-not-for-responses";
  const savedJev = await write("/api/jev", { apiKey: jevSecret }, "PUT");
  const savedJevText = await savedJev.text();
  assert.equal(savedJev.status, 200); assert(!savedJevText.includes(jevSecret));
  assert.deepEqual(JSON.parse(savedJevText), { configured: true });
  assert.equal(fs.statSync(path.join(state, "jev-key.json")).mode & 0o777, 0o600);
  assert.deepEqual(await (await write("/api/jev", {}, "DELETE")).json(), { configured: false });
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
  const acceptedBody = await accepted.json();
  assert.equal(typeof acceptedBody.id, "string");
  assert.notEqual(acceptedBody.id, "broken-thread");
  assert.deepEqual(await (await write("/api/threads", input)).json(), acceptedBody);
  const { threads } = await (await fetch(`${base}/api/threads`)).json();
  assert.equal(threads.length, 1); assert.equal(threads[0].state, "error");
  assert.match(threads[0].error, /workspace allocation failed.*IO_ERROR/);
  assert.equal((await fetch(`${base}/api/threads/broken-thread/history/extra`)).status, 404);
  for (const host of [undefined, "0.0.0.0"]) {
    const directory = path.join(state, host ?? "default");
    fs.mkdirSync(directory);
    const child = spawn(process.execPath, [path.resolve("packages/server/src/index.ts")], {
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: directory, CUBED_STATE: directory, CUBED_PORT: "0",
        ...(host ? { CUBED_HOST: host, CUBED_ALLOWED_HOSTS: "cube.tailnet.example,100.64.0.2" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "";
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      let listener: RegExpMatchArray | null = null;
      for await (const [chunk] of on(child.stdout, "data", { signal: AbortSignal.timeout(15000) })) {
        output += String(chunk);
        listener = output.match(/cubed listening on ([\d.]+):(\d+);/);
        if (listener) break;
      }
      assert(listener, output);
      assert.equal(listener[1], host ?? "127.0.0.1", "CLI must bind the configured address and default to loopback");
      const url = `http://127.0.0.1:${listener[2]}/api/providers`;
      assert.equal((await fetch(url)).status, 200);
      // Node fetch overrides Host; use raw HTTP to exercise the actual header.
      const status = (authority: string, origin?: string) => new Promise<number | undefined>((resolve, reject) => {
        http.get(url, { headers: { host: authority, ...(origin ? { origin } : {}) } }, response => {
          response.resume(); resolve(response.statusCode);
        }).on("error", reject);
      });
      for (const name of ["cube.tailnet.example", "100.64.0.2"]) {
        const authority: string = `${name}:${listener[2]}`;
        assert.equal(await status(authority, `http://${authority}`), host ? 200 : 403);
        assert.equal(await status(authority, "http://untrusted.example"), 403);
      }
      assert.equal(await status("untrusted.example"), 403);
    } finally { child.kill("SIGTERM"); await closed; }
  }
  console.log("ok: actual CLI loopback default and all-IPv4 opt-in; explicit private hosts allowed, unknown hosts/cross-origin rejected");
  console.log("ok: host/origin and JSON guards, method/path routing, repository validation, durable allocation despite failed activation");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
