/** `cubed runners init-local` and `cubed runners enroll` against a fake
 * berth (a script for version, keygen and vm, with berth's argument shapes
 * and first-run binding) whose runner binds --listen and answers protocol
 * 4 from an npm iroh endpoint (fake-berth-runner.ts): the files written, the admission recorded, the
 * temporary berth stopped, the refusals, and every later run: after a
 * reinstall (nothing changes, nothing starts), with a moved state, after a
 * failed first run, after a pull of a digest that does not exist, with the
 * listen port in use (found before anything is written, or taken while
 * berth pulls), with the
 * service holding the directory (with and without a config), and with a
 * protocol-3 runner's files beside it (never touched). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SecretKey } from "@number0/iroh/index.js";
import { Registry } from "../src/registry.ts";
import { localBerthNodeId, readBerthSettings } from "../src/runner-enroll.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-local-berth-"));
const cli = path.resolve("packages/server/src/index.ts");
const IMAGE = `ghcr.io/example/guest@sha256:${"c".repeat(64)}`;

// The runner's key; the fake berth's runner (fake-berth-runner.ts) binds
// --listen with it, as berth does, and answers hello as the node it was given.
const runnerKey = SecretKey.generate();
const peer = Buffer.from(runnerKey.public().toBytes()).toString("hex");
const hex = (key: SecretKey) => Buffer.from(key.public().toBytes()).toString("hex");
const hellosFile = path.join(root, "hellos");
const hellos = () => fs.existsSync(hellosFile) ? fs.readFileSync(hellosFile, "utf8").split("\n").filter(Boolean).length : 0;
/** A loopback UDP port nothing holds now. */
async function freePort(): Promise<string> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise<void>(resolve => socket.close(resolve));
  return `127.0.0.1:${port}`;
}
/** Holds a loopback UDP port, as another program would. */
async function occupy(listen: string): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>(resolve => socket.bind(Number(listen.split(":")[1]), "127.0.0.1", resolve));
  return socket;
}
const address = await freePort();

// The fake berth: berth's arguments; `vm` binds its directory on the first
// run (and refuses another control peer or node later), pulls only
// FAKE_IMAGE or berth's own default (waiting for FAKE_PULL_GATE, if set, to exist), then its runner
// binds --listen, prints the banner and waits for SIGTERM.
const log = path.join(root, "berth.log");
const fakeBerth = path.join(root, "bin", "berth");
fs.mkdirSync(path.dirname(fakeBerth));
fs.writeFileSync(fakeBerth, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  version) printf '%s\\n' '{"softwareVersion":"0.1.0","protocolVersion":4}' ;;
  image) [ "$2" = check ]; if [ "\${FAKE_CHECK_REFUSE:-}" = 1 ]; then echo "Error: $4 serves ghcr.io/example/guest@sha256:ccc, an image of its operator's own" >&2; exit 1; fi ;;
  keygen) [ "$2" = --key ]; [ ! -e "$3" ]; cp "$FAKE_CONTROL_KEY_FILE" "$3"; chmod 600 "$3"; printf '{"peerId":"%s"}\\n' "$FAKE_CONTROL_PEER" ;;
  vm) shift; dir='' peer='' node='' listen='' image=''
    while [ "$#" -gt 0 ]; do case "$1" in --dir) dir=$2 ;; --allow-peer) peer=$2 ;; --node-id) node=$2 ;; --listen) listen=$2 ;; --image) image=$2 ;; esac; shift 2; done
    if [ "\${FAKE_HELD:-}" = 1 ]; then echo "Error: another berth vm runs in $dir" >&2; exit 1; fi
    if [ "\${FAKE_VM_FAIL:-}" = 1 ]; then echo 'Error: accelerator hvf is not available' >&2; exit 1; fi
    mkdir -p "$dir/.berth"
    if [ -f "$dir/.berth/vm.json" ]; then
      { [ -z "$peer" ] || grep -q "\\"allowedPeer\\": \\"$peer\\"" "$dir/.berth/vm.json"; } && { [ -z "$node" ] || grep -q "\\"nodeId\\": \\"$node\\"" "$dir/.berth/vm.json"; } \\
        || { echo "Error: $dir/.berth/vm.json already names this runner's control peer, node id and labels; a runner is never rebound" >&2; exit 1; }
      # As berth: what a start leaves out comes from vm.json; --listen is not kept.
      field() { sed -n "s/^  \\"$1\\": \\"\\(.*\\)\\",\\$/\\1/p" "$dir/.berth/vm.json"; }
      [ -n "$peer" ] || peer=$(field allowedPeer); [ -n "$node" ] || node=$(field nodeId); [ -n "$listen" ] || listen=$(field listen)
    else
      printf '{\\n  "version": 1,\\n  "nodeId": "%s",\\n  "allowedPeer": "%s",\\n  "network": "loopback",\\n  "listen": "%s",\\n  "labels": {}\\n}' "$node" "$peer" "$listen" > "$dir/.berth/vm.json"
      echo "image: pulling $image" >&2
    fi
    # As berth: the image is pulled after the directory is bound, before it listens.
    [ "$image" = "$FAKE_IMAGE" ] || [ "$image" = default ] || { echo "Error: pulling $image: manifest unknown" >&2; exit 1; }
    while [ -n "\${FAKE_PULL_GATE:-}" ] && [ ! -e "\${FAKE_PULL_GATE:-}" ]; do sleep 0.1; done
    FAKE_LOG="${log}" exec "${process.execPath}" "${path.resolve("packages/server/test/fake-berth-runner.ts")}" "$dir" "$node" "$peer" "$listen" ;;
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
/** Homebrew's launcher: the programs by variable. */
const paths = (berth = fakeBerth): NodeJS.ProcessEnv => ({ CUBE_BERTH: berth, CUBE_BERTH_KEEL: keel, CUBE_BERTH_QEMU: path.join(tools, "qemu-system-aarch64"),
  CUBE_BERTH_QEMU_IMG: path.join(tools, "qemu-img"), CUBE_BERTH_MKFS_EROFS: path.join(tools, "mkfs.erofs") });
async function cubed(args: string[], extra: NodeJS.ProcessEnv = paths()): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, FAKE_RUNNER_KEY: Buffer.from(runnerKey.toBytes()).toString("hex"),
    FAKE_HELLOS: hellosFile, FAKE_CONTROL_PEER: hex(controlKey), FAKE_CONTROL_KEY_FILE: controlKeyFile, FAKE_IMAGE: IMAGE, ...extra };
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
  const answersAs = localBerthNodeId();
  assert.match(answersAs, /^node-berth-[a-z0-9-]+$/);
  assert.notEqual(answersAs.replace("node-berth-", "node-local-"), answersAs, "never a protocol-3 local runner's id");

  // Refused before anything is written: an unpinned image, a non-loopback
  // listen, a bad node id or limit, a stray option.
  for (const [args, pattern] of [
    [["--image", "debian:trixie"], /--image must be default \(cube's default image; the same as leaving it out\) or your own image pinned/],
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
  assert.match(first.stdout, /starting berth vm in .* for the first time: it makes its key and pulls ghcr\.io\/example\/guest@sha256:c+/);
  assert.match(first.stdout, /berth: image: pulling/, "berth's progress is shown");
  assert.match(first.stdout, new RegExp(`enrolled in ${state}: berth 0\\.1\\.0, macos/aarch64, up to 2 thread machines`));
  assert.match(first.stdout, /next: start or restart its service \(Homebrew: brew services restart cubeyard\/tap\/cube-berth cubeyard\/tap\/cube\)/);
  const configPath = path.join(home, "berth.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { version: 2, protocol: 4, binding: { nodeId: answersAs, threadId: answersAs, environmentId: 1 },
    controlKey: path.join(home, "berth.control.key"), serverPeer: peer, network: "loopback", address });
  for (const file of ["berth.json", "berth.control.key", "berth.env"]) assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600, file);
  assert.deepEqual(readBerthSettings(fs.readFileSync(path.join(home, "berth.env"), "utf8")), { image: IMAGE, maxMachines: 2, listen: address });
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
  assert.ok(hellos() >= 1, "the admission made an authenticated hello");
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
    // A runner on its own image keeps it, also when no run gives --image.
    assert.match(again.stdout, /image: +ghcr\.io\/example\/guest@sha256:c+ \(your own: it must bring bash, sudo, flock, git, gh, curl and a CA bundle/);
  }
  assert.equal(calls().length, callsBefore, "a run with everything in place starts nothing, not even berth version");
  assert.deepEqual(snapshot(home), done, "nothing changed");

  // What disagrees with what is there is refused, and changes nothing.
  for (const [args, pattern] of [
    [["--image", `ghcr.io/example/guest@sha256:${"d".repeat(64)}`], /names the image ghcr\.io\/example\/guest@sha256:c+; init-local changes nothing/],
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
  assert.equal(settingsOnly.status, 1, "without it the image is not known, and never guessed as the default");
  assert.match(settingsOnly.stderr, /berth\.env is gone, and runner node-berth-[a-z0-9-]+ is enrolled: give --image as it was/);
  assert.ok(!fs.existsSync(path.join(home, "berth.env")));
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

  // The service holds the directory (and the port): whoever answers with its key is enrolled.
  const settings = readBerthSettings(fs.readFileSync(path.join(home, "berth.env"), "utf8"));
  const service = spawn(fakeBerth, ["vm", "--dir", path.join(home, "berth"), "--image", settings.image, "--max-machines", String(settings.maxMachines),
    "--listen", settings.listen], { env: { PATH: process.env.PATH, FAKE_IMAGE: IMAGE, FAKE_RUNNER_KEY: Buffer.from(runnerKey.toBytes()).toString("hex"),
    FAKE_HELLOS: hellosFile }, stdio: ["ignore", "ignore", "pipe"] });
  let banner = "";
  service.stderr.setEncoding("utf8");
  service.stderr.on("data", chunk => { banner += chunk; });
  for (let i = 0; i < 300 && !banner.includes("waiting for cubed"); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(banner, /waiting for cubed/, banner);
  try {
    const held = path.join(root, "state-held");
    const viaService = await init([], { ...paths(), FAKE_HELD: "1" }, held);
    assert.equal(viaService.status, 0, viaService.stdout + viaService.stderr);
    assert.match(viaService.stdout, new RegExp(`enrolled in ${held}`));
  } finally {
    service.kill("SIGTERM");
    await once(service, "close");
  }

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
  const twoArgs = ["runners", "init-local", "--state", state2, "--home", second, "--node-id", "node-berth-two", "--listen", address];
  fs.writeFileSync(path.join(home, "berth.control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  const failed = await cubed([...twoArgs, "--image", IMAGE], { ...paths(), FAKE_VM_FAIL: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /not enrolled: berth exited \(1\): Error: accelerator hvf is not available/);
  assert.match(failed.stderr, /run cubed runners init-local again \(it continues where it stopped/);
  assert.doesNotMatch(failed.stderr, /enroll --config|brew services/, "no advice that needs a berth.json or starts the service");
  assert.ok(fs.existsSync(path.join(second, "berth.control.key")), "the key stays");
  assert.ok(!fs.existsSync(path.join(second, "berth.env")) && !fs.existsSync(path.join(second, "berth.json")), "no settings and no config before berth listens");
  const keygens = calls().filter(line => line.startsWith("keygen")).length;
  const continued = await cubed([...twoArgs, "--image", IMAGE]);
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

  // B-1: a well-formed digest that does not exist. berth binds its directory
  // and then fails the pull; nothing records the image, so the corrected
  // --image continues, with no file edited or removed.
  const fourth = path.join(root, "cube-four");
  const state4 = path.join(root, "state-four");
  const fourArgs = ["runners", "init-local", "--state", state4, "--home", fourth, "--node-id", "node-berth-four", "--listen", address];
  const missing = `ghcr.io/example/guest@sha256:${"0".repeat(64)}`;
  const wrong = await cubed([...fourArgs, "--image", missing]);
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /not enrolled: berth exited \(1\): .*Error: pulling ghcr\.io\/example\/guest@sha256:0+: manifest unknown/);
  assert.doesNotMatch(wrong.stderr, /enroll --config|brew services/);
  assert.match(wrong.stderr, /until berth has listened once, --image, --max-machines and --listen may be given anew/);
  assert.ok(fs.existsSync(path.join(fourth, "berth", ".berth", "vm.json")), "berth bound its directory before the pull, as berth does");
  assert.ok(!fs.existsSync(path.join(fourth, "berth.env")) && !fs.existsSync(path.join(fourth, "berth.json")), "the wrong image is recorded nowhere");
  const bound = snapshot(fourth);
  // Without --image it is cube's default image (here berth then fails on
  // the accelerator); still nothing records it.
  const unknown = await cubed(fourArgs, { ...paths(), FAKE_VM_FAIL: "1" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /accelerator hvf is not available/);
  assert.match(calls().filter(line => line.startsWith("vm --dir ")).at(-1)!, / --image default /);
  assert.deepEqual(snapshot(fourth), bound);

  // Meanwhile a berth holds the directory (a service set up by hand, another
  // init-local): with no berth.json it cannot be asked, so the advice is to
  // stop it, never to enroll from a config that is not there.
  const blocked = await cubed([...fourArgs, "--image", IMAGE], { ...paths(), FAKE_HELD: "1" });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /another berth vm runs in .*cube-four\/berth and there is no .*cube-four\/berth\.json yet, so it cannot be asked: stop that berth vm \(a second init-local, or one started by hand\), then run init-local again/);
  assert.doesNotMatch(blocked.stderr, /enroll --config|brew services/);
  assert.deepEqual(snapshot(fourth), bound, "nothing written while it is held");

  // Stopped, the corrected image: the same key and binding, enrolled.
  const keygens4 = calls().filter(line => line.startsWith("keygen")).length;
  const corrected = await cubed([...fourArgs, "--image", IMAGE]);
  assert.equal(corrected.status, 0, corrected.stdout + corrected.stderr);
  assert.match(corrected.stdout, new RegExp(`enrolled in ${state4}`));
  assert.equal(calls().filter(line => line.startsWith("keygen")).length, keygens4, "no new control key");
  for (const file of ["berth.control.key", path.join("berth", ".berth", "vm.json")]) assert.equal(snapshot(fourth)[file], bound[file], `${file} is unchanged`);
  assert.deepEqual(readBerthSettings(fs.readFileSync(path.join(fourth, "berth.env"), "utf8")), { image: IMAGE, maxMachines: 2, listen: address });
  for (const file of ["berth.json", "berth.env"]) assert.equal(fs.statSync(path.join(fourth, file)).mode & 0o777, 0o600, file);
  // Enrolled, the image is fixed again.
  const afterwards = snapshot(fourth);
  const changed = await cubed([...fourArgs, "--image", missing]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /names the image ghcr\.io\/example\/guest@sha256:c+; init-local changes nothing/);
  assert.match((await cubed(fourArgs)).stdout, /already set up and enrolled/);
  assert.deepEqual(snapshot(fourth), afterwards);
  // berth.env without berth.json (init-local stopped between the two): the
  // image, slots and address are fixed, and the advice says so.
  fs.rmSync(path.join(fourth, "berth.json"));
  const between = await cubed(["runners", "init-local", "--state", path.join(root, "state-four-b"), "--home", fourth], { ...paths(), FAKE_VM_FAIL: "1" });
  assert.equal(between.status, 1, between.stdout + between.stderr);
  assert.match(between.stderr, /it continues where it stopped, with the image, slots and address in .*cube-four\/berth\.env\)/);
  assert.doesNotMatch(between.stderr, /given anew|enroll --config|brew services/);

  // U-B1-1: the listen port is in use at the first run. Found before
  // anything is written; and when it is taken only while berth pulls (the
  // check cannot rule that out), nothing records it either: berth's vm.json
  // keeps the address it tried, but a corrected --listen continues, with no
  // file edited, moved or removed, and the service is given that one.
  const fifth = path.join(root, "cube-five");
  const state5 = path.join(root, "state-five");
  const fiveArgs = ["runners", "init-local", "--state", state5, "--home", fifth, "--node-id", "node-berth-five", "--image", IMAGE];
  const busy = await freePort();
  const holder = await occupy(busy);
  const callsBefore5 = calls().length;
  const taken = await cubed([...fiveArgs, "--listen", busy]);
  assert.equal(taken.status, 1, taken.stdout + taken.stderr);
  assert.match(taken.stderr, new RegExp(`${busy.replaceAll(".", "\\.")} \\(UDP\\) is in use: give another --listen, or free it \\(nothing was written\\)`));
  assert.ok(!fs.existsSync(fifth), "nothing is written for a port in use");
  assert.deepEqual(calls().slice(callsBefore5), ["version"], "no keygen and no berth vm");
  holder.close();
  // Free at the check, taken before berth binds (after its pull).
  const racy = await freePort();
  const gate = path.join(root, "pull-gate");
  const raced = cubed([...fiveArgs, "--listen", racy], { ...paths(), FAKE_PULL_GATE: gate });
  const vm5 = path.join(fifth, "berth", ".berth", "vm.json");
  for (let i = 0; i < 300 && !fs.existsSync(vm5); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const thief = await occupy(racy);
  fs.writeFileSync(gate, "");
  const lost = await raced;
  fs.rmSync(gate);
  assert.equal(lost.status, 1, lost.stdout + lost.stderr);
  assert.match(lost.stderr, new RegExp(`not enrolled: berth exited \\(1\\): .*Error: binding ${racy.replaceAll(".", "\\.")}`));
  assert.match(lost.stderr, /until berth has listened once, --image, --max-machines and --listen may be given anew/);
  assert.doesNotMatch(lost.stderr, /enroll --config|brew services/);
  assert.equal(JSON.parse(fs.readFileSync(vm5, "utf8")).listen, racy, "berth's vm.json names the address it tried");
  assert.ok(!fs.existsSync(path.join(fifth, "berth.env")) && !fs.existsSync(path.join(fifth, "berth.json")), "the address is recorded nowhere of cubed's");
  const tried = snapshot(fifth);
  // Again without --listen: vm.json's address, still in use, refused before berth starts.
  const still = await cubed(fiveArgs);
  assert.equal(still.status, 1);
  assert.match(still.stderr, /\(UDP\) is in use: give another --listen/);
  assert.deepEqual(snapshot(fifth), tried);
  // A corrected --listen: the same key and binding, enrolled there.
  const keygens5 = calls().filter(line => line.startsWith("keygen")).length;
  const other = await freePort();
  const moved5 = await cubed([...fiveArgs, "--listen", other]);
  assert.equal(moved5.status, 0, moved5.stdout + moved5.stderr);
  assert.match(moved5.stdout, new RegExp(`enrolled in ${state5}`));
  assert.equal(calls().filter(line => line.startsWith("keygen")).length, keygens5, "no new control key");
  assert.match(calls().filter(line => line.startsWith("vm --dir ")).at(-1)!, new RegExp(`--listen ${other.replaceAll(".", "\\.")}$`));
  for (const file of ["berth.control.key", path.join("berth", ".berth", "vm.json")]) assert.equal(snapshot(fifth)[file], tried[file], `${file} is unchanged`);
  // The service and the config agree on the address berth listened on.
  assert.equal(JSON.parse(fs.readFileSync(path.join(fifth, "berth.json"), "utf8")).address, other);
  assert.deepEqual(readBerthSettings(fs.readFileSync(path.join(fifth, "berth.env"), "utf8")), { image: IMAGE, maxMachines: 2, listen: other });
  for (const file of ["berth.json", "berth.env"]) assert.equal(fs.statSync(path.join(fifth, file)).mode & 0o777, 0o600, file);
  thief.close();
  // Enrolled, the address is fixed: the one berth tried first is refused, and nothing changes.
  const enrolled5 = snapshot(fifth);
  const back = await cubed([...fiveArgs, "--listen", racy]);
  assert.equal(back.status, 1);
  assert.match(back.stderr, new RegExp(`this runner listens on ${other.replaceAll(".", "\\.")}; init-local changes nothing`));
  assert.match((await cubed(fiveArgs)).stdout, /already set up and enrolled/);
  assert.deepEqual(snapshot(fifth), enrolled5);

  // The normal first install: no --image. berth is started with its own
  // default (official Debian trixie, which it prepares for cube), and that
  // is what berth.env records, so the service follows berth's default.
  const plain = path.join(root, "cube-default");
  const statePlain = path.join(root, "state-default");
  const plainAddress = await freePort();
  const plainArgs = ["runners", "init-local", "--state", statePlain, "--home", plain, "--node-id", "node-berth-plain"];
  const fresh = await cubed([...plainArgs, "--listen", plainAddress]);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout, /for the first time: it makes its key and pulls cube's default image \(Debian trixie\), then prepares it for cube/);
  assert.match(fresh.stdout, /image: +default \(official Debian trixie, pinned by berth, which adds sudo, git, gh, curl and ca-certificates/);
  assert.match(fresh.stdout, new RegExp(`enrolled in ${statePlain}`));
  assert.match(calls().filter(line => line.startsWith("vm --dir ")).at(-1)!, / --image default --max-machines 2 /);
  assert.deepEqual(readBerthSettings(fs.readFileSync(path.join(plain, "berth.env"), "utf8")), { image: "default", maxMachines: 2, listen: plainAddress });
  const plainDone = snapshot(plain);
  for (const args of [[], ["--image", "default"]]) {
    const again = await cubed([...plainArgs, ...args]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already set up and enrolled/);
  }
  const own = await cubed([...plainArgs, "--image", IMAGE]);
  assert.equal(own.status, 1);
  assert.match(own.stderr, /names the image default; init-local changes nothing/);
  assert.deepEqual(snapshot(plain), plainDone, "nothing changed");

  // Official Debian alone as one's own image is refused (no machine on it
  // ever gets ready), before anything is written.
  const rawHome = path.join(root, "cube-raw");
  const rawDebian = `docker.io/library/debian:trixie@sha256:${"e".repeat(64)}`;
  const refusedRaw = await cubed(["runners", "init-local", "--state", path.join(root, "state-raw"), "--home", rawHome, "--image", rawDebian]);
  assert.equal(refusedRaw.status, 1);
  assert.match(refusedRaw.stderr, /is official Debian alone, which lacks sudo, git, gh, curl and a CA bundle.*leave out --image/);
  assert.ok(!fs.existsSync(rawHome), "nothing is written");

  // Recovery: a runner an earlier cube set up with official Debian alone
  // (berth.env names it, enrolled, its machines never ready). A run
  // without --image moves berth.env to the default, keeps the earlier file
  // beside it, starts nothing and changes nothing else; then it is set up.
  const settingsPath = path.join(plain, "berth.env");
  const asBefore = fs.readFileSync(settingsPath, "utf8").replace("CUBE_BERTH_IMAGE=default", `CUBE_BERTH_IMAGE=${rawDebian}`);
  fs.writeFileSync(settingsPath, asBefore, { mode: 0o600 });
  const brokenSnapshot = snapshot(plain);
  // N2: berth refuses the default there (it also served an image of the
  // operator's own): nothing moves, and the run says why.
  const checkRefused = await cubed(plainArgs, { ...paths(), FAKE_CHECK_REFUSE: "1" });
  assert.equal(checkRefused.status, 1, checkRefused.stdout + checkRefused.stderr);
  assert.match(checkRefused.stderr, /names docker\.io\/library\/debian:trixie@sha256:e+, official Debian alone, but berth would not serve cube's default image in .*: Error: .* serves ghcr\.io\/example\/guest@sha256:ccc.*\. Nothing was changed/);
  assert.doesNotMatch(checkRefused.stdout, /recovered:/);
  assert.deepEqual(snapshot(plain), brokenSnapshot, "nothing moved");
  const callsBeforeRecovery = calls().length;
  const recovering = await cubed(plainArgs);
  assert.equal(recovering.status, 0, recovering.stdout + recovering.stderr);
  assert.match(recovering.stdout, /recovered: berth\.env named official Debian alone; it now names cube's default image \(the earlier file is .*berth\.env\.official-debian\./);
  assert.match(recovering.stdout, /next: start or restart its service/);
  assert.doesNotMatch(recovering.stdout, /already set up and enrolled/);
  assert.deepEqual(calls().slice(callsBeforeRecovery), [`image check --dir ${path.join(plain, "berth")} --image default`], "only berth's check runs; nothing is started");
  assert.match(recovering.stdout, /a machine an earlier berth made has no record of that and is left as it was\. Nothing was deleted\./);
  assert.deepEqual(readBerthSettings(fs.readFileSync(settingsPath, "utf8")), { image: "default", maxMachines: 2, listen: plainAddress });
  const keptFiles = fs.readdirSync(plain).filter(name => name.startsWith("berth.env.official-debian."));
  assert.equal(keptFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(plain, keptFiles[0]!), "utf8"), asBefore, "the earlier file is kept as it was");
  assert.equal(fs.statSync(path.join(plain, keptFiles[0]!)).mode & 0o777, 0o600);
  const recoveredSnapshot = snapshot(plain);
  for (const [file, sum] of Object.entries(brokenSnapshot)) if (file !== "berth.env") assert.equal(recoveredSnapshot[file], sum, `${file} is unchanged`);
  const settled = await cubed(plainArgs);
  assert.match(settled.stdout, /already set up and enrolled/);
  assert.deepEqual(snapshot(plain), recoveredSnapshot, "a second run changes nothing");
  // An image of one's own is never moved (the first home names IMAGE; see the reinstall runs above).

  // A berth host directory is not taken for a berth vm.
  const third = path.join(root, "cube-three");
  fs.mkdirSync(path.join(third, "berth", ".berth"), { recursive: true });
  fs.writeFileSync(path.join(third, "berth", ".berth", "host.json"), "{}");
  const hostDir = await cubed(["runners", "init-local", "--state", state2, "--home", third, "--image", IMAGE]);
  assert.match(hostDir.stderr, /is a berth host directory/);
  console.log("ok: runners init-local sets up and enrolls a local berth vm, and every later run (reinstall, moved state, failed first run, the default image without --image, an unknown image digest then the corrected one, a listen port in use then another, a held directory with and without a config) changes only what is missing");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
