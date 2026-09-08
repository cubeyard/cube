/**
 * Manual smoke test for declared services + portals end to end on real
 * Incus: provision a cube, declare [services.web] in .cube/cube.toml,
 * ensure (systemd unit in the cube, readiness probe, portal registry),
 * proxy a request through a Host-routed listener, verify the in-cube
 * hairpin (curl the portal origin from INSIDE the cube — the mock-OAuth
 * issuer path), then sleep + re-ensure to prove wake-on-request heals the
 * service. Needs Incus + the cube-node image.
 *
 *   sg incus-admin -c "node packages/server/test/services-smoke.ts"
 */
// High subnet band: never collide with the production daemon's bridges.
process.env.CUBED_SUBNET_MIN ??= "200";

import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { IncusBackend, IncusClient, IncusSandbox, destroyCube } from "@cube/sandbox";

import { portalLabel, proxyHttp } from "../src/portal-proxy.ts";
import { Registry, networkForCube } from "../src/registry.ts";
import { CubeSupervisor, DEFAULT_EGRESS_ALLOW } from "../src/supervisor.ts";

const NAME = "svctest";
const PUBLIC_PORT = 17777;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-svcsmoke-"));
const incus = new IncusClient();
const registry = new Registry(path.join(tmp, "cubed.db"));
const supervisor = new CubeSupervisor(registry, new IncusBackend(incus), {
  cubesRoot: path.join(tmp, "cubes"),
  reposRoot: path.join(tmp, "repos"),
  pool: "cube",
  image: process.env.CUBE_IMAGE ?? "cube-node",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  egressAllow: DEFAULT_EGRESS_ALLOW,
  idleMs: 0,
  prefer: [
    ["openai-codex", "gpt-5.6-luna"],
    ["deepseek", "deepseek-v4-pro"],
  ],
  portalBase: "cube.internal",
  publicPort: PUBLIC_PORT,
});

// Clean slate from previous aborted runs.
await destroyCube(
  incus,
  { name: `cube-${NAME}`, pool: "cube", network: { bridge: `cbr-${NAME}` } },
  { deleteVolume: true, deleteBridge: true },
);

console.log("== provision ==");
supervisor.createCube(NAME);
for (;;) {
  const status = registry.getCube(NAME)!.status;
  if (status === "ready") break;
  if (status === "error") throw new Error(`provision failed: ${registry.getCube(NAME)!.error}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("cube ready");

// The declaration an agent would write. python3 -m http.server honors
// $PORT via bash expansion and binds 0.0.0.0 explicitly.
const workspace = registry.getCube(NAME)!.workspacePath;
fs.mkdirSync(path.join(workspace, ".cube"), { recursive: true });
fs.writeFileSync(path.join(workspace, "hello.txt"), "hello from the cube\n");
fs.writeFileSync(
  path.join(workspace, ".cube", "cube.toml"),
  `[services.web]\ncommand = "python3 -m http.server $PORT --bind 0.0.0.0"\n`,
);

console.log("== ensure ==");
const statuses = await supervisor.ensureCubeServices(NAME);
console.log(statuses);
assert.equal(statuses.length, 1);
assert.equal(statuses[0]!.state, "running");
assert.equal(statuses[0]!.url, `http://web--${NAME}.cube.internal:${PUBLIC_PORT}`);
const target = supervisor.resolvePortal(`web--${NAME}`)!;
assert.equal(target.status, "ready");

console.log("== Host-routed proxy ==");
const front = http.createServer((req, res) => {
  const label = portalLabel(req.headers.host, "cube.internal");
  if (label === null) {
    res.writeHead(421);
    return void res.end();
  }
  const live = supervisor.resolvePortal(label);
  if (!live) {
    res.writeHead(404);
    return void res.end();
  }
  proxyHttp(req, res, live, () => {
    res.writeHead(503);
    res.end();
  });
});
await new Promise<void>((r) => front.listen(PUBLIC_PORT, "0.0.0.0", r));

const viaProxy = await new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.request(
    {
      host: "127.0.0.1",
      port: PUBLIC_PORT,
      path: "/hello.txt",
      agent: false,
      headers: { host: `web--${NAME}.cube.internal:${PUBLIC_PORT}` },
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    },
  );
  req.on("error", reject);
  req.end();
});
assert.equal(viaProxy.status, 200);
assert.equal(viaProxy.body, "hello from the cube\n");
console.log("proxy ok: /hello.txt served through the Host-routed listener");

console.log("== in-cube hairpin (the mock-OAuth issuer path) ==");
const sandbox = new IncusSandbox(`cube-${NAME}`, incus);
let out = "";
const { exitCode } = await sandbox.exec(
  `curl -sf http://web--${NAME}.cube.internal:${PUBLIC_PORT}/hello.txt`,
  { cwd: "/workspace", onData: (c) => (out += c.toString("utf8")), timeout: 30 },
);
assert.equal(exitCode, 0, `in-cube curl failed: ${out}`);
assert.equal(out.trim(), "hello from the cube");
console.log("hairpin ok: portal origin resolves + connects from inside the cube");

console.log("== sleep, then ensure heals the service (wake-on-request path) ==");
await supervisor.sleepCube(NAME);
assert.equal(registry.getCube(NAME)!.status, "asleep");
const healed = await supervisor.ensureCubeServices(NAME);
assert.equal(healed[0]!.state, "running");
const again = await new Promise<number>((resolve, reject) => {
  const req = http.request(
    {
      host: "127.0.0.1",
      port: PUBLIC_PORT,
      path: "/hello.txt",
      agent: false,
      headers: { host: `web--${NAME}.cube.internal:${PUBLIC_PORT}` },
    },
    (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    },
  );
  req.on("error", reject);
  req.end();
});
assert.equal(again, 200);
console.log("wake+ensure ok: service is back after incus stop");

console.log("== teardown ==");
front.close();
await supervisor.removeCube(NAME, { deleteVolume: true });
assert.equal(registry.getCube(NAME), null);
await supervisor.close();
registry.close();
console.log("services-smoke: all ok");
process.exit(0);
