/** cubed's protocol-3 runner client against a real in-process npm iroh
 * endpoint that answers like a runner (no QEMU). The real Rust runner, gateway
 * and a real VM run in scripts/smoke-node-adapter.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Endpoint, SecretKey, type BiStream } from "@number0/iroh/index.js";
import { IrohNodeError, IrohRunnerClient, type VmStartSpec } from "../src/iroh-node.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iroh-runner-test-"));
const configPath = path.join(root, "config.json");
const nodeBinding = { nodeId: "node-test", environmentId: 1, threadId: "install-thread" };
const key = SecretKey.generate();
const controlKey = SecretKey.generate();
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(key.toBytes());
builder.bindAddr("127.0.0.1:0");
builder.bindAddr("[::1]:0");
builder.alpns([Array.from(Buffer.from("cubeyard/node/1"))]);
const server = await builder.bind();
const config = { version: 2, binding: nodeBinding, controlKey: path.join(root, "control.key"), serverPeer: Buffer.from(key.public().toBytes()).toString("hex"),
  address: server.boundSockets().find(x => x.startsWith("127."))!, network: "loopback" };
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const limits = { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64, maxSeedBytes: 65536, maxActiveVms: 1 };
const capabilities = ["node.hello", "node.status", "vm.allocate", "vm.start", "vm.stop", "vm.inspect", "vm.release"];
const sha = "d".repeat(64);
const calls: Array<Record<string, unknown>> = [];
let scenario = "normal";
const tasks = new Set<Promise<void>>();
const fixtureFailures: Error[] = [];
const frame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
};
async function receive(stream: BiStream): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await stream.recv.readToEnd(1048580));
  assert.equal(bytes.readUInt32BE(), bytes.length - 4);
  const request = JSON.parse(bytes.subarray(4).toString());
  calls.push(request);
  return request;
}
const record = (query: Record<string, unknown>, state = "allocated") => ({ vmId: query.vmId, threadId: query.threadId, state, interrupted: false, diskBytes: 196608 });
const accept = (async () => {
  while (true) {
    const incoming = await server.acceptNext();
    if (!incoming) return;
    const task = (async () => {
      const connection = await (await incoming.accept()).connect();
      assert.ok(connection.remoteId().equals(controlKey.public()), "fixture authorizes only its control peer");
      const mode = scenario;
      let stream = await connection.acceptBi();
      const hello = await receive(stream);
      assert.deepEqual(hello, { method: "node.hello", protocolVersion: 3 });
      if (mode === "protocol-2-runner") {
        // What a protocol-2 runner (cube-runner 0.3.x) answers a protocol-3 hello.
        await stream.send.writeAll(frame({ type: "Error", code: "INCOMPATIBLE_PROTOCOL", message: "protocol version 2 required; upgrade cubed or cube-runner", completionUnknown: false }));
        await stream.send.finish();
        await connection.closed();
        return;
      }
      const binding = mode === "wrong-node" ? { ...nodeBinding, nodeId: "node-other" } : nodeBinding;
      await stream.send.writeAll(frame({ type: "Hello", nodeId: binding.nodeId, protocolVersion: mode === "protocol-2-hello" ? 2 : 3,
        minimumProtocolVersion: mode === "protocol-2-hello" ? 2 : 3, softwareVersion: "0.4.0", binding, profiles: ["runner"],
        capabilities: mode === "no-vms" ? ["node.hello", "node.status"] : capabilities, limits, platform: "linux-x86_64", baseImageSha256: sha }));
      await stream.send.finish();
      stream = await connection.acceptBi();
      const query = await receive(stream);
      if (mode === "disconnect") { connection.close(0n, []); return; }
      if (mode === "garbage") { await stream.send.writeAll([0, 0, 0, 1, 255]); await stream.send.finish(); return; }
      const result = query.method === "node.status" ? { type: "Status", nodeId: binding.nodeId, protocolVersion: 3, minimumProtocolVersion: 3,
          softwareVersion: "0.4.0", binding, status: { lifecycle: "ready", draining: false, activeVms: 1, runningVms: 1, maxActiveVms: 1, retainedVms: 2, retainedBytes: 4096 } }
        : mode === "stale" ? { type: "Error", code: "LEASE_STALE", message: "a newer epoch has been seen for this thread", completionUnknown: false }
        : mode === "capacity" ? { type: "Error", code: "CAPACITY_EXCEEDED", message: "runner request rejected", completionUnknown: false }
        : mode === "missing" ? { type: "Error", code: "NOT_FOUND", message: "no such vm on this runner", completionUnknown: false }
        : mode === "wrong-vm" ? { type: "Vm", vm: { ...record(query), vmId: "ffffffffffffffff" } }
        : query.method === "vm.allocate" ? { type: "Vm", vm: record(query) }
        : query.method === "vm.start" ? { type: "Vm", vm: { ...record(query, "running"), seedSha256: sha, startedAt: 1 } }
        : query.method === "vm.stop" ? { type: "Vm", vm: record(query, "stopping") }
        : query.method === "vm.release" ? { type: "Vm", vm: record(query, query.retain ? "retained" : "released") }
        : { type: "Vm", vm: record(query, "running"), consoleTail: "Cloud-init v. 25 finished" };
      await stream.send.writeAll(frame(result));
      await stream.send.finish();
    })().catch(error => {
      if (error instanceof assert.AssertionError) fixtureFailures.push(error);
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
  }
})();
const code = (expected: string, unknown = false) => (error: unknown) => error instanceof IrohNodeError && error.code === expected && error.completionUnknown === unknown;
const processAPIs = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec, execSync: childProcess.execSync, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, fork: childProcess.fork };
Object.assign(childProcess, Object.fromEntries(Object.keys(processAPIs).map(name => [name, () => { throw new Error(`adapter must not call child_process.${name}`); }])));
syncBuiltinESMExports();
const ref = { threadId: "thread-1", vmId: "0123456789abcdef" };
const spec: VmStartSpec = { vcpus: 2, memoryMiB: 2048, mac: "02:12:34:56:78:9a",
  seed: { metaData: "instance-id: 0123456789abcdef\n", userData: "#cloud-config\n{}\n", networkConfig: "version: 2\n" },
  gateway: { peer: "e".repeat(64), frameToken: "f".repeat(64) } };
try {
  const client = new IrohRunnerClient({ configPath });
  assert.equal(client.contact, "unobserved");
  assert.equal(calls.length, 0, "construction contacts nothing");
  assert.ok(!fs.existsSync(config.controlKey), "construction reads no key");
  assert.deepEqual(client.binding, nodeBinding);
  assert.deepEqual(client.target, { peer: config.serverPeer, network: "loopback", address: config.address });
  fs.writeFileSync(config.controlKey, Buffer.from(controlKey.toBytes()), { mode: 0o600 });

  const described = await client.describe();
  assert.deepEqual(described, { softwareVersion: "0.4.0", capabilities, limits, platform: "linux-x86_64", baseImageSha256: sha });
  const health = await client.health();
  assert.deepEqual(health, { lifecycle: "ready", draining: false, error: null, activeVms: 1, runningVms: 1, maxActiveVms: 1, retainedVms: 2,
    retainedBytes: 4096, softwareVersion: "0.4.0", protocolVersion: 3 });

  // The VM lifecycle, request shapes as the runner expects them.
  assert.equal((await client.vmAllocate(ref, 7, 16)).state, "allocated");
  assert.deepEqual(calls.at(-1), { method: "vm.allocate", ...ref, epoch: 7, diskGiB: 16 });
  const started = await client.vmStart(ref, 7, spec);
  assert.equal(started.state, "running");
  assert.equal(started.seedSha256, sha);
  assert.deepEqual(calls.at(-1), { method: "vm.start", ...ref, epoch: 7, ...spec });
  assert.equal((await client.vmStop(ref, 8)).state, "stopping");
  assert.deepEqual(calls.at(-1), { method: "vm.stop", ...ref, epoch: 8 });
  const inspected = await client.vmInspect(ref);
  assert.equal(inspected.consoleTail, "Cloud-init v. 25 finished");
  assert.deepEqual(calls.at(-1), { method: "vm.inspect", ...ref });
  assert.equal((await client.vmRelease(ref, 9, true)).state, "retained");
  assert.deepEqual(calls.at(-1), { method: "vm.release", ...ref, epoch: 9, retain: true });

  // Invalid requests never reach the runner.
  const before = calls.length;
  await assert.rejects(client.vmAllocate({ ...ref, vmId: "XYZ" }, 1, 16), code("INVALID_REQUEST"));
  await assert.rejects(client.vmAllocate(ref, 0, 16), code("INVALID_REQUEST"), "epochs start at 1");
  await assert.rejects(client.vmStart(ref, 1, { ...spec, mac: "01:00:00:00:00:00" }), code("INVALID_REQUEST"), "a multicast mac");
  await assert.rejects(client.vmStart(ref, 1, { ...spec, gateway: { ...spec.gateway, frameToken: "short" } }), code("INVALID_REQUEST"));
  await assert.rejects(client.vmStart(ref, 1, { ...spec, extra: true } as VmStartSpec), code("INVALID_REQUEST"));
  await assert.rejects(client.vmRelease({ ...ref, threadId: "../x" }, 1, false), code("INVALID_REQUEST"));
  assert.equal(calls.length, before);

  // Runner answers in the shared vocabulary.
  for (const [mode, expected] of [["stale", "LEASE_STALE"], ["capacity", "CAPACITY_EXCEEDED"], ["missing", "NOT_FOUND"], ["no-vms", "OPERATION_UNSUPPORTED"]] as const) {
    scenario = mode;
    await assert.rejects(client.vmAllocate(ref, 10, 16), code(expected), mode);
  }
  scenario = "missing";
  await assert.rejects(client.vmInspect(ref), error => code("NOT_FOUND")(error) && (error as Error).message === "no such vm on this runner");
  scenario = "no-vms";
  await assert.rejects(client.describe(), code("OPERATION_UNSUPPORTED"), "a runner without VMs is not usable");
  scenario = "wrong-vm";
  await assert.rejects(client.vmInspect(ref), code("NODE_UNAVAILABLE"), "a record for another vm is malformed");
  // A protocol-2 runner is refused before any request, with the fix named.
  for (const mode of ["protocol-2-runner", "protocol-2-hello"]) {
    scenario = mode;
    const count: number = calls.length;
    await assert.rejects(client.vmAllocate(ref, 10, 16), error => code("INCOMPATIBLE_PROTOCOL")(error) && /re-enrolled as a VM runner/.test((error as Error).message));
    assert.equal(calls.length, count + 1, "only the hello was sent");
  }
  scenario = "wrong-node";
  await assert.rejects(client.describe(), code("WRONG_NODE"));
  // A lost answer: a mutation may have happened (repeat it, it is idempotent); a read did not.
  for (const mode of ["disconnect", "garbage"]) {
    scenario = mode;
    await assert.rejects(client.vmStart(ref, 11, spec), code("COMPLETION_UNKNOWN", true), mode);
    await assert.rejects(client.vmInspect(ref), code("NODE_UNAVAILABLE"), mode);
  }
  assert.equal(client.contact, "unavailable");
  scenario = "normal";
  await client.describe();
  assert.equal(client.contact, "available");

  // One Iroh identity, one live endpoint: calls are serialized; an abort ends
  // the waiting one without contacting the runner.
  const controller = new AbortController();
  const first = client.vmInspect(ref);
  const queued = client.vmInspect(ref, controller.signal);
  const inspectsBefore: number = calls.filter(row => row.method === "vm.inspect").length;
  controller.abort();
  await assert.rejects(queued, code("NODE_UNAVAILABLE"));
  assert.equal((await first).vm.state, "running");
  assert.ok(calls.filter(row => row.method === "vm.inspect").length <= inspectsBefore + 1, "the aborted call never reached the runner");

  // Config: version 1 (a protocol-2 runner) is refused with the fix; addresses are checked.
  fs.writeFileSync(path.join(root, "v1.json"), JSON.stringify({ ...config, version: 1, intentDirectory: root }), { mode: 0o600 });
  assert.throws(() => new IrohRunnerClient({ configPath: path.join(root, "v1.json") }), (error: unknown) =>
    code("INCOMPATIBLE_PROTOCOL")(error) && /re-enroll the runner/.test((error as Error).message));
  for (const address of ["0.0.0.0:1", "224.0.0.1:1", "[::]:1", "[::ffff:127.0.0.1]:1", "example.com:1", "127.0.0.1:0", "203.0.113.1:443"]) {
    fs.writeFileSync(path.join(root, "bad.json"), JSON.stringify({ ...config, address }), { mode: 0o600 });
    assert.throws(() => new IrohRunnerClient({ configPath: path.join(root, "bad.json") }), code("INVALID_REQUEST"), address);
  }
  const { address: _address, ...relay } = config;
  fs.writeFileSync(path.join(root, "relay.json"), JSON.stringify({ ...relay, network: "relay" }), { mode: 0o600 });
  assert.deepEqual(new IrohRunnerClient({ configPath: path.join(root, "relay.json") }).target, { peer: config.serverPeer, network: "relay" });
  fs.chmodSync(configPath, 0o644);
  assert.throws(() => new IrohRunnerClient({ configPath }), code("INVALID_REQUEST"), "a readable config is refused");
  fs.chmodSync(configPath, 0o600);
  const changed = new IrohRunnerClient({ configPath });
  fs.writeFileSync(configPath, JSON.stringify({ ...config, network: "loopback", address: config.address, binding: { ...nodeBinding, environmentId: 2 } }), { mode: 0o600 });
  await assert.rejects(changed.describe(), code("CONFLICT"), "a changed config is never used under the old admission");
  await delay(10);
  assert.deepEqual(fixtureFailures, []);
  console.log("ok: protocol-3 runner client: hello, status, vm requests and records, local validation, error vocabulary, protocol-2 refusal, lost answers, config version 2");
} finally {
  Object.assign(childProcess, processAPIs);
  syncBuiltinESMExports();
  await server.close();
  await accept;
  await Promise.all(tasks);
  fs.rmSync(root, { recursive: true, force: true });
}
