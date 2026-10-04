/** cubed's supervision of cube-gateway, against a fake gateway that keeps
 * the real process contract (ready line, stdin lifeline, control socket):
 * start and ready, restart with backoff, every attached VM attached again
 * after a restart, the lifeline on stop, and no gateway failing visibly. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient, GatewaySupervisor, GatewayUnavailable, locateGateway, widestNetwork } from "../src/gateway.ts";
import { ThreadVms } from "../src/vm.ts";
import type { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-gateway-"));
const binary = path.join(root, "cube-gateway");
fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, "fake-gateway.ts")}" "$@"\n`, { mode: 0o755 });
const logFile = path.join(root, "gateway.log");
const events = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
async function until(check: () => boolean, what: string, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
}
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const supervisors: GatewaySupervisor[] = [];
const supervise = (options: Partial<ConstructorParameters<typeof GatewaySupervisor>[0]> = {}) => {
  const supervisor = new GatewaySupervisor({ state: path.join(root, "state"), control: path.join(root, "gateway.sock"),
    decide: path.join(root, "egress.sock"), network: "loopback", binary, backoff: { minMs: 100, maxMs: 400 }, log: quiet,
    env: { FAKE_GATEWAY_LOG: logFile, FAKE_GATEWAY_CRASH: "3" }, ...options });
  supervisors.push(supervisor);
  return supervisor;
};
try {
  assert.equal(widestNetwork([]), "loopback");
  assert.equal(widestNetwork(["loopback", "relay", "direct"]), "relay");
  assert.equal(locateGateway({ CUBED_GATEWAY: binary }), binary);
  assert.equal(locateGateway({ CUBED_GATEWAY: path.join(root, "absent") }), null);

  // No binary: VM threads fail visibly; there is no fallback.
  const absent = supervise({ binary: null });
  assert.match(absent.unavailable ?? "", /cube-gateway was not found/);
  await assert.rejects(absent.ready(), (error: unknown) => error instanceof GatewayUnavailable && /gateway unavailable: cube-gateway was not found/.test(error.message));

  // Start, ready line, control API, arguments.
  const supervisor = supervise();
  const vms = new ThreadVms({ registry: {} as Registry, threads: path.join(root, "threads"), run: root, gateway: supervisor, log: quiet });
  // Two VMs this process has attached (as ThreadVms.start records them).
  const attached = (vms as unknown as { attached: Map<string, unknown> }).attached;
  const spec = (thread: string) => ({ threadId: thread, runner: { peer: "c".repeat(64), network: "loopback" as const, address: "127.0.0.1:1" }, frameToken: "d".repeat(64), mac: "02:00:00:00:00:01" });
  attached.set("0000000000000001", spec("t1"));
  attached.set("0000000000000002", spec("t2"));
  supervisor.start();
  const { client, hello } = await supervisor.ready();
  assert.equal(hello.peer, "a".repeat(64));
  assert.equal(client.control, path.join(root, "gateway.sock"));
  assert.deepEqual(client.dialCommand("0000000000000001"), [binary, "dial", "--control", client.control, "--vm", "0000000000000001", "--port", "22"]);
  const first = events().find(event => event.event === "start")!;
  assert.deepEqual(first.args, ["serve", "--state", path.join(root, "state"), "--control", path.join(root, "gateway.sock"),
    "--decide", path.join(root, "egress.sock"), "--network", "loopback"]);
  assert.equal(fs.statSync(path.join(root, "gateway.sock")).mode & 0o777, 0o600);

  // Crashes: restarted with growing backoff; every attached VM attached again each time.
  await until(() => events().filter(event => event.event === "start").length >= 4, "three restarts");
  const ready = await supervisor.ready();
  await until(() => events().filter(event => event.event === "attach").length >= 6, "re-attach after every restart");
  const starts = events().filter(event => event.event === "start").map(event => event.at as number);
  const gaps = starts.slice(1).map((at, index) => at - starts[index]);
  assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `backoff grows: ${gaps.join(", ")} ms`);
  assert.equal(supervisor.restarts, 3);
  const attaches = events().filter(event => event.event === "attach").map(event => event.vmId);
  assert.deepEqual(new Set(attaches), new Set(["0000000000000001", "0000000000000002"]));
  assert.equal((await ready.client.status("0000000000000001"))?.link, "up");
  assert.equal(await ready.client.status("00000000000000ff"), null);
  assert.equal((await ready.client.list()).length, 2);
  await ready.client.detach("0000000000000002");
  assert.equal((await ready.client.list()).length, 1);

  // A wider runner restarts the gateway in the wider mode.
  await supervisor.ensureNetwork("direct");
  await until(() => events().filter(event => event.event === "start").some(event => (event.args as string[]).includes("direct")), "restart in direct mode");
  assert.equal((await supervisor.ready()).hello.network, "direct");

  // Stop ends the lifeline; nothing restarts afterwards.
  const before = events().filter(event => event.event === "start").length;
  await supervisor.stop();
  await until(() => events().some(event => event.event === "lifeline" || event.event === "sigterm"), "the gateway exits on stop");
  await delay(600);
  assert.equal(events().filter(event => event.event === "start").length, before);
  await assert.rejects(supervisor.ready(), GatewayUnavailable);
  await assert.rejects(new GatewayClient(binary, path.join(root, "gateway.sock")).hello(), GatewayUnavailable);
  console.log("ok: gateway supervision: ready line, arguments, restart with growing backoff, every attached VM attached again, wider network restart, lifeline stop, no binary fails visibly");
} finally {
  for (const supervisor of supervisors) await supervisor.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
