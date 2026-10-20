/** `cubed runners init-local` and `cubed runners enroll` against a fake
 * berth (a script for version, keygen and vm, with berth's argument shapes
 * and first-run binding) whose runner answers protocol 4 from an in-process
 * npm iroh endpoint: the files written, the admission recorded, the
 * temporary berth stopped, the refusals, and every later run: after a
 * reinstall (nothing changes, nothing starts), with a moved state, after a
 * failed first run, with the service holding the directory, and with a
 * protocol-3 runner's files beside it (never touched). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream } from "@number0/iroh/index.js";
import { HelloAnswerSchema, OpenSchema, Runner_Kind } from "../src/gen/runner_pb.js";
import { Registry } from "../src/registry.ts";
import { localBerthNodeId, readBerthSettings } from "../src/runner-enroll.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-local-berth-"));
const cli = path.resolve("packages/server/src/index.ts");
const IMAGE = `docker.io/library/debian@sha256:${"c".repeat(64)}`;

// The runner: answers hello as the node the fake berth was bound to, only to the control key it was given.
const runnerKey = SecretKey.generate();
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(runnerKey.toBytes());
builder.bindAddr("127.0.0.1:0");
builder.alpns([Array.from(Buffer.from("cubeyard/runner/4"))]);
const server = await builder.bind();
const address = server.boundSockets().find(x => x.startsWith("127."))!;
const peer = Buffer.from(runnerKey.public().toBytes()).toString("hex");
const hex = (key: SecretKey) => Buffer.from(key.public().toBytes()).toString("hex");
let allowed = "";
let answersAs = "";
let hellos = 0;
function frame<D extends DescMessage>(schema: D, value: MessageInitShape<D>): number[] {
  const bytes = Buffer.from(toJsonString(schema, create(schema, value)));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Array.from(Buffer.concat([header, bytes]));
}
const accept = (async () => {
  for (;;) {
    const incoming = await server.acceptNext();
    if (!incoming) return;
    void (async () => {
      const connection = await (await incoming.accept()).connect();
      if (connection.remoteId().toString() !== allowed) { connection.close(1n, Array.from(Buffer.from("unauthorized"))); return; }
      for (;;) {
        let stream: BiStream;
        try { stream = await connection.acceptBi(); } catch { return; }
        const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
        const opened = fromJsonString(OpenSchema, Buffer.from(await stream.recv.readExact(length)).toString("utf8"), { ignoreUnknownFields: true });
        if (opened.kind.case !== "hello") { await stream.send.finish(); continue; }
        hellos += 1;
        await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, runner: { nodeId: answersAs, kind: Runner_Kind.VM, softwareVersion: "0.1.0",
          platform: { os: "macos", arch: "aarch64", baseImageSha256: "b".repeat(64) }, network: { mode: "loopback" },
          limits: { maxVcpus: 4, maxMemoryMib: 8192, maxDiskGib: 64, maxMachines: 2, maxBootBytes: 262144 } } }));
        await stream.send.finish();
      }
    })().catch(() => {});
  }
})();

// The fake berth: berth's arguments; `vm` binds its directory on the first
// run (and refuses another control peer or node later), prints the banner
// and waits for SIGTERM.
const log = path.join(root, "berth.log");
const fakeBerth = path.join(root, "bin", "berth");
fs.mkdirSync(path.dirname(fakeBerth));
fs.writeFileSync(fakeBerth, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  version) printf '%s\\n' '{"softwareVersion":"0.1.0","protocolVersion":4}' ;;
  keygen) [ "$2" = --key ]; [ ! -e "$3" ]; cp "$FAKE_CONTROL_KEY_FILE" "$3"; chmod 600 "$3"; printf '{"peerId":"%s"}\\n' "$FAKE_CONTROL_PEER" ;;
  vm) shift; dir='' peer='' node='' listen=''
    while [ "$#" -gt 0 ]; do case "$1" in --dir) dir=$2 ;; --allow-peer) peer=$2 ;; --node-id) node=$2 ;; --listen) listen=$2 ;; esac; shift 2; done
    if [ "\${FAKE_HELD:-}" = 1 ]; then echo "Error: another berth vm runs in $dir" >&2; exit 1; fi
    if [ "\${FAKE_VM_FAIL:-}" = 1 ]; then echo 'Error: accelerator hvf is not available' >&2; exit 1; fi
    mkdir -p "$dir/.berth"
    if [ -f "$dir/.berth/vm.json" ]; then
      grep -q "\\"allowedPeer\\": \\"$peer\\"" "$dir/.berth/vm.json" && grep -q "\\"nodeId\\": \\"$node\\"" "$dir/.berth/vm.json" \\
        || { echo "Error: $dir/.berth/vm.json already names this runner's control peer, node id and labels; a runner is never rebound" >&2; exit 1; }
    else
      printf '{\\n  "version": 1,\\n  "nodeId": "%s",\\n  "allowedPeer": "%s",\\n  "network": "loopback",\\n  "listen": "%s",\\n  "labels": {}\\n}' "$node" "$peer" "$listen" > "$dir/.berth/vm.json"
      echo "image: pulling $FAKE_IMAGE" >&2
    fi
    trap 'printf "vm stopped by SIGTERM\\n" >> "${log}"; exit 0' TERM
    printf 'dir: %s\\nnode: %s\\npeer: %s\\ncontrol peer: %s\\nwaiting for cubed; Ctrl-C stops the runner\\n' "$dir" "$node" "$FAKE_PEER" "$peer" >&2
    while :; do sleep 0.1; done ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
const keel = path.join(root, "keel");
fs.mkdirSync(keel);
for (const file of ["vmlinuz", "base.erofs"]) fs.writeFileSync(path.join(keel, file), file);
const tools = path.join(root, "tools");
fs.mkdirSync(tools);
for (const tool of ["qemu-system-aarch64", "qemu-system-x86_64", "qemu-img", "mkfs.erofs"]) fs.writeFileSync(path.join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

const controlKey = SecretKey.generate();
const controlKeyFile = path.join(root, "fake-control.key");
fs.writeFileSync(controlKeyFile, Buffer.from(controlKey.toBytes()), { mode: 0o600 });
allowed = controlKey.public().toString();
/** Homebrew's launcher: the programs by variable. */
const paths = (berth = fakeBerth): NodeJS.ProcessEnv => ({ CUBE_BERTH: berth, CUBE_BERTH_KEEL: keel, CUBE_BERTH_QEMU: path.join(tools, "qemu-system-aarch64"),
  CUBE_BERTH_QEMU_IMG: path.join(tools, "qemu-img"), CUBE_BERTH_MKFS_EROFS: path.join(tools, "mkfs.erofs") });
async function cubed(args: string[], extra: NodeJS.ProcessEnv = paths()): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, FAKE_PEER: peer, FAKE_CONTROL_PEER: hex(controlKey), FAKE_CONTROL_KEY_FILE: controlKeyFile,
    FAKE_IMAGE: IMAGE, ...extra };
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [status] = await once(child, "close") as [number | null];
  return { status, stdout, stderr };
}
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
/** Every file under a directory with its sha256: what "nothing changed" means. */
function snapshot(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile()) out[path.relative(directory, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return out;
}

try {
  const home = path.join(root, "cube");
  const state = path.join(root, "state");
  const init = (args: string[], extra?: NodeJS.ProcessEnv, at = state) => cubed(["runners", "init-local", "--state", at, "--home", home, ...args], extra);
  answersAs = localBerthNodeId();
  assert.match(answersAs, /^node-berth-[a-z0-9-]+$/);
  assert.notEqual(answersAs.replace("node-berth-", "node-local-"), answersAs, "never a protocol-3 local runner's id");

  // Refused before anything is written: no image the first time, an unpinned
  // image, a non-loopback listen, a bad node id or limit, a stray option.
  for (const [args, pattern] of [
    [[], /--image <registry\/repository@sha256:…> is needed the first time/],
    [["--image", "debian:trixie"], /must be pinned/],
    [["--image", IMAGE, "--listen", "0.0.0.0:7779"], /loopback IPv4 address/],
    [["--image", IMAGE, "--listen", "127.0.0.1:70000"], /port from 1 to 65535/],
    [["--image", IMAGE, "--node-id", "laptop"], /node-/],
    [["--image", IMAGE, "--max-machines", "0"], /1 through 64/],
    [["--image", IMAGE, "--config", "/x.json"], /--config does not apply/],
  ] as const) {
    const refused = await init([...args]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, pattern);
    assert.ok(!fs.existsSync(home), "nothing is written for a refused request");
  }
  const noKeel = await init(["--image", IMAGE, "--listen", address], { ...paths(), CUBE_BERTH_KEEL: "" });
  assert.match(noKeel.stderr, /give --keel <directory> or set CUBE_BERTH_KEEL/);
  const noBerth = await init(["--image", IMAGE, "--listen", address], { ...paths(), CUBE_BERTH: "", PATH: "/usr/bin:/bin" });
  assert.match(noBerth.stderr, /berth was not found on PATH \(give --berth or set CUBE_BERTH\)/);
  assert.ok(!fs.existsSync(home), "a missing program writes nothing");
  assert.match((await cubed(["runners", "enroll", "--state", state])).stderr, /needs --config/);

  // A protocol-3 local runner's files beside it: never read, never touched.
  fs.mkdirSync(path.join(home, "runner"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "runner", "journal.db"), "p3 journal");
  fs.writeFileSync(path.join(home, "runner.json"), "{\"version\":2}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(home, "control.key"), Buffer.alloc(32, 3), { mode: 0o600 });
  const p3 = snapshot(home);

  // The first run: keygen, berth.env, berth's first run (binding, pull, banner), berth.json, enrollment, SIGTERM.
  const first = await init(["--image", IMAGE, "--listen", address]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /starting berth vm in .* for the first time: it makes its key and pulls docker\.io\/library\/debian@sha256:c+/);
  assert.match(first.stdout, /berth: image: pulling/, "berth's progress is shown");
  assert.match(first.stdout, new RegExp(`enrolled in ${state}: berth 0\\.1\\.0, macos/aarch64, up to 2 thread machines`));
  assert.match(first.stdout, /next: start or restart its service \(Homebrew: brew services restart cubeyard\/tap\/cube-berth cubeyard\/tap\/cube\)/);
  const configPath = path.join(home, "berth.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { version: 2, protocol: 4, binding: { nodeId: answersAs, threadId: answersAs, environmentId: 1 },
    controlKey: path.join(home, "berth.control.key"), serverPeer: peer, network: "loopback", address });
  for (const file of ["berth.json", "berth.control.key", "berth.env"]) assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600, file);
  assert.deepEqual(readBerthSettings(fs.readFileSync(path.join(home, "berth.env"), "utf8")), { image: IMAGE, maxMachines: 2 });
  assert.deepEqual(calls(), ["version", `keygen --key ${path.join(home, "berth.control.key")}`,
    `vm --dir ${path.join(home, "berth")} --qemu ${path.join(tools, "qemu-system-aarch64")} --qemu-img ${path.join(tools, "qemu-img")} --keel ${keel}`
    + ` --mkfs-erofs ${path.join(tools, "mkfs.erofs")} --image ${IMAGE} --max-machines 2 --allow-peer ${hex(controlKey)} --node-id ${answersAs}`
    + ` --network loopback --listen ${address}`, "vm stopped by SIGTERM"]);
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    const enrolled = registry.listRunners();
    assert.equal(enrolled.length, 1);
    assert.equal(enrolled[0]!.nodeId, answersAs);
    assert.equal(enrolled[0]!.protocol, 4);
    assert.equal(enrolled[0]!.kind, "vm");
    assert.equal(enrolled[0]!.configPath, configPath);
    assert.equal(enrolled[0]!.maxActiveVms, 2);
  } finally { registry.close(); }
  assert.ok(hellos >= 1, "the admission made an authenticated hello");
  for (const [file, digest] of Object.entries(p3)) assert.equal(snapshot(home)[file], digest, `the protocol-3 ${file} is untouched`);

  // Again, as after `brew uninstall` and `brew install`: the same command,
  // without --image, from another berth path, and with no berth at all.
  const done = snapshot(home);
  const callsBefore = calls().length;
  const reinstalled = path.join(root, "Cellar", "cube-berth", "9.9.9", "bin");
  fs.mkdirSync(reinstalled, { recursive: true });
  fs.copyFileSync(fakeBerth, path.join(reinstalled, "berth"));
  for (const [args, extra] of [
    [["--image", IMAGE, "--listen", address], paths()],
    [[], paths(path.join(reinstalled, "berth"))],
    [[], { CUBE_BERTH: path.join(root, "gone") }],
  ] as const) {
    const again = await init([...args], extra);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, new RegExp(`already set up and enrolled in ${state}; nothing changed`));
    assert.match(again.stdout, /next: start or restart its service/);
  }
  assert.equal(calls().length, callsBefore, "a run with everything in place starts nothing, not even berth version");
  assert.deepEqual(snapshot(home), done, "nothing changed");

  // What disagrees with what is there is refused, and changes nothing.
  for (const [args, pattern] of [
    [["--image", `docker.io/library/debian@sha256:${"d".repeat(64)}`], /names the image docker\.io\/library\/debian@sha256:c+; init-local changes nothing/],
    [["--listen", "127.0.0.1:7999"], new RegExp(`this runner listens on ${address}`)],
    [["--node-id", "node-other"], new RegExp(`this runner is ${answersAs}`)],
    [["--max-machines", "3"], /says 2 machines at once/],
  ] as const) {
    const refused = await init([...args]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, pattern);
  }
  assert.deepEqual(snapshot(home), done);
  assert.equal(calls().length, callsBefore);

  // Only berth.env gone (the user removed it): written again, nothing else, nothing started.
  fs.rmSync(path.join(home, "berth.env"));
  const settingsOnly = await init([]);
  assert.equal(settingsOnly.status, 1, "without it the image is not known");
  assert.match(settingsOnly.stderr, /--image .* is needed the first time/);
  const rewritten = await init(["--image", IMAGE]);
  assert.equal(rewritten.status, 0, rewritten.stdout + rewritten.stderr);
  assert.match(rewritten.stdout, /enrolled in .* already; wrote only what was missing/);
  assert.deepEqual(snapshot(home), done, "berth.env is as before");
  assert.equal(calls().length, callsBefore);

  // A moved cubed state: enrolled again from the same files (no new key, no new binding).
  const moved = path.join(root, "state-moved");
  const reenrolled = await init([], paths(), moved);
  assert.equal(reenrolled.status, 0, reenrolled.stdout + reenrolled.stderr);
  assert.match(reenrolled.stdout, /starting berth vm in .* to enroll it/);
  assert.match(reenrolled.stdout, new RegExp(`enrolled in ${moved}`));
  assert.deepEqual(calls().slice(callsBefore).map(line => line.split(" ")[0]), ["version", "vm", "vm"], "berth version, vm, its SIGTERM line; no keygen");
  assert.deepEqual(snapshot(home), done, "nothing in the home changed");

  // The service holds the directory: whoever answers with its key is enrolled.
  const held = path.join(root, "state-held");
  const viaService = await init([], { ...paths(), FAKE_HELD: "1" }, held);
  assert.equal(viaService.status, 0, viaService.stdout + viaService.stderr);
  assert.match(viaService.stdout, new RegExp(`enrolled in ${held}`));

  // A retired runner is not admitted again.
  const db = new DatabaseSync(path.join(state, "registry.sqlite"));
  db.prepare("UPDATE runner_operator SET retired_at=?, retirement_reason='test' WHERE runner_id=?").run(Date.now(), answersAs);
  db.close();
  const retired = await init([]);
  assert.equal(retired.status, 1);
  assert.match(retired.stderr, /is retired in .*; init-local does not admit it again/);

  // A failed first run (no accelerator) leaves what it made, says so, and the next run continues.
  const second = path.join(root, "cube-two");
  const state2 = path.join(root, "state-two");
  answersAs = "node-berth-two";
  const twoArgs = ["runners", "init-local", "--state", state2, "--home", second, "--node-id", "node-berth-two", "--listen", address];
  fs.writeFileSync(path.join(home, "berth.control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  const failed = await cubed([...twoArgs, "--image", IMAGE], { ...paths(), FAKE_VM_FAIL: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /set up but not enrolled: berth exited \(1\): Error: accelerator hvf is not available/);
  assert.match(failed.stderr, /run cubed runners init-local again \(it continues where it stopped\)/);
  assert.ok(fs.existsSync(path.join(second, "berth.control.key")) && fs.existsSync(path.join(second, "berth.env")), "the key and settings stay");
  assert.ok(!fs.existsSync(path.join(second, "berth.json")), "no config without a peer");
  const keygens = calls().filter(line => line.startsWith("keygen")).length;
  const continued = await cubed(twoArgs);
  assert.equal(continued.status, 0, continued.stdout + continued.stderr);
  assert.equal(calls().filter(line => line.startsWith("keygen")).length, keygens, "the key from the failed run is used, not a new one");
  assert.equal(JSON.parse(fs.readFileSync(path.join(second, "berth.json"), "utf8")).serverPeer, peer);

  // A control key that is not the one berth was bound to is refused before berth runs.
  fs.rmSync(path.join(second, "berth.json"));
  fs.writeFileSync(path.join(second, "berth.control.key.new"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  fs.renameSync(path.join(second, "berth.control.key.new"), path.join(second, "berth.control.key"));
  const rebinding = await cubed(twoArgs);
  assert.equal(rebinding.status, 1);
  assert.match(rebinding.stderr, /takes another control peer than .*berth\.control\.key's/);

  // A berth host directory is not taken for a berth vm.
  const third = path.join(root, "cube-three");
  fs.mkdirSync(path.join(third, "berth", ".berth"), { recursive: true });
  fs.writeFileSync(path.join(third, "berth", ".berth", "host.json"), "{}");
  const hostDir = await cubed(["runners", "init-local", "--state", state2, "--home", third, "--image", IMAGE]);
  assert.match(hostDir.stderr, /is a berth host directory/);
  console.log("ok: runners init-local sets up and enrolls a local berth vm, and every later run (reinstall, moved state, failed first run, held directory) changes only what is missing");
} finally {
  await server.close();
  await accept;
  fs.rmSync(root, { recursive: true, force: true });
}
