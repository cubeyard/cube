/** `berth vm` pulls its own image (masterplan B-7), against the real binary,
 * a real registry, the host's mkfs.erofs and QEMU, in a directory of its own:
 *
 *   1. a cold start in an empty directory pulls the image before the runner
 *      listens: no QUIC connection is accepted until the image is there;
 *   2. a warm start fetches nothing, and the layer files are unchanged;
 *   3. a layer file the cache lost is fetched again, with the same sha256;
 *   4. SIGINT and SIGKILL while mkfs.erofs converts a layer: no mkfs.erofs
 *      is left (on macOS, which has no PR_SET_PDEATHSIG, it must end by
 *      itself), nothing half-written is published, and the next start
 *      finishes with the same bytes;
 *   5. the cache limit: a machine created on image A and retained keeps A's
 *      layers through a start on image B with --layer-cache-gib 0; discarding
 *      it removes them, and B's stay;
 *   6. with CUBE_TEST_BERTH_SMALL_DIR (a directory on a file system with
 *      less than 2 GiB + 3 × image B's largest blob free, such as a small
 *      tmpfs or a mounted disk image): a cold start there is refused before
 *      the blob is fetched, publishes nothing and never listens.
 *
 *   node packages/server/test/runner-image-test.ts target/debug/berth
 *
 * Needs CUBE_TEST_BERTH_QEMU, CUBE_TEST_BERTH_QEMU_IMG, CUBE_TEST_BERTH_KEEL,
 * CUBE_TEST_BERTH_IMAGE and CUBE_TEST_BERTH_MKFS as runner-vm-test.ts does,
 * and CUBE_TEST_BERTH_IMAGE_B (a second, small public image pinned by
 * digest, with this host's platform). No machine boots, so no accelerator is
 * used, but berth vm checks the QEMU floor when it starts. Without
 * CUBE_TEST_BERTH_SMALL_DIR free space is tested only in berth's own tests
 * (image/tests.rs). Works under /tmp/cim-* unless CUBE_TEST_BERTH_TMP names another
 * (short) directory, and removes it at the end. Mocks are not runner
 * acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import dgram from "node:dgram";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Endpoint, EndpointAddr, SecretKey } from "@number0/iroh/index.js";
import { MachineStatus_Phase } from "../src/gen/runner_pb.js";
import { RunnerSession, loadSessionConfig } from "../src/runner-session.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const [qemu, qemuImg, keel, imageA, imageB, mkfs] = ["QEMU", "QEMU_IMG", "KEEL", "IMAGE", "IMAGE_B", "MKFS"]
  .map(name => env[`CUBE_TEST_BERTH_${name}`] ?? "");
const missing = [
  ...(path.isAbsolute(qemu!) && fs.existsSync(qemu!) ? [] : ["CUBE_TEST_BERTH_QEMU"]),
  ...(path.isAbsolute(qemuImg!) && fs.existsSync(qemuImg!) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG"]),
  ...(fs.existsSync(path.join(keel!, "vmlinuz")) && fs.existsSync(path.join(keel!, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(imageA!) ? [] : ["CUBE_TEST_BERTH_IMAGE"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(imageB!) && imageB !== imageA ? [] : ["CUBE_TEST_BERTH_IMAGE_B (another image than CUBE_TEST_BERTH_IMAGE)"]),
  ...(path.isAbsolute(mkfs!) && fs.existsSync(mkfs!) ? [] : ["CUBE_TEST_BERTH_MKFS"]),
];
if (missing.length) {
  console.error(`SKIP: runner-image-test did NOT run; missing: ${missing.join(", ")}`);
  process.exit(env.CUBE_TEST_BERTH_VM === "required" ? 1 : 0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cim-")));
const directory = path.join(root, "m");
const layers = path.join(directory, "layers", "1");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const node = "node-image-test";
const note = (line: string) => console.log(`runner-image-test: ${line}`);
const darwin = process.platform === "darwin";

/** A UDP port nothing listens on now (QUIC is UDP). */
async function freePort(): Promise<number> {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  socket.close();
  return port;
}
const port = await freePort();
const args = (image: string, extra: string[] = []) => ["vm", "--dir", directory, "--qemu", qemu!, "--qemu-img", qemuImg!, "--keel", keel!,
  "--mkfs-erofs", mkfs!, "--accel", "tcg", "--image", image, "--listen", `127.0.0.1:${port}`, ...extra];

type Runner = { child: ChildProcess; stderr: () => string; exited: Promise<number | null> };
function launch(image: string, extra: string[] = []): Runner {
  const child = spawn(binary, args(image, extra), { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let text = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", chunk => { text += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  return { child, stderr: () => text, exited };
}
async function until(what: string, ms: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const PULL_MS = 30 * 60 * 1000;
async function ready(runner: Runner): Promise<string> {
  await Promise.race([
    until("waiting for cubed", PULL_MS, () => runner.stderr().includes("waiting for cubed")),
    runner.exited.then(code => { throw new Error(`berth vm exited (${code}): ${runner.stderr()}`); }),
  ]);
  return runner.stderr();
}
/** To berth alone, not its process group: mkfs.erofs must be ended by berth
 * (SIGINT) or by its own death (SIGKILL), not by the signal. */
async function stop(runner: Runner, signal: NodeJS.Signals = "SIGINT"): Promise<number | null> {
  if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill(signal);
  return await runner.exited;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Whether a QUIC connection to the runner's port gets an answer within 3 s. */
async function answers(): Promise<boolean> {
  const runnerKey = fs.readFileSync(path.join(directory, ".berth", "runner.key"));
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(SecretKey.fromBytes(Array.from(fs.readFileSync(controlKey))).toBytes());
  builder.alpns([]);
  builder.bindAddr("127.0.0.1:0");
  const endpoint = await builder.bind();
  try {
    const peer = SecretKey.fromBytes(Array.from(runnerKey)).public();
    const connection = await Promise.race([
      endpoint.connect(new EndpointAddr(peer, null, [`127.0.0.1:${port}`]), Array.from(Buffer.from("cubeyard/runner/4"))),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
    ]).catch(() => null);
    if (!connection) return false;
    connection.close(0n, []);
    return true;
  } finally { await endpoint.close(); }
}

/** name -> sha256 of every published layer file. */
function published(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of fs.existsSync(layers) ? fs.readdirSync(layers) : []) {
    if (name.endsWith(".erofs") && !name.startsWith(".tmp-")) files.set(name, createHash("sha256").update(fs.readFileSync(path.join(layers, name))).digest("hex"));
  }
  return files;
}
const fetched = (text: string) => text.split("\n").filter(line => /^layer \d+ sha256:[0-9a-f]{64}: fetched /.test(line));
/** The record's layers of an image (bottom first). */
function recordOf(image: string): { diffId: string; file: string; blob: { size: number } }[] {
  const digest = image.split("@")[1]!;
  return (JSON.parse(fs.readFileSync(path.join(directory, "images", `${digest}.json`), "utf8")) as { layers: { diffId: string; file: string; blob: { size: number } }[] }).layers;
}
/** mkfs.erofs processes whose parent is `pid`. */
function mkfsChildren(pid: number): number[] {
  const run = spawnSync("pgrep", ["-P", String(pid), "-x", path.basename(mkfs!)], { encoding: "utf8" });
  return run.stdout.split("\n").filter(Boolean).map(Number);
}
/** Every mkfs.erofs this account runs (by process name, not command line,
 * which a shell running this test may contain). */
function mkfsRunning(): number[] {
  const run = spawnSync("pgrep", ["-u", String(process.getuid!()), "-x", path.basename(mkfs!)], { encoding: "utf8" });
  return run.stdout.split("\n").filter(Boolean).map(Number);
}

let runner: Runner | undefined;
try {
  // 1. cold: the pull comes before the endpoint
  let started = Date.now();
  runner = launch(imageA!, ["--allow-peer", control.peerId, "--node-id", node]);
  await until("the pull starts", 60000, () => / pulling /.test(runner!.stderr()) || runner!.child.exitCode !== null);
  assert.equal(runner.child.exitCode, null, runner.stderr());
  let probes = 0;
  while (!runner.stderr().includes("waiting for cubed")) {
    if (runner.child.exitCode !== null) throw new Error(`berth vm exited: ${runner.stderr()}`);
    const answered = await answers();
    if (answered) {
      // Only in the instant between the bind and its line, after the pull.
      await new Promise(resolve => setTimeout(resolve, 1000));
      assert.match(runner.stderr(), /^listen: /m, `a QUIC connection was answered during the pull: ${runner.stderr()}`);
      break;
    }
    probes++;
    if (probes >= 50) break;
  }
  let text = await ready(runner);
  const lines = text.split("\n");
  assert.ok(lines.findIndex(l => / pulling /.test(l)) < lines.findIndex(l => l.startsWith("listen: ")), text);
  assert.ok(await answers(), "the runner answers once it is ready");
  const layersA = recordOf(imageA!);
  assert.equal(fetched(text).length, layersA.length, text);
  const cold = published();
  assert.equal(cold.size, layersA.length);
  note(`1 cold: ${layersA.length} layers pulled in ${((Date.now() - started) / 1000).toFixed(1)} s before listening; ${probes} QUIC probes during the pull got no answer; ${text.split("\n").find(l => l.startsWith("layer cache:"))}`);
  await stop(runner);

  // 2. warm: nothing fetched, nothing changed
  started = Date.now();
  runner = launch(imageA!);
  text = await ready(runner);
  assert.match(text, /^image: .+ is in /m);
  assert.deepEqual(fetched(text), []);
  assert.deepEqual(published(), cold);
  note(`2 warm: ready in ${((Date.now() - started) / 1000).toFixed(1)} s, nothing fetched, the same ${cold.size} files`);
  await stop(runner);

  // 3. a lost layer: fetched again, the same bytes
  const smallest = [...layersA].sort((a, b) => a.blob.size - b.blob.size)[0]!;
  fs.rmSync(path.join(directory, smallest.file), { force: true });
  runner = launch(imageA!);
  text = await ready(runner);
  assert.match(text, new RegExp(`^image: layer ${smallest.diffId} of .+ is not in the cache; pulling `, "m"));
  assert.equal(fetched(text).length, 1, text);
  assert.ok(fetched(text)[0]!.includes(smallest.diffId));
  assert.deepEqual(published(), cold, "the same sha256 for every layer");
  note(`3 lost layer: ${fetched(text)[0]}; sha256 ${cold.get(path.basename(smallest.file))} as before`);
  await stop(runner);

  // 4. SIGINT, then SIGKILL, while mkfs.erofs converts the largest layer
  const largest = [...layersA].sort((a, b) => b.blob.size - a.blob.size)[0]!;
  for (const signal of ["SIGINT", "SIGKILL"] as const) {
    fs.rmSync(path.join(directory, largest.file), { force: true });
    runner = launch(imageA!);
    const berth = runner.child.pid!;
    let children: number[] = [];
    await until("mkfs.erofs runs", PULL_MS, () => (children = mkfsChildren(berth)).length > 0 || runner!.child.exitCode !== null);
    assert.equal(children.length, 1, `no conversion seen: ${runner.stderr()}`);
    const code = await stop(runner, signal);
    if (signal === "SIGINT") {
      assert.equal(code, 1);
      assert.match(runner.stderr(), /cancelled/);
      assert.ok(!alive(children[0]!), "mkfs.erofs was reaped before berth exited");
    } else {
      // Linux: PR_SET_PDEATHSIG ends it at once. macOS: its input ends with
      // berth, so it must end by itself (erofs-utils 1.9.1 or later).
      await until(`mkfs.erofs ${children[0]} ends`, darwin ? 120000 : 5000, () => !alive(children[0]!));
    }
    assert.deepEqual(mkfsRunning(), [], "no mkfs.erofs of this test runs");
    assert.ok(!fs.existsSync(path.join(directory, largest.file)), "nothing half-converted is published");
    assert.ok(!runner.stderr().includes("waiting for cubed"));
    const leftovers = fs.readdirSync(layers).filter(n => n.startsWith(".tmp-")).length
      + fs.readdirSync(path.join(directory, "images")).filter(n => n.startsWith(".tmp-")).length;
    note(`4 ${signal} during the conversion of ${largest.diffId}: mkfs.erofs ${children[0]} gone, nothing published, ${leftovers} .tmp-* left`);
  }
  runner = launch(imageA!);
  text = await ready(runner);
  assert.equal(fetched(text).length, 1, text);
  assert.deepEqual(published(), cold, "the next start finishes with the same bytes");
  for (const part of [layers, path.join(directory, "images")]) assert.deepEqual(fs.readdirSync(part).filter(n => n.startsWith(".tmp-")), []);
  note("4 the next start removed the leftovers and published the same sha256");

  // 5. the limit: a retained machine keeps its layers until it is discarded
  const configPath = path.join(root, "runner.json");
  const peer = text.match(/^peer: (.+)$/m)![1]!.trim();
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 1 },
    controlKey, serverPeer: peer, network: "loopback", address: `127.0.0.1:${port}` }), { mode: 0o600 });
  let session = new RunnerSession(loadSessionConfig(configPath).config);
  const ref = { owner: "thread-image", id: randomBytes(8).toString("hex") };
  const fence = { epoch: 1n };
  await session.machine({ case: "machineCreate", value: { ref, fence, spec: { size: { vcpus: 1, memoryMib: 512, diskGib: 1 } } } });
  const retained = await session.machine({ case: "machineDelete", value: { ref, fence, retain: true } });
  assert.equal(retained.status?.phase, MachineStatus_Phase.RETAINED);
  await session.close();
  await stop(runner);
  runner = launch(imageB!, ["--layer-cache-gib", "0"]);
  text = await ready(runner);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, ".berth", "vm.json"), "utf8")).layerCacheGib, 0);
  const onlyA = layersA.filter(a => !recordOf(imageB!).some(b => b.diffId === a.diffId));
  assert.ok(onlyA.length > 0, "image B shares every layer with A; choose another");
  for (const layer of layersA) assert.ok(fs.existsSync(path.join(directory, layer.file)), `${layer.diffId} of the retained machine was removed`);
  assert.match(text, /^layer cache: \d+ bytes left of a 0-byte limit; the \d+ layers the runner's image and its machines use are kept beyond it$/m);
  note(`5 started on B with --layer-cache-gib 0: all ${layersA.length} layers of the retained machine kept`);
  session = new RunnerSession(loadSessionConfig(configPath).config);
  const discarded = await session.machine({ case: "machineDiscard", value: { ref, fence } });
  assert.equal(discarded.status?.phase, MachineStatus_Phase.DELETED);
  await session.close();
  await until("the eviction is logged", 10000, () => runner!.stderr().split("\n").filter(l => l.startsWith("layer cache: removed")).length >= onlyA.length);
  for (const layer of onlyA) assert.ok(!fs.existsSync(path.join(directory, layer.file)), `${layer.diffId} stayed after the discard`);
  for (const layer of recordOf(imageB!)) assert.ok(fs.existsSync(path.join(directory, layer.file)), `${layer.diffId} of the runner's image was removed`);
  note(`5 discarded: ${onlyA.length} layers only A had removed, B's ${recordOf(imageB!).length} kept`);
  await stop(runner);
  runner = undefined;

  // 6. too little free space: refused before the blob, never listening
  const small = env.CUBE_TEST_BERTH_SMALL_DIR;
  if (small) {
    const there = fs.mkdtempSync(path.join(small, "cim-small-"));
    try {
      const run = spawnSync(binary, ["vm", "--dir", there, "--qemu", qemu!, "--qemu-img", qemuImg!, "--keel", keel!, "--mkfs-erofs", mkfs!,
        "--accel", "tcg", "--image", imageB!, "--allow-peer", control.peerId, "--node-id", node], { encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" });
      assert.ok(run.status !== null && run.status !== 0, `not refused within 120 s: ${run.stderr}`);
      const said = run.stderr.match(/has (\d+) bytes free, and a blob needs 3 × its size \+ 2 GiB = (\d+)/);
      assert.ok(said, `not refused for space (is ${small} small enough?): ${run.stderr}`);
      assert.ok(Number(said[1]) < Number(said[2]));
      assert.doesNotMatch(run.stderr, /^listen: |waiting for cubed/m);
      const files = fs.readdirSync(path.join(there, "layers", "1")).concat(fs.readdirSync(path.join(there, "images")));
      assert.deepEqual(files, [], "nothing published or left");
      note(`6 ${small}: refused (${said[0]}), nothing published, never listened`);
    } finally { fs.rmSync(there, { recursive: true, force: true }); }
  } else note("6 skipped: no CUBE_TEST_BERTH_SMALL_DIR (free space is only tested in process)");
  console.log("ok: berth vm pulls its image before listening; warm start, lost layer, SIGINT/SIGKILL mid-conversion, retained layers and eviction");
} finally {
  if (runner) await stop(runner, "SIGKILL").catch(() => {});
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
