/** cubed's supervision of cube-gateway (the credential proxy of runner
 * protocol 4), against a fake gateway that keeps the real process contract
 * (ready line, stdin lifeline, credential socket): start and ready, the
 * arguments, restart with backoff, the lifeline on stop, and no gateway
 * failing visibly. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewaySupervisor, GatewayUnavailable, locateGateway } from "../src/gateway.ts";

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
  const supervisor = new GatewaySupervisor({ decide: path.join(root, "egress.sock"), credential: path.join(root, "credential.sock"),
    binary, backoff: { minMs: 100, maxMs: 400 }, log: quiet, env: { FAKE_GATEWAY_LOG: logFile, FAKE_GATEWAY_CRASH: "3" }, ...options });
  supervisors.push(supervisor);
  return supervisor;
};
try {
  assert.equal(locateGateway({ CUBED_GATEWAY: binary }), binary);
  assert.equal(locateGateway({ CUBED_GATEWAY: path.join(root, "absent") }), null);

  // No binary: a credential stream fails visibly; there is no fallback.
  const absent = supervise({ binary: null });
  assert.match(absent.unavailable ?? "", /cube-gateway was not found/);
  await assert.rejects(absent.ready(), (error: unknown) => error instanceof GatewayUnavailable && /gateway unavailable: cube-gateway was not found/.test(error.message));

  // Start, ready line, arguments: the credential proxy only.
  const supervisor = supervise();
  supervisor.start();
  assert.deepEqual(await supervisor.ready(), { version: "fake" });
  const first = events().find(event => event.event === "start")!;
  assert.deepEqual(first.args, ["serve", "--decide", path.join(root, "egress.sock"), "--credential", path.join(root, "credential.sock")]);
  assert.equal(fs.statSync(path.join(root, "credential.sock")).mode & 0o777, 0o600);

  // Crashes: restarted with growing backoff.
  await until(() => events().filter(event => event.event === "start").length >= 4, "three restarts");
  await supervisor.ready();
  const starts = events().filter(event => event.event === "start").map(event => event.at as number);
  const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
  assert.ok(gaps[1]! > gaps[0]! && gaps[2]! > gaps[1]!, `backoff grows: ${gaps.join(", ")} ms`);
  assert.equal(supervisor.restarts, 3);
  assert.equal(supervisor.unavailable, null);

  // Stop ends the lifeline; nothing restarts afterwards.
  const before = events().filter(event => event.event === "start").length;
  await supervisor.stop();
  await until(() => events().some(event => event.event === "lifeline" || event.event === "sigterm"), "the gateway exits on stop");
  await delay(600);
  assert.equal(events().filter(event => event.event === "start").length, before);
  await assert.rejects(supervisor.ready(), GatewayUnavailable);
  console.log("ok: gateway supervision: ready line, credential-proxy arguments, restart with growing backoff, lifeline stop, no binary fails visibly");
} finally {
  for (const supervisor of supervisors) await supervisor.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
