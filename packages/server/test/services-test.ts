/**
 * Offline unit test for the declared-services ensure engine: port
 * assignment (fixed/persisted/auto), env injection, systemd invocations,
 * readiness probing (against a real loopback listener), the
 * 127.0.0.1-bind diagnosis, and hairpin /etc/hosts writing — all through a
 * scripted ServicesHost (no Incus).
 *
 *   node packages/server/test/services-test.ts
 */
import assert from "node:assert";
import http from "node:http";
import net from "node:net";

import { parseServices } from "../src/cube-toml.ts";
import { Registry } from "../src/registry.ts";
import {
  ensureServices,
  portalLabelFor,
  serviceUnit,
  siblingEnvName,
  type ServicesHost,
} from "../src/services.ts";

assert.equal(portalLabelFor("t-abc12345", "web"), "web--t-abc12345");
assert.equal(serviceUnit("web"), "cube-svc-web");
assert.equal(siblingEnvName("mock-oauth"), "CUBE_SERVICE_MOCK_OAUTH_URL");
console.log("1 ok: naming helpers");

const registry = new Registry(":memory:");
const cube = registry.createCube({ name: "t-svc", image: "cube-node", workspacePath: "/w" });

/** Scripted cube: records execs; "starting" a service spins up a real
 * loopback listener on the assigned port so readiness probing is exercised
 * for real. `startBehavior` tunes what a started unit does: "listen" (a
 * server comes up), "nothing" (stays active, never listens), "exit" (the
 * process dies at once — the unit is never active). */
function makeHost(opts: { startBehavior?: "listen" | "nothing" | "exit"; health?: boolean } = {}) {
  const execs: string[][] = [];
  const servers = new Map<string, net.Server | http.Server>();
  const active = new Set<string>();
  const descriptions = new Map<string, string>();
  const host: ServicesHost = {
    cubeIp: "127.0.0.1",
    gatewayIp: "10.90.99.1",
    portalBase: "cube.internal",
    publicUrl: (label) => `http://${label}.cube.internal:7777`,
    async execRoot(cmd) {
      execs.push(cmd);
      if (cmd[0] === "systemctl" && cmd[1] === "is-active") return active.has(cmd[3]!) ? 0 : 3;
      if (cmd[0] === "systemctl" && cmd[1] === "stop") {
        active.delete(cmd[2]!);
        servers.get(cmd[2]!)?.close();
        servers.delete(cmd[2]!);
        return 0;
      }
      if (cmd[0] === "systemctl") return 0; // reset-failed
      if (cmd[0] === "sh" && cmd[2]!.includes("Description")) {
        // the declaration fingerprint check: `[ "$(systemctl show ... UNIT)" = "FP" ]`
        const m = /--value (\S+)\)" = "([^"]+)"/.exec(cmd[2]!)!;
        return descriptions.get(m[1]!) === m[2] ? 0 : 1;
      }
      if (cmd[0] === "bash" && cmd[1] === "-c") {
        // the loopback-bind diagnosis probe: /dev/tcp/127.0.0.1/<port> —
        // outside the sandbox that's the same loopback our test servers
        // use, so "connectable" == a server exists on the port.
        const port = Number(/\/(\d+)$/.exec(cmd[2]!)?.[1]);
        return (await new Promise<boolean>((resolve) => {
          const s = net.connect({ host: "127.0.0.1", port, timeout: 300 });
          s.on("connect", () => (s.destroy(), resolve(true)));
          s.on("error", () => resolve(false));
          s.on("timeout", () => (s.destroy(), resolve(false)));
        }))
          ? 0
          : 1;
      }
      if (cmd[0] === "sh") return 0; // hairpin hosts write
      if (cmd[0] === "systemd-run") {
        const unit = /--unit=(.+)/.exec(cmd.find((c) => c.startsWith("--unit="))!)![1]!;
        const port = Number(/--setenv=PORT=(\d+)/.exec(cmd.find((c) => c.startsWith("--setenv=PORT="))!)![1]);
        descriptions.set(unit, /--description=(.+)/.exec(cmd.find((c) => c.startsWith("--description="))!)![1]!);
        const behavior = opts.startBehavior ?? "listen";
        if (behavior === "exit") return 0;
        active.add(unit);
        if (behavior === "nothing") return 0;
        const server = opts.health
          ? http.createServer((req, res) => {
              res.writeHead(req.url === "/healthz" ? 204 : 404);
              res.end();
            })
          : net.createServer((s) => s.destroy());
        servers.set(unit, server);
        await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
        return 0;
      }
      throw new Error(`unexpected exec: ${cmd.join(" ")}`);
    },
    upsertPortal: (name, targetPort, hostname) => registry.upsertPortal(cube.id, name, targetPort, hostname),
    releasePortal: (name) => registry.releasePortal(cube.id, name),
    listPortals: () => registry.listPortals(cube.id),
  };
  const runs = () => execs.filter((c) => c[0] === "systemd-run").length;
  return { host, execs, active, runs, close: () => servers.forEach((s) => s.close()) };
}

// --- happy path: fixed + auto port, env plumbing, portal rows, hairpin
{
  const { host, execs, close } = makeHost();
  const specs = parseServices(`
[services.web]
command = "serve --port $PORT"
port = 3000
[services.web.env]
API_MODE = "dev"
[services.oauth]
command = "mock-oauth"
`);
  const statuses = await ensureServices(host, "t-svc", specs);
  close();
  assert.deepEqual(
    statuses.map((s) => [s.name, s.state, s.port, s.url]),
    [
      ["web", "running", 3000, "http://web--t-svc.cube.internal:7777"],
      ["oauth", "running", 4100, "http://oauth--t-svc.cube.internal:7777"],
    ],
  );
  // portal registry synced
  assert.equal(registry.getPortalByHostname("web--t-svc")!.targetPort, 3000);
  assert.equal(registry.getPortalByHostname("oauth--t-svc")!.targetPort, 4100);
  // hairpin block written once, as an argument (never through the script
  // text), with both hostnames pinned to the gateway
  const hosts = execs.find((c) => c[0] === "sh" && c[2]!.includes("cube-portals"))!;
  assert.equal(
    hosts[4],
    "# cube-portals start\n10.90.99.1 web--t-svc.cube.internal\n10.90.99.1 oauth--t-svc.cube.internal\n# cube-portals end",
  );
  // systemd-run for web carries the managed env + the declared one
  const run = execs.find((c) => c[0] === "systemd-run" && c.includes("--unit=cube-svc-web"))!;
  assert.ok(run.includes("--setenv=PORT=3000"));
  assert.ok(run.includes("--setenv=PUBLIC_URL=http://web--t-svc.cube.internal:7777"));
  assert.ok(run.includes("--setenv=CUBE_SERVICE_OAUTH_URL=http://oauth--t-svc.cube.internal:7777"));
  assert.ok(run.includes("--setenv=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.cube.internal"));
  assert.ok(run.includes("--setenv=API_MODE=dev"));
  assert.ok(!run.some((arg) => arg.startsWith("--setenv=NO_PROXY")), "proxy env comes from the login shell");
  assert.ok(run.includes("--working-directory=/workspace"));
  assert.match(run[1]!, /^--description=cube:[0-9a-f]{16}$/);
  assert.equal(run.at(-2), "-lc");
  assert.equal(run.at(-1), "serve --port $PORT");
  console.log("2 ok: ensure starts, probes, syncs portals, injects env");
}

// --- auto port is persisted: re-ensure reuses 4100 for oauth; the service
// that vanished from the declaration (web) is stopped and its row dropped
{
  const { host, execs, close } = makeHost();
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.oauth]\ncommand = "mock-oauth"`));
  close();
  assert.equal(statuses[0]!.port, 4100);
  assert.deepEqual(execs.find((c) => c[1] === "stop"), ["systemctl", "stop", "cube-svc-web"]);
  assert.equal(registry.getPortalByHostname("web--t-svc"), null);
  assert.deepEqual(registry.listPortals(cube.id).map((r) => r.name), ["oauth"]);
  console.log("3 ok: auto port stable across ensures; undeclared service retired");
}

// --- an active unit from the same declaration is left alone (however long
// it takes to come up); an edited declaration replaces it
{
  const { host, runs, close } = makeHost();
  const same = parseServices(`[services.web]\ncommand = "serve"\nport = 3000`);
  assert.equal((await ensureServices(host, "t-svc", same))[0]!.state, "running");
  assert.equal((await ensureServices(host, "t-svc", same))[0]!.state, "running");
  assert.equal(runs(), 1, "must not re-run an active unit of an unchanged declaration");
  const edited = parseServices(`[services.web]\ncommand = "serve --verbose"\nport = 3000`);
  assert.equal((await ensureServices(host, "t-svc", edited))[0]!.state, "running");
  assert.equal(runs(), 2, "an edited declaration restarts the unit");
  close();
  console.log("4 ok: same declaration -> untouched; edited -> restarted");
}

// --- a slow starter is waited for, not restarted: active unit, same
// declaration, listener appears only after a while
{
  const { host, runs, close } = makeHost({ startBehavior: "nothing" });
  const specs = parseServices(`[services.web]\ncommand = "serve"\nport = 3005`);
  const first = await ensureServices(host, "t-svc", specs, { readyTimeoutMs: 300 });
  assert.equal(first[0]!.state, "failed");
  const late = net.createServer((s) => s.destroy());
  setTimeout(() => late.listen(3005, "127.0.0.1"), 700);
  const second = await ensureServices(host, "t-svc", specs, { readyTimeoutMs: 3_000 });
  late.close();
  close();
  assert.equal(second[0]!.state, "running");
  assert.equal(runs(), 1, "the still-active unit must not be restarted while it comes up");
  console.log("4b ok: slow starter waited for across ensures");
}

// --- managed env keys are rejected
{
  const { host, close } = makeHost();
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "serve"\nport = 3010\n[services.web.env]\nPORT = "9"`));
  close();
  assert.equal(statuses[0]!.state, "failed");
  assert.match(statuses[0]!.detail!, /managed by cubed/);
  console.log("5 ok: managed env keys rejected");
}

// --- health path: probed over HTTP, 204 passes
{
  const { host, close } = makeHost({ health: true });
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "serve"\nport = 3020\nhealth = "/healthz"`));
  close();
  assert.equal(statuses[0]!.state, "running");
  console.log("6 ok: http health check");
}
console.log("services-test: all ok");

// --- cancellation interrupts readiness polling instead of waiting 60s
{
  const { host, close } = makeHost({ startBehavior: "nothing" });
  const controller = new AbortController();
  const started = Date.now();
  const pending = ensureServices(
    host,
    "t-svc",
    parseServices(`[services.web]\ncommand = "serve"\nport = 3050`),
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("caller disconnected")), 50);
  await assert.rejects(pending, /caller disconnected/);
  close();
  assert.ok(Date.now() - started < 1_000, "abort should stop readiness polling promptly");
  console.log("6b ok: abort interrupts service readiness polling");
}

// --- never-ready unit: fast timeout, journalctl hint (unit still active)
{
  const { host, close } = makeHost({ startBehavior: "nothing" });
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "serve"\nport = 3030`), { readyTimeoutMs: 1200 });
  close();
  assert.equal(statuses[0]!.state, "failed");
  assert.match(statuses[0]!.detail!, /within 1.2s.*journalctl -u cube-svc-web/);
  console.log("7 ok: never-ready -> timeout + journalctl hint");
}

// --- a unit whose process exits fails fast, not after the whole deadline
{
  const { host, close } = makeHost({ startBehavior: "exit" });
  const started = Date.now();
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "exit 1"\nport = 3035`), { readyTimeoutMs: 10_000 });
  close();
  assert.equal(statuses[0]!.state, "failed");
  assert.match(statuses[0]!.detail!, /exited before becoming ready.*journalctl -u cube-svc-web/);
  assert.ok(Date.now() - started < 2_000, "an exited unit must not run out the readiness deadline");
  console.log("7b ok: exited unit -> fast failure");
}

// --- the port is already served by something that is not our unit
{
  const { host, runs, close } = makeHost();
  const squatter = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => squatter.listen(3045, "127.0.0.1", r));
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "serve"\nport = 3045`));
  squatter.close();
  close();
  assert.equal(statuses[0]!.state, "failed");
  assert.match(statuses[0]!.detail!, /port 3045 is already in use/);
  assert.equal(runs(), 0, "must not start a unit that cannot bind");
  console.log("7c ok: squatted port diagnosed, unit not started");
}

// --- the 127.0.0.1-bind diagnosis: host probe fails, in-cube loopback hits
{
  const { host, close } = makeHost({ startBehavior: "nothing" });
  // The host probe uses a distinct loopback address while the "in-cube"
  // bash probe checks 127.0.0.1, where we plant a listener — exactly the
  // wrong-bind shape, without relying on external routing behavior.
  (host as { cubeIp: string }).cubeIp = "127.0.0.2";
  const loopbackOnly = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => loopbackOnly.listen(3040, "127.0.0.1", r));
  const statuses = await ensureServices(host, "t-svc", parseServices(`[services.web]\ncommand = "serve"\nport = 3040`), { readyTimeoutMs: 1200 });
  loopbackOnly.close();
  close();
  assert.equal(statuses[0]!.state, "failed");
  assert.match(statuses[0]!.detail!, /127\.0\.0\.1 only.*bind 0\.0\.0\.0/);
  console.log("8 ok: loopback-bind diagnosed with a rebind hint");
}
console.log("services-test (failure paths): all ok");
