/** `cubed runners init-local` and `cubed runners enroll` against a fake
 * cube-runner (a script for keygen/init/run) whose runner answers from an
 * in-process npm iroh endpoint: the files written, the admission recorded,
 * the temporary runner stopped, and the refusals. The real cube-runner's
 * keygen and init run in scripts/test-local-runner.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createHash } from "node:crypto";
import { Endpoint, SecretKey } from "@number0/iroh/index.js";
import { Registry } from "../src/registry.ts";
import { localNodeId } from "../src/runner-enroll.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-local-runner-"));
const cli = path.resolve("packages/server/src/index.ts");
const key = SecretKey.generate();
const controlKey = SecretKey.generate();
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(key.toBytes());
builder.bindAddr("127.0.0.1:0");
builder.alpns([Array.from(Buffer.from("cubeyard/node/1"))]);
const server = await builder.bind();
const address = server.boundSockets().find(x => x.startsWith("127."))!;
const peer = Buffer.from(key.public().toBytes()).toString("hex");
const limits = { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64, maxSeedBytes: 65536, maxActiveVms: 2 };
const capabilities = ["node.status", "vm.allocate", "vm.start", "vm.stop", "vm.inspect", "vm.release", "vm.discard"];
const sha = "a".repeat(64);
const frame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
};
let hellos = 0;
let expectedNode = localNodeId();
const accept = (async () => {
  while (true) {
    const incoming = await server.acceptNext();
    if (!incoming) return;
    void (async () => {
      const connection = await (await incoming.accept()).connect();
      const nodeId = connection.remoteId().equals(controlKey.public()) ? expectedNode : "node-unauthorized";
      let stream = await connection.acceptBi();
      await stream.recv.readToEnd(1048580);
      hellos += 1;
      const binding = { nodeId, threadId: nodeId, environmentId: 1 };
      await stream.send.writeAll(frame({ type: "Hello", nodeId, protocolVersion: 3, minimumProtocolVersion: 3, softwareVersion: "0.8.4",
        binding, profiles: ["runner"], capabilities, limits, platform: "macos-aarch64", baseImageSha256: sha }));
      await stream.send.finish();
      stream = await connection.acceptBi();
      const query = JSON.parse(Buffer.from(await stream.recv.readToEnd(1048580)).subarray(4).toString());
      assert.equal(query.method, "node.status");
      await stream.send.writeAll(frame({ type: "Status", nodeId, protocolVersion: 3, minimumProtocolVersion: 3, softwareVersion: "0.8.4", binding,
        status: { lifecycle: "ready", draining: false, activeVms: 0, runningVms: 0, maxActiveVms: 2, retainedVms: 0, retainedBytes: 0 } }));
      await stream.send.finish();
    })().catch(() => {});
  }
})();

// The fake cube-runner: real argument shapes, no QEMU, no Iroh of its own.
const log = path.join(root, "runner.log");
const fakeRunner = path.join(root, "cube-runner");
fs.writeFileSync(fakeRunner, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  version) printf '%s\\n' '{"softwareVersion":"0.8.4","protocolVersion":3,"minimumProtocolVersion":3}' ;;
  keygen) shift; [ "$1" = --key ]; cp "$FAKE_CONTROL_KEY_FILE" "$2"; chmod 600 "$2"
    printf '{"peerId":"%s"}\\n' "$FAKE_CONTROL_PEER" ;;
  init) shift; home=""; while [ "$#" -gt 0 ]; do [ "$1" = --home ] && home="$2"; shift 2; done
    mkdir -m 700 "$home"; if [ "\${FAKE_INIT_FAIL:-}" = 1 ]; then echo 'Error: QEMU not found: qemu-system-aarch64' >&2; exit 1; fi; printf 'cube-runner 0.8.4\\ninitialized: %s\\nnode: x\\npeer: %s\\nnetwork: loopback\\nbase image: sha256 %s\\nqemu: /opt/homebrew/bin/qemu-system-aarch64\\n' "$home" "$FAKE_PEER" "${sha}" ;;
  run) if [ "\${FAKE_RUN_FAIL:-}" = 1 ]; then echo 'Error: Hypervisor.framework is not available (kern.hv_support != 1)' >&2; exit 1; fi
    trap 'printf "run stopped by SIGINT\\n" >> "${log}"; exit 0' INT
    echo 'network ready / waiting for cubed' >&2
    while :; do sleep 0.2; done ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
const controlKeyFile = path.join(root, "fake-control.key");
fs.writeFileSync(controlKeyFile, Buffer.from(controlKey.toBytes()), { mode: 0o600 });
const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, CUBE_RUNNER: fakeRunner, FAKE_PEER: peer,
  FAKE_CONTROL_PEER: Buffer.from(controlKey.public().toBytes()).toString("hex"), FAKE_CONTROL_KEY_FILE: controlKeyFile, ...extra });
// Asynchronous: the fake runner above serves from this event loop.
async function cubed(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [status] = await once(child, "close") as [number | null];
  return { status, stdout, stderr };
}
const state = path.join(root, "state");
const image = path.join(root, "debian.qcow2");
fs.writeFileSync(image, "QFI\xfb");

try {
  // A missing image, a non-loopback listen and a bad node id are refused before anything is written.
  const home = path.join(root, "cube");
  for (const [args, pattern] of [
    [["--image", path.join(root, "missing.qcow2"), "--home", home], /base image not found/],
    [["--image", image, "--home", home, "--listen", "0.0.0.0:7778"], /loopback address/],
    [["--image", image, "--home", home, "--node-id", "laptop"], /node-/],
    [["--image", image, "--home", home, "--max-vcpus", "two"], /positive integer/],
    [["--image", image, "--home", home, "--config", "/x.json"], /--config does not apply/],
  ] as const) {
    const refused = await cubed(["runners", "init-local", "--state", state, ...args]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, pattern);
    assert.ok(!fs.existsSync(home), "nothing is written for a refused request");
  }
  assert.match((await cubed(["runners", "enroll", "--state", state])).stderr, /needs --config/);
  assert.match((await cubed(["runners", "init-local", "--state", state, "--image", image, "--home", home, "--listen", "127.0.0.1:70000"])).stderr, /port from 1 to 65535/);

  // A failed init leaves nothing behind: the next attempt is not a rebinding.
  const failedInit = await cubed(["runners", "init-local", "--state", state, "--image", image, "--home", home, "--listen", address], { FAKE_INIT_FAIL: "1" });
  assert.equal(failedInit.status, 1);
  assert.match(failedInit.stderr, /cube-runner init failed: Error: QEMU not found/);
  assert.ok(!fs.existsSync(path.join(home, "control.key")) && !fs.existsSync(path.join(home, "runner")) && !fs.existsSync(path.join(home, "runner.json")),
    "a failed init removes the unused key and the partial home");
  fs.rmSync(log);

  // The whole flow: keygen, init, config, a temporary run, enrollment, stop.
  const done = await cubed(["runners", "init-local", "--state", state, "--image", image, "--home", home, "--listen", address,
    "--max-memory-mib", "4096"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, "runner.json"), "utf8"));
  assert.deepEqual(config, { version: 2, binding: { nodeId: expectedNode, threadId: expectedNode, environmentId: 1 },
    controlKey: path.join(home, "control.key"), serverPeer: peer, address, network: "loopback" });
  assert.equal(fs.statSync(path.join(home, "runner.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(home, "runner")), "cube-runner init created its home");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls[0], "version");
  assert.equal(calls[1], `keygen --key ${path.join(home, "control.key")}`);
  assert.equal(calls[2], `init --home ${path.join(home, "runner")} --image ${image} --allow-peer ${env().FAKE_CONTROL_PEER} --node-id ${expectedNode}`
    + ` --thread-id ${expectedNode} --env 1 --network loopback --listen ${address} --max-memory-mib 4096`);
  assert.equal(calls[3], `run --home ${path.join(home, "runner")}`);
  assert.equal(calls[4], "run stopped by SIGINT", "the temporary runner is stopped as its first Ctrl-C would");
  assert.equal(calls.length, 5);
  assert.match(done.stdout, /enrolled in .*: cube-runner 0\.8\.4, macos-aarch64, up to 2 thread machines/);
  assert.match(done.stdout, /qemu:\s+\/opt\/homebrew\/bin\/qemu-system-aarch64/);
  assert.match(done.stdout, new RegExp(`next: start the runner .*cube-runner run --home ${path.join(home, "runner")}`));
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    const enrolled = registry.listRunners();
    assert.equal(enrolled.length, 1);
    assert.equal(enrolled[0].nodeId, expectedNode);
    assert.equal(enrolled[0].configPath, path.join(home, "runner.json"));
    assert.equal(enrolled[0].maxActiveVms, 2);
  } finally { registry.close(); }
  assert.ok(hellos >= 2, "the admission made an authenticated hello and a status exchange");

  // Never rebound: the same home is refused untouched.
  const again = await cubed(["runners", "init-local", "--state", state, "--image", image, "--home", home, "--listen", address]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists; a runner is never rebound/);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 6, "only the version check ran");

  // A runner that cannot start here (no accelerator): set up, not enrolled, and said so.
  // (Its address is a closed port: the fake endpoint above answers whether or not the fake `run` lives.)
  const second = path.join(root, "cube-two");
  expectedNode = "node-local-two";
  const unstarted = await cubed(["runners", "init-local", "--state", state, "--image", image, "--home", second, "--listen", "127.0.0.1:1",
    "--node-id", "node-local-two"], { FAKE_RUN_FAIL: "1" });
  assert.equal(unstarted.status, 1, unstarted.stdout + unstarted.stderr);
  assert.match(unstarted.stderr, /set up but not enrolled: the runner exited \(1\): Error: Hypervisor\.framework is not available/);
  assert.match(unstarted.stderr, new RegExp(`cubed runners enroll --config ${path.join(second, "runner.json")} --state ${state}`));
  assert.ok(fs.existsSync(path.join(second, "runner.json")), "the config stays for a later enrollment");

  // Later enrollment by hand; the fake keygen hands out one key, which the pool refuses to share.
  const shared = await cubed(["runners", "enroll", "--state", state, "--config", path.join(second, "runner.json")]);
  assert.equal(shared.status, 1);
  assert.match(shared.stderr, /control key already used by runner/);
  fs.writeFileSync(path.join(second, "control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  const unauthorized = await cubed(["runners", "enroll", "--state", state, "--config", path.join(second, "runner.json")]);
  assert.equal(unauthorized.status, 1, "a key the runner does not know is a wrong node, not an admission");
  fs.writeFileSync(path.join(second, "control.key"), Buffer.from(controlKey.toBytes()), { mode: 0o600 });
  // The first runner held that key; once it has another, and the second runner answers, the second is admitted.
  fs.writeFileSync(path.join(home, "control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  const secondConfig = JSON.parse(fs.readFileSync(path.join(second, "runner.json"), "utf8"));
  fs.writeFileSync(path.join(second, "runner.json"), JSON.stringify({ ...secondConfig, address }), { mode: 0o600 });
  const admitted = await cubed(["runners", "enroll", "--state", state, "--config", path.join(second, "runner.json")]);
  assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
  const summary = JSON.parse(admitted.stdout);
  assert.equal(summary.admitted, true);
  assert.equal(summary.nodeId, "node-local-two");
  assert.equal(summary.platform, "macos-aarch64");
  assert.equal(summary.maxActiveVms, 2);
  const status = await cubed(["runners", "status", "--state", state]);
  assert.match(status.stdout, /node-local-two: reachable; lifecycle=ready; machines=0 of 2/);

  // Without --image: the image comes from Debian's site (here a local stand-in),
  // verified against its SHA512SUMS, and goes once the runner has its copy.
  const imageName = process.platform === "darwin" ? "debian-13-genericcloud-arm64.qcow2" : "debian-13-genericcloud-amd64.qcow2";
  const bytes = Buffer.concat([Buffer.from("QFI\xfb", "binary"), Buffer.alloc(70000, 7)]);
  let serveBad = false;
  const requests: string[] = [];
  const site = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/SHA512SUMS") response.end(`${createHash("sha512").update(bytes).digest("hex")}  ${imageName}\n0123  other.qcow2\n`);
    else if (request.url === `/${imageName}`) { response.setHeader("content-length", bytes.length); response.end(serveBad ? Buffer.from(bytes.map(b => b ^ 1)) : bytes); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const siteBase = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  try {
    const third = path.join(root, "cube-three");
    expectedNode = "node-local-three";
    // The fake keygen hands out one key; free it from the second runner first.
    fs.writeFileSync(path.join(second, "control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
    serveBad = true;
    const corrupt = await cubed(["runners", "init-local", "--state", state, "--home", third, "--listen", address, "--node-id", "node-local-three"],
      { CUBE_DEBIAN_IMAGE_BASE: siteBase });
    assert.equal(corrupt.status, 1, corrupt.stdout + corrupt.stderr);
    assert.match(corrupt.stderr, /does not match Debian's SHA512SUMS/);
    assert.ok(!fs.existsSync(path.join(third, "images", imageName)) && !fs.existsSync(path.join(third, "images", `${imageName}.part`)), "a corrupt download is discarded");
    assert.ok(!fs.existsSync(path.join(third, "runner")), "nothing was initialized from it");
    serveBad = false;
    const fetched = await cubed(["runners", "init-local", "--state", state, "--home", third, "--listen", address, "--node-id", "node-local-three"],
      { CUBE_DEBIAN_IMAGE_BASE: siteBase });
    assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
    assert.match(fetched.stdout, new RegExp(`downloading ${imageName} \\(0 MB\\) from ${siteBase}`));
    assert.match(fetched.stdout, /downloaded .* \(checksum verified\)/);
    assert.match(fetched.stdout, /removed the download: the runner holds its own copy/);
    assert.ok(!fs.existsSync(path.join(third, "images")), "the download is gone once the runner has its copy");
    const initCall = fs.readFileSync(log, "utf8").trim().split("\n").filter(line => line.startsWith("init ")).at(-1)!;
    assert.match(initCall, new RegExp(`--image ${path.join(third, "images", imageName)} `), "the verified download was what init copied");
    assert.deepEqual(requests.filter(url => url === `/${imageName}`).length, 2, "one download per attempt");
  } finally { site.close(); }
  console.log("ok: runners init-local sets up, enrolls and stops a local runner; runners enroll admits a running one; rebinding and shared keys are refused");
} finally {
  await server.close();
  await accept;
  fs.rmSync(root, { recursive: true, force: true });
}
