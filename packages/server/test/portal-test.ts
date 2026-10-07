/** The portal and `cube service` offline: cubed's real HTTP server and
 * portal over a local guest (the real helper and its CLI under a temporary
 * root, processes in place of systemd units, the guest's 127.0.0.1 in place
 * of its LAN address and a TCP connect in place of the gateway's dial). The
 * gateway's dial route itself is tested in packages/gateway/tests/link.rs;
 * a real machine needs scripts/test-node-transport.sh. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { portalSettings, privateIpv4, responseHeaders } from "../src/portal.ts";
import type { Thread } from "../src/registry.ts";
import { helperBootstrapScripts } from "../src/vm.ts";
import { GUEST_CLI_SHIM, shippedHelper } from "../src/vm-seed.ts";
import { LocalMachines } from "./local-guest.ts";

// Settings: off without an address, never public or on every interface.
assert.equal(portalSettings({}), null);
assert.deepEqual(portalSettings({ CUBED_PORTAL_IP: "100.101.102.103" }),
  { ip: "100.101.102.103", port: 7780, listen: "100.101.102.103", domain: "sslip.io", suffix: "100-101-102-103.sslip.io" });
assert.deepEqual(portalSettings({ CUBED_PORTAL_IP: "192.168.1.5", CUBED_PORTAL_PORT: "80", CUBED_PORTAL_DOMAIN: "nip.io", CUBED_PORTAL_LISTEN: "127.0.0.1" }),
  { ip: "192.168.1.5", port: 80, listen: "127.0.0.1", domain: "nip.io", suffix: "192-168-1-5.nip.io" });
assert.equal(portalSettings({ CUBED_PORTAL_IP: "10.0.0.2", CUBED_PORTAL_DOMAIN: "Cube.Example.ts.net" })!.suffix, "cube.example.ts.net");
for (const [env, message] of [[{ CUBED_PORTAL_IP: "8.8.8.8" }, /private IPv4/], [{ CUBED_PORTAL_IP: "fd00::1" }, /private IPv4/],
  [{ CUBED_PORTAL_IP: "10.0.0.2", CUBED_PORTAL_LISTEN: "0.0.0.0" }, /never listens on every interface/],
  [{ CUBED_PORTAL_IP: "10.0.0.2", CUBED_PORTAL_PORT: "08080" }, /CUBED_PORTAL_PORT/],
  [{ CUBED_PORTAL_IP: "10.0.0.2", CUBED_PORTAL_DOMAIN: "localhost" }, /CUBED_PORTAL_DOMAIN/]] as const) {
  assert.throws(() => portalSettings(env), message);
}
assert.deepEqual(["100.64.0.1", "100.127.255.1", "172.31.0.1", "127.0.0.1", "100.128.0.1", "172.32.0.1", "1.1.1.1"].map(privateIpv4),
  [true, true, true, true, false, false, false]);
assert.deepEqual(responseHeaders(["Set-Cookie", "a=1; Domain=.sslip.io; Path=/", "Connection", "keep-alive, x-private", "X-Private", "1",
  "Keep-Alive", "timeout=5", "Content-Type", "text/plain", "set-cookie", "b=2; Domain =.sslip.io"]),
  ["Set-Cookie", "a=1; Path=/", "Content-Type", "text/plain", "set-cookie", "b=2"]);
console.log("ok: portal settings refuse public and wildcard addresses; service cookies become host-only");

// A helper from before `install` gets the shipped one through ordinary
// commands of cubed's: every one fits the helper's command limit, and the
// last one hands the new helper's own `install` a valid request.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-bootstrap-"));
  try {
    const { source, sha256 } = shippedHelper();
    const scripts = helperBootstrapScripts(source);
    assert.ok(scripts.length >= 2 && scripts.every(script => Buffer.byteLength(script) <= 8192));
    const launcher = path.join(import.meta.dirname, "local-guest.py");
    for (const script of scripts) {
      execFileSync("bash", ["-c", script.replaceAll("/var/tmp/", `${root}/`)
        .replace('sudo -n /usr/bin/python3 "$d/helper"', `python3 ${launcher} ${root}`)], { stdio: "pipe" });
    }
    assert.equal(fs.readFileSync(path.join(root, "cube-guest"), "utf8"), source.toString());
    assert.equal(fs.readFileSync(path.join(root, "bin", "cube"), "utf8"), GUEST_CLI_SHIM);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith("cube-helper-")), [], "the chunks are removed");
    assert.match(sha256, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log("ok: an old helper is replaced through chunked commands and the new helper's install");
}

/** Machines a test can take down without cubed knowing (the portal must not start them). */
class Machines extends LocalMachines {
  readonly down = new Set<string>();
  override running(thread: Thread): boolean { return !this.down.has(thread.id) && super.running(thread); }
}

const free = () => new Promise<number>(resolve => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-portal-"));
const machines = new Machines(path.join(root, "machines"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
const models = createModels();
models.setProvider(faux.provider);
const portalPort = await free();
const suffix = "127-0-0-1.sslip.io";
const state = path.join(root, "state");
fs.mkdirSync(state);
const app = await createCubed({ state, models, claude: null, machines,
  portal: { ip: "127.0.0.1", port: portalPort, listen: "127.0.0.1", domain: "sslip.io", suffix } });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;

async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  for (let k = 0; ; k++) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(k < 800, `${what}: ${JSON.stringify(value)}`);
    await delay(25);
  }
}
/** A portal request with an exact Host. */
function get(host: string, target = "/", headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: portalPort, path: target, headers: { host, ...headers }, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
}
/** A raw request (an absolute-form target, an upgrade); resolves with the socket and what came first. */
function raw(text: string): Promise<{ socket: net.Socket; first: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(portalPort, "127.0.0.1", () => socket.write(text));
    socket.once("data", (chunk: Buffer) => resolve({ socket, first: chunk.toString() }));
    socket.once("error", reject);
  });
}

try {
  app.registry.enrollRunner({ nodeId: "node-portal", threadId: "runner-portal", environmentId: 1, configPath: "/private/portal.json", configHash: "portal" });
  const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "web", repositories: [] }) })).json()).project;
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  const thread = app.registry.createThread(project.id, "portal-1", model, "hello", "pi");
  await app.conversations.activate(thread.id);
  assert.equal(app.registry.getThread(thread.id)!.workspaceState, "available");
  assert.equal((await (await fetch(`${base}/api/health`)).json()).portal, "listening");

  // Activation brought the machine's helper and `cube` command up to date
  // (a local guest starts without them) and told it its URLs.
  const guest = machines.guest(app.registry.getThread(thread.id)!);
  assert.equal(fs.readFileSync(path.join(guest.root, "cube-guest"), "utf8"), shippedHelper().source.toString());
  assert.equal(fs.readFileSync(path.join(guest.root, "bin", "cube"), "utf8"), GUEST_CLI_SHIM);
  const label = app.portal.label(thread.id);
  assert.match(label, /^[0-9a-f]{10}$/);
  const host = `app-${label}.${suffix}:${portalPort}`;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(guest.root, "portal.json"), "utf8")), { urlTemplate: `http://{name}-${label}.${suffix}:${portalPort}/` });
  assert.deepEqual(await (await fetch(`${base}/api/threads/${thread.id}/services`)).json(), { portal: "listening", running: true, services: [] });

  // The agent starts its server; the command returns its URL once it listens.
  const appPort = await free();
  const cube = (...args: string[]) => spawnSync("python3", [path.join(import.meta.dirname, "local-guest.py"), guest.root, "cli", ...args],
    { cwd: guest.workspace, encoding: "utf8" });
  const started = cube("service", "start", "app", "--port", String(appPort), "--env", `CUBE_APP_STATE=${root}`, "--", "python3", path.join(import.meta.dirname, "portal-app.py"));
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.match(started.stdout, new RegExp(`^starting service app on port ${appPort} \\.\\.\\.\\nservice app started on port ${appPort}\\n  http: HTTP/1.1 200 OK\\n  url: http://${host.replace(/\./g, "\\.")}/\\n`));
  assert.equal(await (await fetch(`${base}/api/threads/${thread.id}/services`)).json().then(body => body.services[0].url), `http://${host}/`);

  // Through the portal: the page, its cookie host-only, forwarding headers
  // the portal's own (not what the browser claimed), Host as the browser sent it.
  const page = await get(host);
  assert.equal(page.status, 200);
  assert.equal(page.body, "hello from the service, 0.0.0.0");
  assert.deepEqual(page.headers["set-cookie"], ["session=1; Path=/"]);
  const echoed = (await get(host.toUpperCase(), "/headers", { "x-forwarded-for": "6.6.6.6", cookie: "a=b" })).body.toLowerCase();
  assert.match(echoed, new RegExp(`^get /headers http/1.1\\r\\n`));
  assert.match(echoed, new RegExp(`\\r\\nhost: ${host.replace(/\./g, "\\.")}\\r\\n`));
  assert.match(echoed, /\r\nx-forwarded-for: 127\.0\.0\.1\r\n/);
  assert.doesNotMatch(echoed, /6\.6\.6\.6/);
  assert.match(echoed, /\r\ncookie: a=b\r\n/);
  assert.match(echoed, /\r\nconnection: close\r\n/);
  // A reason phrase Node would refuse is dropped, not a crash of cubed.
  assert.deepEqual(await get(host, "/weird").then(answer => [answer.status, answer.body]), [200, "ok"]);
  const parallel = await Promise.all(Array.from({ length: 12 }, () => get(host)));
  assert.ok(parallel.every(answer => answer.status === 200));

  // Only exact service hosts: no cube UI or API, no other host or port, no
  // proxying to an address the request names.
  for (const [other, status, message] of [
    [`127.0.0.1:${portalPort}`, 404, "no cube service at this address"],
    [`app-${label}.${suffix}:${portalPort + 1}`, 404, "no cube service at this address"],
    [`app-${label}.${suffix}`, 404, "no cube service at this address"],
    [`app-${label}.evil.example:${portalPort}`, 404, "no cube service at this address"],
    [`app-0123456789.${suffix}:${portalPort}`, 404, "no cube service at this address"],
    [`x.app-${label}.${suffix}:${portalPort}`, 404, "no cube service at this address"],
    [`other-${label}.${suffix}:${portalPort}`, 404, "this thread has no service other; start one with cube service start"],
  ] as const) {
    const answer = await get(other, "/api/threads");
    assert.deepEqual([answer.status, answer.body], [status, `${message}\n`], other);
    assert.equal(answer.headers["cache-control"], "no-store");
  }
  const absolute = await raw(`GET http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}/api/threads HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
  assert.match(absolute.first, /^HTTP\/1\.1 400 /);
  absolute.socket.destroy();

  // A WebSocket upgrade reaches the service and the two connections are joined.
  const ws = await raw(`GET /socket HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n`
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  assert.match(ws.first, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  const echo = new Promise<string>(resolve => ws.socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
  ws.socket.write("frame bytes");
  assert.equal(await echo, "frame bytes");
  assert.equal(app.portal.connections(thread.id), 1);
  ws.socket.destroy();
  await until(() => app.portal.connections(thread.id), value => value === 0, "a closed WebSocket releases its connection");
  const refusedUpgrade = await raw(`GET / HTTP/1.1\r\nHost: nope-${label}.${suffix}:${portalPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  assert.match(refusedUpgrade.first, /^HTTP\/1\.1 404 Not Found\r\n[^]*this thread has no service nope; start one with cube service start\n$/);
  refusedUpgrade.socket.destroy();

  // A download the browser abandons ends the service's connection too: it
  // streams with backpressure instead of buffering 64 MiB.
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: portalPort, path: "/big", headers: { host }, agent: false }, response => {
      let seen = 0;
      response.on("data", (chunk: Buffer) => { seen += chunk.length; if (seen > 1 << 20) { request.destroy(); resolve(); } });
    });
    request.on("error", error => { if (!request.destroyed) reject(error); });
    request.end();
  });
  await until(() => app.portal.connections(thread.id), value => value === 0, "an abandoned download releases its connection");
  await until(() => fs.existsSync(path.join(root, "big-closed")), Boolean, "the service sees its connection closed");

  // A machine cubed does not run is never started by the portal.
  const starts = machines.starts;
  machines.down.add(thread.id);
  const sleeping = await get(host);
  assert.deepEqual([sleeping.status, sleeping.body], [503, "this thread's machine is not running; open the thread in cube to start it\n"]);
  assert.deepEqual(await (await fetch(`${base}/api/threads/${thread.id}/services`)).json(), { portal: "listening", running: false, services: [] });
  assert.equal(machines.starts, starts);
  machines.down.delete(thread.id);

  // Stopped: off the portal (once the short cache ends) and the port is free.
  const stopped = cube("service", "stop", "app");
  assert.equal(stopped.stdout, "service app stopped\n");
  await until(async () => (await get(host)).status, status => status === 404, "a stopped service leaves the portal");
  assert.equal((await get(host)).body, "this thread has no service app; start one with cube service start\n");

  // Archived: the thread's services are gone with it.
  const again = cube("service", "start", "app", "--port", String(appPort), "--json", "--", "python3", path.join(import.meta.dirname, "portal-app.py"));
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).url, `http://${host}/`);
  await until(async () => (await get(host)).status, status => status === 200, "the service is back");
  assert.equal((await fetch(`${base}/api/threads/${thread.id}`, { method: "DELETE" })).status, 200);
  assert.equal(app.registry.getThread(thread.id)!.archived, true);
  assert.deepEqual(await get(host).then(answer => [answer.status, answer.body]), [404, "no cube service at this address\n"]);
  console.log("ok: portal serves registered services by exact host, joins WebSockets, ends abandoned streams, never wakes a machine, forgets stopped and archived services");
} finally {
  await app.close();
  await machines.close();
  fs.rmSync(root, { recursive: true, force: true });
}
