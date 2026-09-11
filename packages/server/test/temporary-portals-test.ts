/** Temporary routes: real SQLite/supervisor and HTTP API, no Incus required. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MockBackend } from "@cube/sandbox";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor } from "../src/supervisor.ts";
import { ensureServices } from "../src/services.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-portals-"));
const dbPath = path.join(tmp, "cubed.db");
const registry = new Registry(dbPath);
const config = {
  cubesRoot: path.join(tmp, "cubes"), reposRoot: path.join(tmp, "repos"),
  pool: "mock", image: "mock", rootSize: "1MiB", dockerVolumeSize: "1MiB",
  egressAllow: [], idleMs: 0, environmentCache: false,
  portalBase: "127.0.0.1.sslip.io", publicPort: 7777,
};
const supervisor = new CubeSupervisor(registry, new MockBackend(), config);
let daemon: ReturnType<typeof spawn> | undefined;
try {
  registry.createProject({ id: "project", name: "portals", repositories: [] });
  const fixtures = ["alpha", "beta"].map((name) => {
    const workspacePath = path.join(config.cubesRoot, name, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const cube = registry.createCube({ name, image: "mock", workspacePath, environment: "reference/env" });
    registry.addThread({ id: name, cubeId: cube.id, projectId: "project", piSessionPath: path.join(tmp, `${name}.jsonl`) });
    registry.setCubeStatus(name, "ready");
    return cube;
  });
  const expose = (input: unknown) => supervisor.exposePortalForUserThread("alpha", input);
  for (const input of [null, [], {}, { port: "3000", name: "test" },
    ...[0, 65536, 1.5, NaN].map((port) => ({ port, name: "test" })),
    { port: 3000, name: " " }, { port: 3000, name: "x".repeat(81) },
    { port: 3000, name: "test", lifetime: null }, { port: 3000, name: "test", lifetime: "forever" },
    { port: 3000, name: "test", host: "127.0.0.1" }, { port: 3000, name: "test", threadId: "beta" },
  ]) assert.throws(() => expose(input));
  assert.deepEqual(supervisor.listPortalsForUserThread("alpha"), []);
  for (const port of [1, 65535]) {
    assert.equal(expose({ port, name: "boundary" }).port, port);
    supervisor.removePortalForUserThread("alpha", port);
  }
  const portal = expose({ port: 3000, name: " Testportal " });
  assert.deepEqual(portal, {
    port: 3000, name: "Testportal", lifetime: "thread", supervised: false,
    url: "http://temporary--3000--alpha.127.0.0.1.sslip.io:7777",
  });
  assert.equal(expose({ port: 3000, name: "renamed" }).url, portal.url);
  const label = "temporary--3000--alpha";
  assert.deepEqual(supervisor.resolvePortal(label), {
    cubeName: "alpha", serviceName: "renamed", status: "ready",
    ip: "10.90.10.10", port: 3000, supervised: false,
  });
  supervisor.exposePortalForUserThread("beta", { port: 3000, name: "sibling" });
  supervisor.removePortalForUserThread("beta", 3000);
  assert.ok(supervisor.resolvePortal(label), "sibling removal cannot revoke alpha's route");
  // No read of the missing read-only reference environment was needed.
  assert.equal(fs.existsSync(path.join(fixtures[0]!.workspacePath, ".cube")), false);
  // Service reconciliation sees only supervised rows, so an empty declaration
  // cannot stop or remove this independently owned temporary process/route.
  assert.deepEqual(await ensureServices({
    cubeIp: "10.90.10.10", gatewayIp: "10.90.10.1", portalBase: config.portalBase,
    publicUrl: (label) => supervisor.portalUrl(label),
    execRoot: async () => { throw new Error("must not exec for temporary portals"); },
    upsertPortal: (name, port, hostname) => registry.upsertPortal(fixtures[0]!.id, name, port, hostname),
    releasePortal: (name) => registry.releasePortal(fixtures[0]!.id, name),
    listPortals: () => registry.listPortals(fixtures[0]!.id),
  }, "alpha", []), []);
  assert.ok(supervisor.resolvePortal(label));
  const reopened = new Registry(dbPath);
  assert.equal(reopened.getTemporaryPortal(label)?.name, "renamed");
  reopened.close();

  // Exercise the actual route matcher and status mapping against disposable
  // state. Boot may demote the fixture; mark it ready only after boot finishes.
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  daemon = spawn(process.execPath, ["--input-type=module", "-e", `
    import { MockBackend } from "@cube/sandbox";
    const destroy = MockBackend.prototype.destroy;
    MockBackend.prototype.destroy = async function (...args) {
      if (args[0].name === "cube-beta") {
        await new Promise((resolve) => {
          process.once("message", resolve);
          process.send("destroy entered");
        });
      }
      return destroy.apply(this, args);
    };
    await import("./src/index.ts");
  `], {
    cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, CUBED_BACKEND: "mock", CUBED_DB: dbPath,
      CUBED_CUBES_ROOT: config.cubesRoot, CUBED_REPOS_ROOT: config.reposRoot,
      CUBED_PORT: String(port), CUBED_PORTAL_BASE: config.portalBase,
      CUBED_IDLE_MS: "0", CUBED_ENVIRONMENT_CACHE: "0" },
  });
  let logs = "";
  daemon.stdout!.on("data", (chunk) => { logs += chunk; });
  daemon.stderr!.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; ; n++) {
    try { if ((await fetch(`${base}/api/threads/alpha/portals`)).ok) break; } catch { /* booting */ }
    assert.ok(n < 200 && daemon.exitCode === null, `daemon did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  registry.setCubeStatus("alpha", "ready");
  const post = (input: unknown) => fetch(`${base}/api/threads/alpha/portals`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal((await post({ port: 3000, name: "HTTP portal" })).status, 200);
  assert.equal((await post({ port: 3000, name: "test", host: "example.org" })).status, 400);
  assert.equal((await post({ port: 65536, name: "test" })).status, 400);
  assert.equal((await fetch(`${base}/api/threads/alpha/portals/3000/junk`, { method: "DELETE" })).status, 404);
  registry.setCubeStatus("alpha", "asleep");
  assert.equal((await post({ port: 3000, name: "test" })).status, 409);
  // node:fetch does not preserve a supplied Host; HTTP routing tests must.
  const requestPortal = (upgrade = false, portalLabel = label) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = http.get(base, { headers: {
      host: `${portalLabel}.${config.portalBase}:${port}`, accept: "text/html",
      ...(upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {}),
    } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, text }));
      response.on("error", reject);
    }).on("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("portal request timed out")));
  });
  const down = await requestPortal();
  assert.equal(down.status, 502);
  assert.match(down.text, /temporary portal is not supervised/);
  assert.equal((await requestPortal(true)).status, 503, "websockets must not trigger service ensure either");
  assert.equal(registry.getCube("alpha")!.status, "asleep", "portal must not wake an unsupervised process");
  assert.equal((await fetch(`${base}/api/threads/alpha/portals/3000`, { method: "DELETE" })).status, 200);
  assert.equal(supervisor.resolvePortal(label), null);
  assert.equal(supervisor.declaredPortalCube(label), null, "removed route cannot bootstrap as a service");
  registry.setCubeStatus("alpha", "ready");
  await post({ port: 3000, name: "archive me" });
  assert.equal((await fetch(`${base}/api/threads/alpha/archive`, { method: "POST" })).status, 200);
  assert.equal(supervisor.resolvePortal(label), null);
  assert.equal((await post({ port: 3000, name: "test" })).status, 409);
  assert.deepEqual(supervisor.listPortalsForUserThread("alpha"), []);
  assert.equal((await requestPortal()).status, 404);
  registry.setCubeStatus("beta", "ready");
  supervisor.exposePortalForUserThread("beta", { port: 4321, name: "delete me" });
  const destroying = once(daemon, "message", { signal: AbortSignal.timeout(5_000) });
  const deletion = fetch(`${base}/api/threads/beta`, { method: "DELETE" }).catch((error: Error) => error);
  try {
    assert.deepEqual(await destroying, ["destroy entered", undefined]);
    assert.ok(registry.getTemporaryPortal("temporary--4321--beta"), "route row still exists during backend teardown");
    assert.equal((await requestPortal(false, "temporary--4321--beta")).status, 404);
    await assert.rejects(requestPortal(true, "temporary--4321--beta"), { code: "ECONNRESET" });
    assert.equal((await fetch(`${base}/api/threads/alpha/portals`)).status, 200, "daemon survives upgrade during deletion");
    assert.equal(daemon.exitCode, null);
  } finally {
    if (daemon.connected) daemon.send("finish destroy");
  }
  const deleted = await deletion;
  assert.ok(deleted instanceof Response);
  assert.equal(deleted.status, 200);
  assert.equal(registry.getTemporaryPortal("temporary--4321--beta"), null);
  console.log("PASS: HTTP and WebSocket portal requests during paused thread deletion leave the daemon alive");
  console.log("PASS: temporary portals validate, persist, isolate, bypass service reconciliation, reject wake, and expire on removal/archive/delete; HTTP API verified");
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await once(daemon, "exit");
  }
  await supervisor.close();
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
