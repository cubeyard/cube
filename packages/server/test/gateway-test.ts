/** cubed's supervision of cube-gateway (the credential proxy of runner
 * protocol 4), against a fake gateway that keeps the real process contract
 * (ready line, stdin lifeline, credential socket): start and ready, the
 * arguments, restart with backoff, the lifeline on stop, and no gateway
 * failing visibly. With a real gateway's path (scripts/test-node-transport.sh
 * passes target/debug/cube-gateway) also the real binary: its ready line, its
 * socket, a credential stream decided by cubed's real egress policy, and its
 * lifeline.
 *
 *   node packages/server/test/gateway-test.ts [target/debug/cube-gateway] */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { create, toJsonString } from "@bufbuild/protobuf";
import { EgressPolicy, serveEgress } from "../src/egress-policy.ts";
import { GatewaySupervisor, GatewayUnavailable, locateGateway } from "../src/gateway.ts";
import { CredentialHeaderSchema } from "../src/gen/runner_pb.js";

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

  // The real gateway, when its path is given.
  const real = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (real) {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "cube-gw-"));
    fs.chmodSync(run, 0o700);
    const egress = await serveEgress(path.join(run, "egress.sock"), new EgressPolicy({ vms: { vm: () => null }, secrets: [], log: quiet as never }));
    const credential = path.join(run, "credential.sock");
    const gateway = supervise({ binary: real, credential, decide: path.join(run, "egress.sock"), env: {} });
    gateway.start();
    try {
      assert.match((await gateway.ready()).version, /^\d+\.\d+\.\d+/);
      assert.equal(fs.statSync(credential).mode & 0o777, 0o600);
      // A stream for a machine cubed's policy does not know: denied before anything leaves.
      const header = Buffer.from(toJsonString(CredentialHeaderSchema, create(CredentialHeaderSchema, { ref: { owner: "thread-x", id: "0123456789abcdef" }, credential: "github",
        sni: "api.github.com", host: "api.github.com", port: 443 })));
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(credential);
        let text = "";
        socket.on("data", chunk => { text += chunk; });
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(header.length);
        socket.write(Buffer.concat([length, header, Buffer.from("GET /user HTTP/1.1\r\nhost: api.github.com\r\n\r\n")]));
      });
      assert.match(answer, /^HTTP\/1\.1 403 /);
      assert.match(answer, /x-cube-denied: unknown thread machine/i);
      await gateway.stop();
      assert.equal(fs.existsSync(credential), false, "the gateway removes its socket when it stops");
    } finally {
      await gateway.stop();
      await egress.close();
      fs.rmSync(run, { recursive: true, force: true });
    }
    console.log(`ok: the real cube-gateway (${real}): ready line, a 0600 credential socket, a stream for an unknown machine denied by cubed's policy, lifeline stop`);
  }
} finally {
  for (const supervisor of supervisors) await supervisor.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
