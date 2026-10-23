/** Runner protocol 4 against the real `berth vm` (masterplan B-1 and B-2):
 * the session part of runner-host-test.ts (hello, a wrong node, create,
 * watch, fencing, a runner restart, delete) with keel machines
 * under QEMU, plus what only a VM runner has: keel's QEMU floor, a pinned
 * machine type, a read-only layer disk built from a pulled image, a retained
 * writable disk, machines a runner restart interrupts, the runner's own CA,
 * and the guest channel (B-2): `status.guest` from the agent's `hello` and
 * `status` with a session, `machine_setup` with the image's layers and the
 * boot documents, and `guest` streams carried as `req`/`ans`. Loopback only.
 * With an image that is ready (curl, git), also the machine's network
 * (B-4, V5): HTTPS through the runner's interception trusted through its
 * CA, private, metadata, the host's own and cubed's addresses refused,
 * CONNECT, Upgrade and other ports refused, deny_hosts, DENY, credential
 * rules and placeholders, a policy replaced by a new start, the lease
 * (3 s here) running out (new flows and requests refused, a download's
 * upstream closed, an open connection left to drain) and cubed's return, and
 * the runner's report stream read as cubed would read it, with
 * `dropped_before` after its queue overflowed. Then (B-5, V6-V8) the
 * credential stream through the real chain: the guest -> berth vm -> cubed's
 * RunnerSession -> cube-gateway's credential proxy (built with test-hooks;
 * CUBE_TEST_BERTH_GATEWAY names another build) -> the fake GitHub
 * (fake-github.ts): `gh api user`, `git push` (and a timed 100 MiB push),
 * the token echoed back only as the guest's placeholder (Bearer and Basic,
 * Content-Length and chunked, split across chunks), an encoded answer
 * refused, redirects, a placeholder refused at the wrong host, the fence,
 * cubed going during a download, and a scan for the token in the guest, the
 * runner's directory (leak-scan.ts) and every log. Then (B-6, V9) the
 * portal over `dial` streams: cubed's real Portal -> RunnerSession.dial ->
 * berth vm -> the machine's LAN -> dial-app.pl started with `cube service`
 * in the guest (portal-dial.ts): HTTP, 1 MiB each way, a WebSocket, FIN
 * from each side; ports 80 (with a listener) and 22 refused, an old fence
 * refused, an open connection ended when cubed goes and when the machine
 * stops, and a stopped machine refused. Then (B-8, V10) templates as layers:
 * a build machine's blank, sparse vdd, `template_publish` (READY, the layer
 * cut to size and read-only, the build machine deleted, asked again the
 * same), a machine from the template with the build's files but none of
 * cube's blocks from the build and the runner's CA only where the build
 * left it beyond the cleaning (a keystore stand-in: the template is bound
 * to the CA), a write kept over a stop, the template across a restart,
 * refused under a new runner CA (template_runner_ca_changed) and on another
 * image (CUBE_TEST_BERTH_IMAGE_B, template_image_changed), and
 * template_delete (REMOVING, gone with its last machine).
 * CUBE_TEST_BERTH_JAVA=1 adds a real JDK: installed by a build machine's
 * setup with apt alone, published, and Java's own HTTPS (example.com,
 * services.gradle.org) from a machine made from the template, whose
 * keystore keel repairs at boot without the CA and with a stale one, both
 * machines started with cubed's own public policy (`EgressPolicy.policyFor`). CUBE_TEST_KEEP=1
 * keeps a failed run's directory. CUBE_TEST_BERTH_FSCK names an
 * fsck.erofs to check the layer with. And (B-9) `machine_diagnose`: one
 * bounded, redacted JSON document about a running, a paused and a stopped
 * machine (QEMU's path, version and argv as the process has them,
 * `query-status`, the tails of the serial console (the kernel's, cube-init's
 * and the agent's output; a thread's commands have no console device, so
 * the test makes a /dev/console node in the workload's /dev for its plant)
 * and of the events, the agent's GuestInfo,
 * egress, and Iroh's path in use to cubed with its RTT, also as
 * `Network.rtt_to_cubed` in hello), fenced, changing nothing, with neither
 * the token nor a placeholder in it.
 *
 *   node packages/server/test/runner-vm-test.ts target/debug/berth
 *
 * Always: berth vm refuses to start without QEMU given by path, and with
 * CUBE_TEST_BERTH_OLD_QEMU (a QEMU below the floor, such as Ubuntu 24.04's
 * 8.2.2) it refuses that QEMU and writes nothing. The machines need
 * CUBE_TEST_BERTH_QEMU and CUBE_TEST_BERTH_QEMU_IMG (absolute paths to a
 * QEMU that meets the floor and its qemu-img), CUBE_TEST_BERTH_KEEL (a keel
 * build's out/<arch>, with vmlinuz and base.erofs), CUBE_TEST_BERTH_IMAGE (a
 * public image pinned by digest, which berth vm pulls itself before it
 * listens, masterplan B-7) and CUBE_TEST_BERTH_MKFS (an absolute
 * mkfs.erofs, which berth vm requires), and an accelerator
 * (CUBE_TEST_BERTH_ACCEL, default kvm on Linux and hvf on macOS); without
 * them that part is skipped with a notice, and CUBE_TEST_BERTH_VM=required
 * turns the skip into a failure. CUBE_TEST_BERTH_PULLED names a berth
 * directory the image was pulled into before: its images/ and layers/ are
 * copied, and the runner's start finds the image there and fetches nothing.
 *
 * keel says `ready` only for an image with bash, sudo, flock, git, gh, curl
 * and a CA bundle. With such an image the test runs the whole Workspace
 * contract over cubed's RunnerGuestTransport, then ends the agent and checks
 * the new session; with another it checks that the machine says what its
 * image lacks and refuses operations. It works in /tmp/cvm-* unless
 * CUBE_TEST_BERTH_TMP names another (short) directory. Mocks are not runner
 * acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fromJsonString } from "@bufbuild/protobuf";
import { Endpoint, EndpointAddr, EndpointId, SecretKey } from "@number0/iroh/index.js";
import { EgressPolicy_Default, EgressReportSchema, MachineStatus_Phase, OpenSchema, Runner_Kind, Template_State, type EgressReport, type Machine, type Template } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { EgressPolicy, newPlaceholder, serveEgress } from "../src/egress-policy.ts";
import { GatewaySupervisor } from "../src/gateway.ts";
import { checkMachine, type CredentialRoute } from "../src/runner-credentials.ts";
import { fakeGithub, git as gitAt } from "../../../scripts/fake-github.ts";
import { scanForSecret } from "./leak-scan.ts";
import { GuestTransportError } from "../src/guest-transport.ts";
import { resumeWorkspace } from "../src/vm.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { settleOperation, type Workspace } from "../src/workspace.ts";
import { workspaceContract, workspaceServicesContract } from "./workspace-contract.ts";
import { DIAL_APP, dialPortal, portalContract, Raw, request, withListener, type DialPortal } from "./portal-dial.ts";
import { bannerImage, bannerMachines } from "./berth-banner.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
// CUBE_TEST_BERTH_TMP puts it elsewhere (a host runner's thread directory).
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cvm-")));
const directory = path.join(root, "m");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const node = "node-vm-test";
const env = process.env;
const timeline: string[] = [];
const note = (line: string) => { timeline.push(line); console.log(`runner-vm-test: ${line}`); };

function refused(args: string[]): string {
  const run = spawnSync(binary, ["vm", ...args], { encoding: "utf8", timeout: 60000 });
  assert.notEqual(run.status, 0, `berth vm ${args.join(" ")} started`);
  return run.stderr;
}

// ---------------------------------------------------------------- refusals

const missingKeel = path.join(root, "no-keel");
assert.match(refused(["--dir", directory, "--qemu-img", "/x", "--keel", missingKeel]), /needs --qemu: QEMU and its tools are given by path, never searched for/);
assert.match(refused(["--dir", directory, "--qemu", "qemu-system-x86_64", "--qemu-img", "/x", "--keel", missingKeel]), /--qemu must be an absolute path/);
assert.match(refused(["--dir", directory, "--qemu", path.join(root, "nothing"), "--qemu-img", "/x", "--keel", missingKeel]), /is not a file/);
// mkfs.erofs by path too (B-7: the runner pulls its image itself).
assert.match(refused(["--dir", directory, "--qemu", process.execPath, "--qemu-img", process.execPath, "--keel", missingKeel]), /needs --mkfs-erofs: QEMU and its tools are given by path/);
assert.match(refused(["--dir", directory, "--qemu", process.execPath, "--qemu-img", process.execPath, "--mkfs-erofs", "mkfs.erofs", "--keel", missingKeel]), /--mkfs-erofs must be an absolute path/);
assert.ok(!fs.existsSync(directory), "a refused start writes nothing");
note("refused: no --qemu, a relative --qemu, a missing --qemu, no --mkfs-erofs, a relative --mkfs-erofs");
if (env.CUBE_TEST_BERTH_OLD_QEMU) {
  const old = env.CUBE_TEST_BERTH_OLD_QEMU;
  // The floor is read before anything else is used, so any file stands for qemu-img.
  const said = refused(["--dir", directory, "--qemu", old, "--qemu-img", process.execPath, "--mkfs-erofs", process.execPath, "--keel", missingKeel,
    "--image", `ghcr.io/x/y@sha256:${"0".repeat(64)}`, "--allow-peer", control.peerId, "--node-id", node, "--accel", "tcg"]);
  assert.match(said, /is below keel's QEMU floor; missing: .*virtio-rtc-pci/, said);
  assert.ok(!fs.existsSync(directory), "a QEMU below the floor is refused before the runner writes anything");
  note(`refused below the floor: ${said.trim().split("\n")[0]}`);
}

const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const image = env.CUBE_TEST_BERTH_IMAGE ?? "";
const mkfs = env.CUBE_TEST_BERTH_MKFS ?? "";
const pulled = env.CUBE_TEST_BERTH_PULLED ?? "";
// Another image pinned by digest, for V10's template_image_changed and cache steps.
const imageB = env.CUBE_TEST_BERTH_IMAGE_B ?? "";
const otherImage = /@sha256:[0-9a-f]{64}$/.test(imageB) && imageB !== env.CUBE_TEST_BERTH_IMAGE;
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(image) ? [] : ["CUBE_TEST_BERTH_IMAGE=<registry/repository@sha256:digest>"]),
  ...(path.isAbsolute(mkfs) && fs.existsSync(mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS=<absolute mkfs.erofs path>"]),
];
if (missing.length) {
  console.error(`\nSKIP: berth vm with keel machines did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  fs.rmSync(root, { recursive: true, force: true });
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------- the runner

const vmArgs = (extra: string[] = [], served = image) => ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs, "--accel", accel, "--image", served, ...extra];
async function start(args: string[], served = image): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, vmArgs(args, served),
    // Its own process group, as in a terminal: a Ctrl-C reaches the whole group.
    { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  return { child, peer: field("peer"), address: field("listen").split(", ")[0]!, banner };
}
/** SIGINT goes to the runner's process group, as a terminal's Ctrl-C does. */
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGINT"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (signal === "SIGINT") process.kill(-child.pid!, signal);
  else child.kill(signal);
  await exited;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const record = (id: string) => JSON.parse(fs.readFileSync(path.join(directory, id, "machine.json"), "utf8")) as
  { machineType: string; phase: string; fenceEpoch: number; boot?: { pid: number; bootId: string; qemu: string }; interrupted?: { reason: string };
    image?: { reference: string; manifest: string; diffIds: string[] }; stopped?: { kind: string; message: string } };
const condition = (machine: Machine, type: string) => machine.status?.conditions.find(c => c.type === type);
async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!alive(pid), `QEMU ${pid} still runs`);
}
const events = (id: string) => fs.readFileSync(path.join(directory, id, "events.log"), "utf8");
/** The size an EROFS image's superblock says it has (its blocks << blkszbits). */
function erofsBytes(file: string): bigint {
  const superblock = Buffer.alloc(128);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, superblock, 0, 128, 1024); } finally { fs.closeSync(fd); }
  assert.equal(superblock.readUInt32LE(0), 0xe0f5e1e2, `${file}: no EROFS superblock`);
  return BigInt(superblock.readUInt32LE(36)) << BigInt(superblock[12]!);
}

/** One QMP command on the machine's socket (berth holds no connection between verbs). */
async function qmp(id: string, command: string): Promise<unknown> {
  const socket = net.connect(path.join(directory, id, "qmp.sock"));
  socket.setEncoding("utf8");
  let buffer = "";
  const next = async () => {
    for (;;) {
      const line = buffer.indexOf("\n");
      if (line >= 0) { const message = JSON.parse(buffer.slice(0, line)); buffer = buffer.slice(line + 1); if (!("event" in message)) return message; continue; }
      const [chunk] = await once(socket, "data") as [string];
      buffer += chunk;
    }
  };
  try {
    await next();
    socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
    await next();
    socket.write(`${JSON.stringify({ execute: command })}\n`);
    const answer = await next() as { return?: unknown; error?: unknown };
    assert.ok(answer.return !== undefined, `${command}: ${JSON.stringify(answer)}`);
    return answer.return;
  } finally { socket.destroy(); }
}

/** A command under its own lease, to its end: exit code and output. */
async function shell(workspace: Workspace, key: string, command: string, timeoutMs = 30000): Promise<{ exitCode: number | null; output: string }> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.exec(lease.token, key, { command, timeoutMs });
    const done = await settleOperation(workspace, lease.token, key);
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    return { exitCode: done.state === "succeeded" ? done.exitCode : null, output: done.state === "succeeded" ? Buffer.from(done.output).toString("utf8") : "" };
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

const refusedBy = (code: string, reason: string) => (error: unknown) =>
  error instanceof GuestTransportError && error.cause instanceof RunnerError && error.cause.code === code && error.cause.reason === reason;
const SESSION = /^[0-9a-f]{32}$/;
const dialRefused = (code: string, reason: string) => (error: unknown) => error instanceof RunnerError && error.code === code && error.reason === reason;
const show = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
/** A stop waits up to 30 s for the agent's shutdown, then QEMU may take 20 s. */
const STOP_MS = 70000;
async function stopVia(session: RunnerSession, ref: { owner: string; id: string }, epoch: number): Promise<Machine> {
  const result = await session.call({ case: "machineStop", value: { ref, fence: { epoch: BigInt(epoch) } } }, STOP_MS);
  assert.equal(result.case, "machine");
  return result.value as Machine;
}

/** machine_diagnose (masterplan B-9): the runner's read-only, bounded and
 * redacted evidence about a machine. Asking changes nothing: the record,
 * the recorded argv and the layer disk's descriptor keep their bytes, the
 * fence its epoch, and the layer cache its use times. */
const MAX_DIAGNOSIS_BYTES = 256 * 1024;
function unchanged(id: string): string {
  const dir = path.join(directory, id);
  const files = ["machine.json", "argv.json", "layers.vmdk"].map(name => fs.existsSync(path.join(dir, name)) ? createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex") : "-");
  const layers = fs.readdirSync(path.join(directory, "layers"), { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => `${e.name} ${fs.statSync(path.join(e.parentPath, e.name)).mtimeMs}`).sort();
  return JSON.stringify({ files, layers });
}
async function diagnose(session: RunnerSession, ref: { owner: string; id: string }, epoch: number): Promise<{ text: string; doc: any }> {
  const before = unchanged(ref.id);
  const result = await session.call({ case: "machineDiagnose", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.equal(result.case, "diagnosis");
  const text = (result.value as { json: string }).json;
  assert.ok(Buffer.byteLength(text) <= MAX_DIAGNOSIS_BYTES, `a diagnosis of ${Buffer.byteLength(text)} bytes`);
  const doc = JSON.parse(text);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.machine.ref, ref);
  assert.equal(unchanged(ref.id), before, "a diagnosis changes nothing");
  assert.doesNotMatch(text, /cube_ph_[a-z0-9]+_[A-Za-z0-9]{22}/, "no placeholder in a diagnosis");
  return { text, doc };
}
/** The command line of process `pid` as the system has it. */
function processArgs(pid: number): string[] | string {
  if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
  return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

/** cubed's end of the runner's report stream (masterplan B-4), as the test
 * plays it: its own connection with the control key; the runner opens one
 * stream on it with `Open.report` and writes `EgressReport` frames. */
async function reportReader(address: string, peer: string) {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  const bytes = fs.readFileSync(controlKey);
  builder.secretKey(SecretKey.fromBytes(Array.from(bytes)).toBytes());
  builder.alpns([]);
  builder.bindAddr("127.0.0.1:0");
  const endpoint = await builder.bind();
  const connection = await endpoint.connect(new EndpointAddr(EndpointId.fromBytes(Array.from(Buffer.from(peer, "hex"))), null, [address]),
    Array.from(Buffer.from("cubeyard/runner/4")));
  const received: EgressReport[] = [];
  let wake = () => {};
  let ended = false;
  void (async () => {
    try {
      const stream = await connection.acceptBi();
      const frame = async () => {
        const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
        return Buffer.from(await stream.recv.readExact(length)).toString("utf8");
      };
      const opened = fromJsonString(OpenSchema, await frame());
      assert.equal(opened.kind.case, "report", "the runner's stream is a report stream");
      for (;;) { received.push(fromJsonString(EgressReportSchema, await frame())); wake(); }
    } catch { ended = true; wake(); }
  })();
  return {
    /** The next `n` reports, in order. */
    async take(n: number, ms: number): Promise<EgressReport[]> {
      const deadline = Date.now() + ms;
      while (received.length < n) {
        if (ended) throw new Error(`the report stream ended after ${received.length} of ${n}`);
        if (Date.now() > deadline) throw new Error(`${received.length} of ${n} reports in ${ms} ms: ${show(received)}`);
        await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 200); });
      }
      return received.splice(0, n);
    },
    discard() { received.splice(0); },
    async close() { connection.close(0n, []); await endpoint.close(); },
  };
}

// The image: berth vm pulls it itself before it listens (B-7), unless it is
// in the directory already.
const firstArgs = ["--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0", "--labels", "site=test"];
if (pulled) {
  for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
  note(`image copied from ${pulled}`);
}

// The machine's GitHub placeholder (B-5's V6-V8 use it as the guest's GH_TOKEN).
const PH = newPlaceholder("github");
const documents = {
  hostname: Buffer.from("cube-vm-test\n"),
  env: Buffer.from(`GH_TOKEN=${PH}\n`),
  "hooks/pre-resume": Buffer.from("#!/bin/bash\necho \"pre-resume as $(id -un) in $(pwd) token=$GH_TOKEN\"\n"),
};

// The first start binds the directory to this control peer and node.
let runner = await start(firstArgs);
{
  const lines = runner.banner.split("\n");
  const pulledAt = lines.findIndex(line => /^image: .*; pulling /.test(line));
  const cachedAt = lines.findIndex(line => /^image: .+ is in /.test(line));
  const listenAt = lines.findIndex(line => /^listen: /.test(line));
  assert.ok(pulled ? cachedAt >= 0 && pulledAt < 0 : pulledAt >= 0, runner.banner);
  assert.ok(listenAt > Math.max(pulledAt, cachedAt), `the endpoint listens only after the image is here: ${runner.banner}`);
  note(pulled ? "the image was in the directory: nothing fetched before listening"
    : `pulled before listening: ${lines.filter(line => /^layer \d+ |: index, /.test(line)).join(" | ")}`);
}
const sessions: RunnerSession[] = [];
/** V9's portal and the app's port, kept until the machine stops. */
let v9: { target: DialPortal; port: number } | undefined;
let passed = false;
try {
  assert.match(runner.banner, /^qemu: \d+\.\d+\.\d+ .+ \(meets keel's floor; new machines get (pc-q35|virt)-\d+\.\d+\)$/m);
  // The image line, exactly as berth writes it: on cube's default image
  // (the pinned official Debian) with its Debian preparation layer, pinned
  // per platform; on any other image without one.
  {
    const shown = bannerImage(runner.banner);
    assert.ok(image.endsWith(`@${shown.reference.split("@")[1]}`), `the banner names ${shown.reference}, not ${image}`);
    const plan = JSON.parse(fs.readFileSync(path.join(repo, "packages/berth/debian/trixie.json"), "utf8")) as
      { image: string; platforms: Record<string, { manifest: string; diffId: string }> };
    const onDefault = image.split("@")[1] === plan.image.split("@")[1];
    assert.equal(shown.prepared, onDefault ? plan.platforms[shown.platform]!.diffId : null,
      onDefault ? "cube's default image is served with its pinned preparation layer" : "another image gets no preparation layer");
    if (onDefault) assert.equal(shown.manifest, plan.platforms[shown.platform]!.manifest, "the default image's pinned manifest");
  }
  assert.match(runner.banner, /^runner CA: certificate sha256 [0-9a-f]{64}$/m);
  assert.doesNotMatch(runner.banner, /UNSANDBOXED/);
  note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|runner CA):/.test(line)).join(" | "));
  // The runner's CA: its key is the runner account's alone and never leaves.
  const caDir = path.join(directory, ".berth", "ca");
  assert.equal(fs.statSync(caDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(caDir, "ca.key")).mode & 0o777, 0o600);
  const caPem = fs.readFileSync(path.join(caDir, "ca.pem"), "utf8");
  const configPath = path.join(root, "runner.json");
  const writeConfig = (address: string, peer: string) => fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4,
    binding: { nodeId: node, threadId: node, environmentId: 1 }, controlKey, serverPeer: peer, network: "loopback", address }), { mode: 0o600 });
  writeConfig(runner.address, runner.peer);
  const open = () => { const session = new RunnerSession(loadSessionConfig(configPath).config); sessions.push(session); return session; };
  let session = open();

  // hello: a VM runner, its QEMU by version and path, guest streams, its CA
  const hello = await session.hello();
  assert.equal(hello.protocol, 4);
  assert.equal(hello.runner?.kind, Runner_Kind.VM);
  assert.equal(hello.runner?.nodeId, node);
  assert.equal(hello.runner?.platform?.accelerator, accel);
  assert.equal(hello.runner?.platform?.qemuVersion.split(" ")[1], qemu, "Platform.qemu_version is version and path (A17)");
  assert.match(hello.runner?.platform?.baseImageSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(hello.runner?.labels, { site: "test" });
  assert.ok(hello.capabilities.includes("machine.discard") && hello.capabilities.includes("watch") && hello.capabilities.includes("guest")
    && hello.capabilities.includes("dial") && ["template.publish", "template.list", "template.delete"].every(c => hello.capabilities.includes(c)));
  assert.deepEqual(hello.runner?.templates, []);
  assert.equal(hello.runner?.caPem, caPem, "Runner.ca_pem is the runner's CA certificate");
  assert.doesNotMatch(hello.runner?.caPem ?? "", /PRIVATE KEY/);
  // U15 (a): the RTT of Iroh's path in use to cubed, measured by the runner.
  const helloRtt = hello.runner?.network?.rttToCubed;
  assert.ok(helloRtt && (helloRtt.seconds > 0n || helloRtt.nanos > 0), `rtt_to_cubed in hello: ${show(hello.runner?.network)}`);
  assert.equal(hello.runner?.network?.mode, "loopback");
  assert.ok(hello.capabilities.includes("machine.diagnose"));

  // a wrong node id is refused at hello
  const wrongPath = path.join(root, "wrong.json");
  fs.writeFileSync(wrongPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: "node-other", threadId: "x", environmentId: 1 },
    controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });
  const wrong = new RunnerSession(loadSessionConfig(wrongPath).config);
  sessions.push(wrong);
  await assert.rejects(wrong.hello(), (error: unknown) => error instanceof RunnerError && error.code === "PERMISSION_DENIED" && error.reason === "wrong_node");

  // create: stopped, a writable disk and the image's layer disk, the machine type pinned
  const ref = { owner: "thread-1", id: randomBytes(8).toString("hex") };
  let epoch = Date.now();
  const size = { vcpus: 2, memoryMib: 1024, diskGib: 4 };
  const created = await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) }, spec: { source: { case: "base", value: true }, size } } });
  assert.equal(created.status?.phase, MachineStatus_Phase.STOPPED);
  const machineDir = path.join(directory, ref.id);
  const disk = fs.statSync(path.join(machineDir, "rw.qcow2"));
  assert.ok(fs.statSync(path.join(machineDir, "layers.vmdk")).isFile());
  const machineImage = record(ref.id).image!;
  assert.equal(machineImage.reference, image);
  assert.ok(machineImage.diffIds.length >= 1 && machineImage.diffIds.every(d => /^sha256:[0-9a-f]{64}$/.test(d)), JSON.stringify(machineImage));
  const extents = fs.readFileSync(path.join(machineDir, "layers.vmdk"), "utf8").split("\n").filter(line => /\.erofs"/.test(line)).length;
  assert.equal(extents, machineImage.diffIds.length, "one FLAT extent per image layer on the layer disk");
  const pinned = record(ref.id).machineType;
  assert.equal(pinned, runner.banner.match(/new machines get (\S+)\)/)![1]);
  assert.equal((await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) } } })).ref?.id, ref.id, "create again changes nothing");
  assert.equal(fs.statSync(path.join(machineDir, "rw.qcow2")).ino, disk.ino);
  await assert.rejects(session.call({ case: "machineCreate", value: { ref: { owner: "thread-2", id: ref.id }, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "ALREADY_EXISTS");
  note(`created ${ref.id}: stopped, machine type ${pinned}, ${machineImage.diffIds.length} image layer(s) on its layer disk`);

  // boot documents keel does not know are refused before anything boots
  await assert.rejects(session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents: { "cloud-init": Buffer.from("x") }, mac: "" } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "INVALID_ARGUMENT" && error.reason === "unknown_document");

  // start: QEMU runs keel; the agent says hello with a session; the runner sends machine_setup
  const t0 = Date.now();
  const started = await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents, mac: "" } } });
  assert.equal(started.status?.phase, MachineStatus_Phase.RUNNING);
  const firstBoot = started.status!.bootId;
  assert.match(firstBoot, /^[0-9a-f]{32}$/);
  const argv = JSON.parse(fs.readFileSync(path.join(machineDir, "argv.json"), "utf8")) as { qemu: string; args: string[] };
  assert.equal(argv.qemu, qemu);
  assert.ok(argv.args.includes(`${pinned},accel=${accel}`));
  assert.ok(argv.args.includes("virtserialport,chardev=ctl,name=cube.0,id=cube0"));
  const blocks = await qmp(ref.id, "query-block") as Array<{ inserted?: { ro: boolean; file: string } }>;
  const ro = Object.fromEntries(blocks.filter(b => b.inserted).map(b => [path.basename(b.inserted!.file), b.inserted!.ro]));
  assert.deepEqual(ro, { "base.erofs": true, "layers.vmdk": true, "rw.qcow2": false }, "vda and vdb read-only, vdc writable");
  // The setup is applied once its status comes: ready, or what the image lacks.
  const settled = await session.until(ref, machine => {
    const guest = machine.status?.guest;
    return !!guest && guest.connected && SESSION.test(guest.session) && (guest.ready || /lacks/.test(guest.reason));
  }, 180000);
  const guest = settled.status!.guest!;
  const firstSession = guest.session;
  assert.match(guest.bootId, /^[0-9a-f-]{36}$/);
  assert.match(events(ref.id), new RegExp(`hello: session ${firstSession}; machine_setup on channel \\d+`));
  assert.match(events(ref.id), /machine_setup: done/);
  // The agent opened its port and QMP said so (VSERPORT_CHANGE reached the
  // runner); no deadline ran out, no reset.
  assert.match(events(ref.id), /port: the agent opened cube\.0 \(QMP VSERPORT_CHANGE\)/, events(ref.id));
  assert.doesNotMatch(events(ref.id), /QMP did not say|the reset on channel 0|unhealthy/, events(ref.id));
  note(`started: boot ${firstBoot}; agent hello, session ${firstSession}, setup done ${Date.now() - t0} ms after the start; ready=${guest.ready}${guest.ready ? "" : ` ("${guest.reason}")`}`);

  // A guest stream: hello is answered by the agent itself (also when not ready)
  let transport = session.guest(ref, () => epoch);
  const agentHello = await transport.call("hello", {});
  assert.equal(agentHello.header.bootId, guest.bootId, "the guest stream reaches this machine's agent");
  assert.equal(agentHello.header.ready, guest.ready);
  await assert.rejects(session.guest(ref, () => epoch - 1).call("hello", {}), refusedBy("FAILED_PRECONDITION", "stale_epoch"));
  await assert.rejects(session.guest(ref, () => epoch).call("Bad" as never, {}), refusedBy("INVALID_ARGUMENT", "op"));
  // machine_diagnose (B-9): read-only evidence about the running machine.
  {
    const { doc } = await diagnose(session, ref, epoch);
    assert.equal(doc.machine.phase, "running");
    assert.equal(doc.machine.bootId, firstBoot);
    assert.equal(doc.machine.fenceEpoch, epoch);
    assert.deepEqual(doc.machine.image, machineImage);
    assert.equal(doc.machine.layers.length, machineImage.diffIds.length);
    assert.ok(doc.machine.layers.every((l: any) => l.present?.bytes > 0), show(doc.machine.layers));
    // QEMU by path and version (A17), and the argv the process runs with.
    assert.equal(doc.qemu.path, qemu);
    assert.equal(doc.qemu.version, hello.runner?.platform?.qemuVersion.split(" ")[0]);
    assert.equal(doc.qemu.machineType, pinned);
    assert.equal(doc.qemu.accelerator, accel);
    assert.equal(doc.qemu.pid, record(ref.id).boot!.pid);
    assert.equal(doc.qemu.running, true);
    assert.equal(doc.qemu.argv.current, true);
    assert.deepEqual(doc.qemu.argv.args, argv.args);
    const command = processArgs(doc.qemu.pid);
    if (Array.isArray(command)) assert.deepEqual(command, [qemu, ...argv.args], "the recorded argv is QEMU's own");
    else assert.equal(command, [qemu, ...argv.args].join(" "), "the recorded argv is QEMU's own");
    assert.equal(doc.qmp.status?.status, "running", show(doc.qmp));
    assert.equal(doc.console.present, true);
    assert.equal(doc.console.current, true);
    assert.equal(doc.console.bootId, firstBoot);
    assert.ok(doc.console.text.length > 0);
    assert.ok(doc.events.lines.some((line: string) => /machine_setup: done/.test(line)), show(doc.events));
    assert.equal(doc.guest.info?.session, firstSession);
    assert.equal(doc.guest.info?.ready, guest.ready);
    assert.equal(doc.egress.policy.current, true);
    assert.equal(doc.egress.policy.summary.default, "deny", "a start without a policy: no egress");
    assert.ok(doc.egress.lease.cubedConnections > 0);
    // U15 (a): every connection's paths; over loopback the one in use is direct.
    const used = doc.iroh.connections.flatMap((c: any) => c.paths).filter((p: any) => p.selected);
    assert.ok(used.length >= 1 && used.every((p: any) => p.kind === "direct" && p.address.startsWith("127.0.0.1:") && p.rttMs > 0), show(doc.iroh));
    assert.ok(doc.iroh.rttToCubedMs > 0, show(doc.iroh));
    assert.equal(doc.iroh.configuredMode, "loopback");
    assert.deepEqual(doc.bounds.dropped, []);
    // Fenced as a mutation is, but never raising the epoch; another owner's is not found.
    await assert.rejects(session.call({ case: "machineDiagnose", value: { ref, fence: { epoch: BigInt(epoch - 1) } } }),
      (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "stale_epoch");
    await assert.rejects(session.call({ case: "machineDiagnose", value: { ref: { owner: "thread-2", id: ref.id }, fence: { epoch: BigInt(epoch) } } }),
      (error: unknown) => error instanceof RunnerError && error.code === "NOT_FOUND");
    assert.equal((await diagnose(session, ref, epoch + 1000)).doc.machine.fenceEpoch, epoch, "a newer fence is not taken");
    assert.equal(record(ref.id).fenceEpoch, epoch);
    const logged = { ...doc, qemu: { ...doc.qemu, log: { ...doc.qemu.log, text: `<${doc.qemu.log.text?.length} characters>` } },
      console: { ...doc.console, text: `<${doc.console.text.length} characters>` }, events: { ...doc.events, lines: `<${doc.events.lines.length} lines>` } };
    note(`B-9 document: ${JSON.stringify(logged)}`);
    note(`B-9 running: diagnosis ${Buffer.byteLength(JSON.stringify(doc))} bytes; QEMU ${doc.qemu.version} ${doc.qemu.path} pid ${doc.qemu.pid}, argv as the system has it; query-status ${doc.qmp.status.status} in ${doc.qmp.ms} ms; console ${doc.console.bytes} bytes; ${doc.events.lines.length} events; path in use ${used.map((p: any) => `${p.kind} ${p.address} ${p.rttMs.toFixed(3)} ms`).join(", ")}; rtt_to_cubed in hello ${helloRtt.seconds}s ${helloRtt.nanos}ns`);
  }
  // Templates answer (B-8): none yet; an ordinary machine never publishes.
  const noTemplates = await session.call({ case: "templateList", value: {} });
  assert.ok(noTemplates.case === "templates" && noTemplates.value.items.length === 0, show(noTemplates));
  await assert.rejects(session.call({ case: "templatePublish", value: { from: ref, fence: { epoch: BigInt(epoch) }, key: "k", meta: "" } }),
    (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "not_build");
  await assert.rejects(session.call({ case: "machineCreate", value: { ref: { owner: "thread-1", id: randomBytes(8).toString("hex") }, fence: { epoch: BigInt(epoch) },
    spec: { source: { case: "templateId", value: "0000000000000000" } } } }),
  (error: unknown) => error instanceof RunnerError && error.code === "NOT_FOUND" && error.reason === "template");

  if (guest.ready) {
    // The Workspace contract over cubed's own RunnerGuestTransport (B-2's done criterion).
    const leases = fs.mkdtempSync(path.join(os.tmpdir(), "runner-vm-contract-"));
    const store = new LeaseStore(leases);
    try {
      const workspace = new VmWorkspace({ guest: transport, leases: store, owner: "pi", binding: `runner-vm-test:${process.pid}`, retryMs: 2000 });
      await workspaceContract("VmWorkspace -> RunnerGuestTransport -> berth vm -> cube-agent", workspace, "pi");
      await workspaceServicesContract("VmWorkspace -> RunnerGuestTransport -> berth vm -> cube-agent", workspace, workspace, "pi");
      const resumed = await resumeWorkspace(workspace, "pi");
      assert.equal(resumed.hooks["pre-resume"]?.status, "ok", JSON.stringify(resumed));
      const facts = await shell(workspace, "facts", "hostname; echo \"$GH_TOKEN\"; grep -c 'cube: begin' /etc/ssl/certs/ca-certificates.crt || true");
      assert.equal(facts.exitCode, 0, JSON.stringify(facts));
      assert.match(facts.output, new RegExp(`^cube-vm-test\n${PH}\n1\n`), "the boot documents and the runner's CA reached the machine");
      note("Workspace contract (leases, files, commands, services, hooks) over RunnerGuestTransport: ok; hostname, placeholder and runner CA from machine_setup");

      // B-9: what reaches the machine's serial console reaches the diagnosis
      // redacted and bounded: 300 kB of filler, then its placeholder, a
      // token-like value, a password and a key block. A thread's commands
      // run in a root whose /dev has no console, so the plant makes the
      // kernel console's node (5,1) there first, for this machine only.
      const fakeToken = `ghp_${"b9".repeat(12)}`;
      const plant = "test -c /dev/console || mknod -m 0600 /dev/console c 5 1\n"
        + `{ head -c 300000 /dev/zero | tr '\\0' x; printf '\\nb9-plant %s %s password=hunter2b9\\n' '${PH}' '${fakeToken}'; `
        + "printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAABbm9uZQ\\n-----END OPENSSH PRIVATE KEY-----\\nb9-end\\n'; } > /dev/console\n"
        + "ls -l /dev/console\ncat /proc/consoles\n";
      const plantStart = Date.now();
      const plantRun = await shell(workspace, "b9-plant", `echo ${Buffer.from(plant).toString("base64")} | base64 -d | sudo sh -e`, 120000);
      const plantMs = Date.now() - plantStart;
      assert.equal(plantRun.exitCode, 0, `the plant: ${plantRun.output}`);
      const planted = (await diagnose(session, ref, epoch)).doc;
      const consoleText: string = planted.console.text;
      assert.ok(planted.console.omittedBytes > 300000 - 32 * 1024 && consoleText.length <= 4 * 32 * 1024 + 64, `the console's tail is bounded: ${planted.console.bytes} bytes, ${planted.console.omittedBytes} left out, ${consoleText.length} shown`);
      assert.match(consoleText, /b9-plant cube_ph_github_\[redacted\] ghp_\[redacted\] password=\[redacted\]\n\[redacted private key\]\nb9-end\n/, "the planted secrets are redacted");
      for (const secret of [PH, fakeToken, "hunter2b9", "b3BlbnNzaC1rZXktdjE"]) assert.ok(!consoleText.includes(secret), `${secret} in the diagnosis`);
      note(`B-9 console: ${planted.console.bytes} bytes, ${planted.console.omittedBytes} left out; placeholder, token, password and key block redacted; plant ${plantMs} ms: ${plantRun.output.trim().split("\n").join("; ")}`);

      // The agent starts again: a new session, the setup again, ready again.
      // The main agent is the cube-agent in the root cgroup (its wrappers have
      // cgroups of their own); /proc and bash's kill only: keel needs no procps.
      const endAgent = "for p in /proc/[0-9]*; do [ \"$(cat $p/comm 2>/dev/null)\" = cube-agent ] && [ \"$(cat $p/cgroup 2>/dev/null)\" = 0::/ ] && sudo bash -c \"kill ${p#/proc/}\"; done; sleep 1";
      const killed = await shell(workspace, "end-agent", endAgent).catch((error: unknown) => error);
      const renewed = await session.until(ref, machine => {
        const g = machine.status?.guest;
        return !!g && g.ready && SESSION.test(g.session) && g.session !== firstSession;
      }, 60000).catch(async (error: unknown) => {
        const now = await session.machine({ case: "machineGet", value: { ref } });
        const tail = fs.readFileSync(path.join(machineDir, "console.log"), "utf8").split("\n").slice(-15).join("\n");
        throw new Error(`${String(error)}; the exec that should end the agent: ${JSON.stringify(killed)}; guest ${JSON.stringify(now.status?.guest, (_, v) => typeof v === "bigint" ? String(v) : v)}\nevents.log:\n${events(ref.id)}\nconsole:\n${tail}`);
      });
      assert.equal(renewed.status?.bootId, firstBoot, "the same boot");
      note(`the agent started again: new session ${renewed.status!.guest!.session} after ${firstSession}, ready again (the exec that ended it: ${killed instanceof Error ? killed.message : "answered"})`);
      assert.match(events(ref.id), /the agent closed cube\.0; the session ended/);

      // A controlled stop (D1): written and not synced, then stopped at once;
      // the agent's shutdown puts it on the disk before QEMU goes.
      const token = randomBytes(8).toString("hex");
      const wrote = await shell(workspace, "persist-write", `printf ${token} > persist.txt`);
      assert.equal(wrote.exitCode, 0);
      // A workload that ignores SIGTERM runs meanwhile: the agent waits its
      // 10 s, then SIGKILLs it, and the stop is still controlled, well
      // within the runner's 30 s (R17).
      const stubbornLease = await workspace.lease({ owner: "pi" });
      await workspace.exec(stubbornLease.token, "stubborn", { command: "trap '' TERM; while :; do sleep 1; done", timeoutMs: 600000 });
      await workspace.release(stubbornLease.token);
      const t0Stop = Date.now();
      const controlled = await stopVia(session, ref, epoch);
      const stopMs = Date.now() - t0Stop;
      assert.ok(stopMs >= 10000 && stopMs < 30000, `a controlled stop with a workload that ignores SIGTERM took ${stopMs} ms`);
      assert.equal(controlled.status?.phase, MachineStatus_Phase.STOPPED);
      assert.deepEqual([condition(controlled, "Stopped")?.reason, condition(controlled, "Stopped")?.status], ["controlled", true], show(controlled.status?.conditions));
      assert.equal(record(ref.id).stopped?.kind, "controlled");
      assert.match(events(ref.id), /stop: controlled: the agent shut down/);
      await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents, mac: "" } } });
      await session.until(ref, machine => !!machine.status?.guest?.ready, 180000);
      const kept = await shell(workspace, "persist-read", "cat persist.txt");
      assert.equal(kept.output, token, "what was written before a controlled stop is on the disk after it");
      note(`controlled stop in ${stopMs} ms with a workload that ignores SIGTERM (killed after 10 s): an unsynced write before it read back after the restart (${token}); Stopped/controlled journaled`);

      // A forced stop: the guest cannot answer (QMP stop pauses it), so after
      // 30 s QEMU is quit anyway and the stop is journaled as forced.
      await qmp(ref.id, "stop");
      // A machine with a fault (B-9): its guest is paused, and the diagnosis says so.
      const paused = (await diagnose(session, ref, epoch)).doc;
      assert.equal(paused.machine.phase, "running");
      assert.equal(paused.qmp.status?.status, "paused", show(paused.qmp));
      note(`B-9 paused: query-status ${paused.qmp.status.status} (running: ${paused.qmp.status.running})`);
      const t1 = Date.now();
      const forced = await stopVia(session, ref, epoch);
      const waited = Date.now() - t1;
      assert.equal(forced.status?.phase, MachineStatus_Phase.STOPPED);
      assert.deepEqual([condition(forced, "Stopped")?.reason, condition(forced, "Stopped")?.status], ["forced", false]);
      assert.match(condition(forced, "Stopped")!.message, /no answer to shutdown within 30 s/);
      assert.ok(waited >= 30000 && waited < STOP_MS, `waited ${waited} ms`);
      assert.match(events(ref.id), /stop: forced: no answer to shutdown within 30 s/);
      // A restart after a forced stop: the machine boots, its disk is
      // checked, and what the controlled stop kept is still there.
      await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents, mac: "" } } });
      const back = await session.until(ref, machine => !!machine.status?.guest?.ready, 180000);
      assert.equal(condition(back, "Stopped"), undefined, "a start clears the stop record");
      const still = await shell(workspace, "persist-read-again", "cat persist.txt");
      assert.equal(still.output, token);
      note(`forced stop after ${waited} ms (guest paused: no answer to shutdown within 30 s), journaled forced; restarted ready with the data`);

      // ------------------------------------------------ V5 (masterplan B-4)
      // The runner's own egress: the test plays cubed, reading the runner's
      // report stream on a connection of its own, opened before any other
      // (the runner writes reports on one connection at a time).
      for (const s of sessions.splice(0)) await s.close();
      let reader = await reportReader(runner.address, runner.peer);
      session = open();
      assert.equal((await session.hello()).runner?.network?.egress, true, "Runner.network.egress");
      const open443 = { case: "https" as const, value: {} };
      const policyA = {
        default: EgressPolicy_Default.ALLOW_PUBLIC_HTTP, denyHosts: ["example.net"],
        rules: [{ hosts: ["api.github.com"], ports: [], kind: { case: "https" as const, value: { credential: { name: "github" } } } }],
        lease: { seconds: 3n, nanos: 0 },
      };
      const startWith = async (policy: object) =>
        await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents, mac: "" }, policy: policy as never } });
      const egressWorkspace = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-egress:${process.pid}`, retryMs: 2000 });
      const run = async (key: string, command: string) => (await shell(egressWorkspace, key, command)).output.trim();
      const code = (key: string, args: string) => run(key, `curl -s -o /dev/null -m 20 -w '%{http_code}' ${args}; true`);
      const deniedBy = (key: string, args: string) => run(key, `curl -s -o /dev/null -m 20 -D - ${args} | tr -d '\\r' | sed -n 's/^x-cube-denied: //Ip'; true`);
      // Started without a policy: no egress (as DENY with no rules), over TLS the guest trusts.
      assert.equal(await deniedBy("v5-none", "https://example.com/"), "host is not allowed by the egress policy");
      // The machine runs: a new start replaces its policy.
      assert.equal((await startWith(policyA)).status?.phase, MachineStatus_Phase.RUNNING);
      // The guest dials any address; the runner names the upstream by Host or SNI.
      const via = "--connect-to ::203.0.113.1:";

      // 1. public HTTPS through the interception, trusted through the runner's CA
      assert.equal(await code("v5-https", "https://example.com/"), "200");
      assert.equal(await code("v5-http", "http://example.com/"), "200");
      const issuer = await run("v5-issuer", "curl -sv -o /dev/null https://example.com/ 2>&1 | sed -n 's/^\\* *issuer: //p'");
      assert.match(issuer, /cube runner CA [0-9a-f]{12}/, `the leaf is the runner CA's: ${issuer}`);
      const git = await run("v5-git", "git ls-remote https://github.com/git/git HEAD >/dev/null 2>&1; echo $?");
      assert.equal(git, "0", "git trusts the runner CA");
      const nodeFetch = await run("v5-node", "command -v node >/dev/null && node -e \"fetch('https://example.com/').then(r => console.log(r.status), e => console.log('error', e.cause?.code ?? e.message))\" || echo absent");
      assert.ok(nodeFetch === "200" || nodeFetch === "absent", `node: ${nodeFetch}`);
      note(`V5 1: https://example.com 200 and http:// 200 through the runner; issuer "${issuer}"; git ls-remote ok; node: ${nodeFetch}`);

      // 2. private, link-local/metadata, the runner host's own and cubed's addresses
      const own = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4").map(a => a!.address);
      const cubedAddress = "127.0.0.1"; // cubed reaches the runner over loopback here
      const forbidden = [...new Set(["10.1.2.3", "192.168.1.1", "169.254.169.254", "192.168.127.1", cubedAddress, ...own])];
      for (const [i, host] of forbidden.entries()) {
        assert.equal(await deniedBy(`v5-addr-${i}`, `${via} http://${host}/`), "upstream address is not public", host);
      }
      note(`V5 2: refused as not public: ${forbidden.join(", ")}`);

      // 3. CONNECT and Upgrade refused; other ports reset at once
      const connect = await run("v5-connect", "exec 3<>/dev/tcp/203.0.113.1/80; printf 'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n' >&3; head -n1 <&3 | tr -d '\\r'");
      assert.match(connect, /^HTTP\/1\.1 403/, connect);
      assert.equal(await deniedBy("v5-upgrade", "-H 'Connection: Upgrade' -H 'Upgrade: websocket' https://example.com/"), "protocol upgrades are not supported");
      for (const port of [22, 8080]) {
        const reset = await run(`v5-port-${port}`, `s=$(date +%s%N); (exec 3<>/dev/tcp/203.0.113.1/${port}) 2>&1; echo "rc=$? ms=$(( ($(date +%s%N) - s) / 1000000 ))"`);
        assert.match(reset, /Connection refused[\s\S]*rc=1 ms=\d+$/, reset);
        assert.ok(Number(reset.match(/ms=(\d+)/)![1]) < 2000, reset);
      }
      note("V5 3: CONNECT 403, Upgrade 403, ports 22 and 8080 reset at once");

      // 4. deny_hosts, a credential rule (B-5 not yet), a placeholder elsewhere, DENY by default
      assert.equal(await deniedBy("v5-deny-host", "https://example.net/"), "host is denied by the egress policy");
      // A placeholder of the real form (the boot document's GH_TOKEN above is
      // shorter, so it is no placeholder and would go out as any header).
      const placeholder = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
      // A credential rule's request goes to cubed (B-5); this session has no credential proxy.
      const unavailable = await run("v5-credential", `curl -s -o /dev/null -m 20 -D - -H "Authorization: Bearer ${placeholder}" https://api.github.com/ | tr -d '\\r' | sed -n 's/^HTTP\\/1.1 //p;s/^x-cube-error: //Ip'; true`);
      assert.equal(unavailable, "503 Service Unavailable\ncubed refused the credential request: this cubed carries no credential requests");
      assert.equal(await deniedBy("v5-placeholder", `-H "Authorization: Bearer ${placeholder}" https://example.com/`), "a secret placeholder is only sent where a credential rule allows it");
      await startWith({ default: EgressPolicy_Default.DENY, denyHosts: [], rules: [{ hosts: ["example.com"], ports: [443], kind: open443 }], lease: { seconds: 3n, nanos: 0 } });
      assert.equal(await code("v5-deny-allowed", "https://example.com/"), "200");
      assert.equal(await deniedBy("v5-deny-other", "https://example.org/"), "host is not allowed by the egress policy");
      assert.equal(await deniedBy("v5-deny-http", "http://example.com/"), "host is not allowed by the egress policy");
      note("V5 4: deny_hosts, credential_unavailable (cubed without a credential proxy: 503), placeholder and DENY by default refused; a new start replaced the policy of the running machine");

      // 6. the reports so far, as cubed reads them
      const expected: Array<[string, string]> = [
        ["example.com", "policy"],
        ...forbidden.map(h => [h, "address"] as [string, string]),
        ["example.com:443", "connect"], ["example.com", "upgrade"], ["example.net", "deny_host"],
        ["api.github.com", "credential_unavailable"], ["example.com", "placeholder"], ["example.org", "policy"], ["example.com", "policy"],
      ];
      const got = await reader.take(expected.length, 20000);
      assert.deepEqual(got.map(r => [r.host, r.reason]), expected, show(got));
      assert.ok(got.every(r => r.ref?.id === ref.id && r.ref?.owner === ref.owner && r.droppedBefore === 0n));
      note(`V5 6: ${got.length} reports on the runner's report stream, reasons and hosts as refused`);

      // 5. the lease: 3 s after cubed's last connection goes, new flows and
      // requests are refused and upstreams closed; an open connection is the
      // guest's to end (drained, never reset); the next connection ends the
      // grace. The guest runs on its own meanwhile: probes every 250 ms, one
      // keep-alive connection that asks before the loss, once the lease is
      // over and again after cubed is back (curl spaces them 7.5 s apart and
      // reuses the connection), a download under way (a pinned tag tarball
      // from GitHub, which the gate reaches anyway), and (once the lease is
      // over) 300 connections, more refusals than the runner's queue of 256
      // holds.
      await startWith(policyA);
      const leaseHolder = await egressWorkspace.lease({ owner: "pi" });
      const script = [
        "rm -f /tmp/lease.log /tmp/held.log /tmp/dl.log",
        "( curl -s -o /dev/null -o /dev/null -o /dev/null --rate 8/m -w '%{http_code} %{num_connects}\\n' 'http://example.com/?before' 'http://example.com/?expired' 'http://example.com/?back' | tr '\\n' '|' > /tmp/held.log ) &",
        "( curl -s -o /dev/null --limit-rate 200k -m 60 -w '%{http_code}|%{size_download}|%{exitcode}|%{errormsg}\\n' 'https://codeload.github.com/git/git/tar.gz/refs/tags/v2.47.0' > /tmp/dl.log; date +%s%3N >> /tmp/dl.log ) &",
        "( sleep 7; for i in $(seq 1 300); do (exec 3<>/dev/tcp/203.0.113.1/80) 2>/dev/null; done; date +%s%3N > /tmp/flood.log ) &",
        "for i in $(seq 1 64); do echo \"$(date +%s%3N) $(curl -s -o /dev/null -m 1 -w '%{http_code}' http://example.com/)\" >> /tmp/lease.log; sleep 0.25; done",
        "wait",
      ].join("\n");
      await egressWorkspace.exec(leaseHolder.token, "v5-lease", { command: script, timeoutMs: 120000 });
      await egressWorkspace.release(leaseHolder.token);
      await new Promise(resolve => setTimeout(resolve, 2000));
      // cubed goes: every connection from it closes.
      await reader.close();
      for (const s of sessions.splice(0)) await s.close();
      const lost = Date.now();
      await new Promise(resolve => setTimeout(resolve, 9000));
      reader = await reportReader(runner.address, runner.peer);
      session = open();
      const returned = Date.now();
      await session.hello();
      const backWorkspace = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-egress:${process.pid}`, retryMs: 2000 });
      const backLease = await backWorkspace.lease({ owner: "pi" });
      const settled = await settleOperation(backWorkspace, backLease.token, "v5-lease");
      await backWorkspace.release(backLease.token);
      assert.equal(settled.state, "succeeded", JSON.stringify(settled));
      const log = (await shell(backWorkspace, "v5-lease-log", "cat /tmp/lease.log; echo \"held $(cat /tmp/held.log)\"; echo \"dl $(cat /tmp/dl.log | tr '\\n' '|')\"; echo flood $(cat /tmp/flood.log)")).output.trim().split("\n");
      const flood = Number(log.pop()!.split(" ")[1]);
      const [dlStatus, dlBytes, dlExit, dlError, dlEnd] = log.pop()!.slice(3).split("|");
      const held = log.pop()!.slice(5);
      const probes = log.map(line => line.split(" ")).map(([at, status]) => ({ at: Number(at), status }));
      const leaseMs = 3000;
      const within = probes.filter(p => p.at < lost + leaseMs - 500);
      const expired = probes.filter(p => p.at > lost + leaseMs + 1500 && p.at < returned - 500);
      const again = probes.filter(p => p.at > returned + 2500);
      assert.ok(within.length >= 4 && within.every(p => p.status === "200"), `within the lease: ${show(within)}`);
      assert.ok(expired.length >= 4 && expired.every(p => p.status !== "200"), `after it: ${show(expired)}`);
      assert.ok(again.length >= 2 && again.every(p => p.status === "200"), `after cubed came back: ${show(again)}`);
      // One connection through the loss (curl reuses it: one connect): 200
      // while cubed is here, 403 once the lease is over (not closed), and 200
      // again once cubed is back (not poisoned by the stop).
      assert.equal(held, "200 1|403 0|200 0|", `the held connection's three requests (status, connects): ${held}`);
      // The download's upstream closed when the lease ran out: the guest got
      // what the runner had buffered for it (it reads at 200 KB/s, so that
      // drains for a while), then EOF; never a reset, never the full 11.4 MB
      // (nor curl's own 60 s limit). At most 200 KB/s until the lease ended
      // plus what was in flight: the runner's buffers for one flow and the
      // guest's own receive window (8 MiB together is generous; the whole
      // tarball is 11.4 MB, and a download that was not stopped also ends
      // with exit 0 or 28, which this refuses).
      const dlAt = Number(dlEnd) - lost;
      const cap = (leaseMs + 4000) / 1000 * 200 * 1024 + 8 * 1024 * 1024;
      assert.ok(dlStatus === "200" && Number(dlBytes) > 0 && Number(dlBytes) < cap && !["0", "28"].includes(dlExit ?? "") && dlAt < 50000,
        `the download: ${dlStatus}, ${dlBytes} bytes (at most ${Math.round(cap)}), exit ${dlExit} "${dlError}", ended ${dlAt} ms after cubed went`);
      assert.doesNotMatch(dlError ?? "", /reset/i, "never a reset");
      assert.ok(flood > lost + leaseMs && flood < returned, `the 300 connections ran while the lease was over (${flood - lost} ms after cubed went, returned at ${returned - lost})`);
      note(`V5 5: lease 3 s: ${within.length} probes 200 within it, ${expired.length} refused after it, ${again.length} 200 after cubed came back; one connection answered ${held.split("|").slice(0, 3).map(r => r.split(" ")[0]).join(", ")} before, during and after the loss (reused); a download ended ${dlAt} ms after cubed went, after draining (${dlBytes} bytes, curl exit ${dlExit}: ${dlError})`);

      // 6b. what was refused while cubed was gone, then the count of what the full queue dropped
      const queued = await reader.take(256, 30000);
      assert.ok(queued.every(r => r.reason === "lease_expired" && /^[0-9.]+:(80|443)$|^example\.com$/.test(r.host)), show(queued.slice(0, 3)));
      const afterFlood = await shell(backWorkspace, "v5-after-flood", "curl -s -o /dev/null -m 20 -D - https://example.net/ | tr -d '\\r' | sed -n 's/^x-cube-denied: //Ip'; true");
      assert.equal(afterFlood.output.trim(), "host is denied by the egress policy");
      const [next] = await reader.take(1, 20000);
      assert.equal(next!.reason, "deny_host");
      assert.ok(next!.droppedBefore > 0n, `dropped_before ${next!.droppedBefore}`);
      note(`V5 6b: 256 lease_expired reports kept while cubed was gone; the next report says dropped_before=${next!.droppedBefore}`);
      reader.discard();
      await reader.close();

      // ------------------------------------------------ V6–V8 (masterplan B-5)
      // A credential through the real chain: the guest -> berth vm -> a
      // `credential` stream on cubed's connection -> cubed's RunnerSession ->
      // cube-gateway's credential proxy (a test-hooks build: github.com and
      // api.github.com reach the fake GitHub, scripts/fake-github.ts) and
      // back. The token is only in the gateway and the fake; the guest holds
      // the placeholder PH (its GH_TOKEN). The test plays the rest of cubed:
      // its egress policy on egress.sock, the gateway's supervisor, and the
      // registry's check (this thread's machine at its current epoch).
      const ghToken = `ghs_b5${randomBytes(12).toString("hex")}`;
      const [tokenHead, tokenTail] = [ghToken.slice(0, 10), ghToken.slice(10)];
      const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY || (() => {
        execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks"],
          { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
        return path.join(repo, "target/test-hooks/debug/cube-gateway");
      })();
      const logged: string[] = [];
      const capture = (scope: string) => {
        const line = (level: string) => (message: string, fields?: object) => logged.push(`${scope} ${level} ${message} ${show(fields ?? {})}`);
        const logger = { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error"), child: () => logger };
        return logger as never;
      };
      const run5 = path.join(root, "run");
      fs.mkdirSync(run5, { mode: 0o700 });
      const github = await fakeGithub({ dir: path.join(root, "github"), token: ghToken });
      const credentialSocket = path.join(run5, "credential.sock");
      const egress5 = new EgressPolicy({ vms: { vm: vmId => vmId === ref.id ? { threadId: ref.owner, placeholders: { github: PH } } : null },
        secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => ghToken }], log: capture("egress") });
      const decider = await serveEgress(path.join(run5, "egress.sock"), egress5);
      const gateway = new GatewaySupervisor({ decide: path.join(run5, "egress.sock"), credential: credentialSocket, binary: gatewayBin, log: capture("gateway"),
        extraArgs: ["--test-upstream", `github.com=127.0.0.1:${github.port}`, "--test-upstream", `api.github.com=127.0.0.1:${github.port}`, "--test-upstream-ca", github.ca] });
      gateway.start();
      try {
        await gateway.ready();
        assert.equal(fs.statSync(credentialSocket).mode & 0o777, 0o600, "the credential socket is the user's alone");
        assert.equal(fs.statSync(run5).mode & 0o777, 0o700);
        let cubedEpoch = epoch;
        let cubedMachine = ref.id;
        const route: CredentialRoute = {
          // cubed's own check (registryCredentialRoute's), on what the test's "registry" holds.
          refuse: (runner, machine, fence) => checkMachine({ owner: ref.owner, id: cubedMachine, epoch: cubedEpoch }, runner.nodeId, machine, fence),
          socket: () => gateway.running ? credentialSocket : null,
        };
        const credentialSession = () => {
          const opened = new RunnerSession(loadSessionConfig(configPath).config, { credentials: route, log: capture("session") });
          sessions.push(opened);
          return opened;
        };
        for (const s of sessions.splice(0)) await s.close();
        session = credentialSession();
        // cubed's own policy for the thread: one credential rule on exactly the secret's hosts.
        const policy5 = egress5.policyFor({ vm: { placeholders: { github: PH } } });
        assert.equal((await startWith(policy5)).status?.phase, MachineStatus_Phase.RUNNING);
        let b5 = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-b5:${process.pid}`, retryMs: 2000 });
        const sh = async (key: string, command: string, timeoutMs = 30000) => {
          const done = await shell(b5, key, command, timeoutMs);
          assert.equal(done.exitCode, 0, `${key}: ${done.output}`);
          return done.output.trim();
        };

        // V6: gh and git push with the host's token; the guest never has it.
        assert.equal(await sh("v6-gh", "gh api user --jq .login"), "cube-e2e");
        const pushed = await sh("v6-push", "set -e; rm -rf /tmp/r; git clone -q https://github.com/cube-e2e/repo.git /tmp/r; cd /tmp/r; echo b5 > b5.txt; git add b5.txt; "
          + "git -c user.name=b5 -c user.email=b5@example.invalid commit -qm b5; git push -q origin HEAD:main; git rev-parse HEAD", 120000);
        assert.equal(gitAt(github.repository, "rev-parse", "main"), pushed, "the push reached the fake GitHub");
        assert.ok(github.seen.some(s => s.method === "POST" && s.path.endsWith("/git-receive-pack") && s.auth === "token"), show(github.seen));
        // 100 MiB of random data: a measurement of the chain (Node carries every byte in cubed).
        const big = (await sh("v6-push-100m", "set -e; cd /tmp/r; head -c 104857600 /dev/urandom > big.bin; git add big.bin; "
          + "git -c user.name=b5 -c user.email=b5@example.invalid commit -qm big; s=$(date +%s%3N); git push -q origin HEAD:main; e=$(date +%s%3N); "
          + "echo \"$((e - s)) $(git rev-parse HEAD)\"", 900000)).split("\n").at(-1)!.split(" ");
        assert.equal(gitAt(github.repository, "rev-parse", "main"), big[1], "the 100 MiB push reached the fake GitHub");
        const pushMs = Number(big[0]);
        note(`V6: gh api user and git push through the credential stream; 100 MiB push in ${pushMs} ms (${(100 / (pushMs / 1000)).toFixed(1)} MiB/s)`);

        // V7: what the gateway substituted comes back as the guest's own value.
        const curlEcho = async (key: string, args: string) => {
          const all = await sh(key, `curl -s -o /tmp/b7 -D /tmp/h7 -w '%{http_code} %{exitcode}' ${args}; echo; tr -d '\\r' < /tmp/h7 | grep -i '^x-echo-auth:\\|^x-cube-\\|^content-length:\\|^transfer-encoding:'; echo ---; cat /tmp/b7`);
          const marker = all.indexOf("\n---");
          return { status: all.slice(0, all.indexOf("\n")), headers: all.slice(all.indexOf("\n") + 1, marker), body: all.slice(marker + 4).replace(/^\n/, ""), all };
        };
        const bearer = `Bearer ${PH}`;
        const basic = `Basic ${Buffer.from(`x-access-token:${PH}`).toString("base64")}`;
        const checks: string[] = [];
        const echoed = await curlEcho("v7-bearer", `--compressed -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/cube-test/echo`);
        assert.equal(echoed.status, "200 0", echoed.all);
        assert.match(echoed.headers, new RegExp(`^x-echo-auth: ${bearer}$`, "mi"), echoed.all);
        assert.equal(echoed.body, `auth=[${bearer}]`);
        checks.push("Bearer in header and Content-Length body");
        const basicEcho = await curlEcho("v7-basic", `-u "x-access-token:$GH_TOKEN" https://github.com/cube-test/echo`);
        assert.equal(basicEcho.body, `auth=[${basic}]`, basicEcho.all);
        assert.match(basicEcho.headers, new RegExp(`^x-echo-auth: ${basic.replace(/[+/]/g, c => `\\${c}`)}$`, "mi"));
        checks.push("the whole Basic value in header and body");
        const bearerAt = [0, 7, 8, 12, 7 + Math.floor(ghToken.length / 2), 7 + ghToken.length - 1, 7 + ghToken.length];
        for (const at of bearerAt) {
          const split = await curlEcho(`v7-split-${at}`, `-H "Authorization: Bearer $GH_TOKEN" 'https://api.github.com/cube-test/split?at=${at}'`);
          assert.equal(split.status, "200 0", split.all);
          assert.equal(split.body, `auth=[${bearer}]`, `split at ${at}: ${split.all}`);
        }
        const basicAt = [6, 10, 30, 6 + Math.floor((basic.length - 6) / 2)];
        for (const at of basicAt) {
          const split = await curlEcho(`v7-split-basic-${at}`, `-u "x-access-token:$GH_TOKEN" 'https://github.com/cube-test/split?at=${at}'`);
          assert.equal(split.body, `auth=[${basic}]`, `basic split at ${at}: ${split.all}`);
        }
        checks.push(`chunked, the value split across two chunks at ${bearerAt.length + basicAt.length} places`);
        const encoded = await curlEcho("v7-gzip", `--compressed -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/cube-test/gzip`);
        assert.equal(encoded.status, "502 0", encoded.all);
        assert.match(encoded.headers, /^x-cube-error: the credential proxy refuses an encoded answer$/mi);
        checks.push("an encoded answer 502");
        const v7 = github.seen.filter(s => s.path.startsWith("/cube-test/"));
        assert.ok(v7.length >= 3 + bearerAt.length + basicAt.length && v7.every(s => s.auth === "token" && s.acceptEncoding === "identity"), show(v7));
        assert.ok(![echoed, basicEcho, encoded].some(r => r.all.includes(ghToken)));
        note(`V7: the guest saw only its placeholder: ${checks.join("; ")}; the fake got the token with Accept-Encoding: identity each time (${v7.length} requests)`);

        // V8: redirects are the guest's; a placeholder never leaves for the wrong host.
        const seenBefore = github.seen.length;
        const followed = await sh("v8-follow", `curl -s -L -o /dev/null -w '%{http_code} %{num_redirects} %{url_effective}' -H "Authorization: Bearer $GH_TOKEN" 'https://api.github.com/cube-test/redirect?to=https://example.com/'`);
        assert.equal(followed, "200 1 https://example.com/", "curl drops Authorization at another host; ordinary egress from the runner");
        assert.equal(github.seen.length, seenBefore + 1, "the gateway did not follow the redirect");
        const trusted = await sh("v8-trusted", `curl -s -L --location-trusted -o /dev/null -D - -H "Authorization: Bearer $GH_TOKEN" 'https://api.github.com/cube-test/redirect?to=https://example.com/' | tr -d '\\r' | sed -n 's/^x-cube-denied: //Ip'`);
        assert.equal(trusted, "a secret placeholder is only sent where a credential rule allows it", "berth refuses the placeholder at example.com");
        await startWith({ ...policy5, rules: [{ ...policy5.rules![0]!, hosts: ["github.com", "api.github.com", "uploads.github.com"] }] });
        const widened = await sh("v8-not-the-secrets", `curl -s -o /dev/null -D - -H "Authorization: Bearer $GH_TOKEN" https://uploads.github.com/x | tr -d '\\r' | sed -n 's/^x-cube-denied: //Ip'`);
        assert.equal(widened, "the github secret is not allowed for uploads.github.com", "cubed's decide refuses a host outside the secret's");
        await startWith(policy5);
        note("V8: a redirect is passed to the guest and never followed; without the placeholder it went out from the runner, with it berth refused it (placeholder), and a host in the rule but not the secret's was refused by decide");

        // Ownership: a machine cubed no longer has for the thread (released,
        // archived, another machine) is refused before the proxy.
        const asked = (key: string) => sh(key, `curl -s -o /dev/null -D - -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | tr -d '\\r' | sed -n 's/^HTTP\\/1.1 //p;s/^x-cube-error: //Ip'`);
        const proxiedBefore = github.seen.length;
        cubedMachine = "f".repeat(16);
        assert.equal(await asked("owner-other"), `503 Service Unavailable\ncubed refused the credential request: machine ${ref.id} is not a machine of a thread on runner ${node}`);
        cubedMachine = ref.id;
        // The fence: cubed's epoch newer than the runner's is refused, until a fenced start raises it.
        cubedEpoch = epoch + 1;
        const stale = await asked("fence-stale");
        assert.equal(stale, "503 Service Unavailable\ncubed refused the credential request: a newer epoch has been used for this machine", stale);
        epoch += 1;
        await startWith(policy5);
        assert.equal(github.seen.length, proxiedBefore, "nothing refused reached GitHub");
        assert.equal(await sh("fence-raised", "gh api user --jq .login"), "cube-e2e");
        note("ownership and fence: a machine cubed does not have for the thread refused (503, wrong_machine); a credential stream below cubed's epoch refused (503, stale_epoch); a fenced start raised the runner's and it went through");

        // cubed goes during a download from the credential host: the guest
        // gets what the runner had, then EOF (never a reset); a new credential
        // request is refused at once while ordinary egress goes on (lease 15 min),
        // and the refusal is reported on the next connection.
        const holder = await b5.lease({ owner: "pi" });
        const script = [
          "rm -f /tmp/dl5.log /tmp/after5.log",
          `( curl -s -o /dev/null --limit-rate 200k -m 120 -w '%{http_code}|%{size_download}|%{exitcode}|%{errormsg}\\n' -H "Authorization: Bearer $GH_TOKEN" 'https://github.com/cube-test/large?mib=100' > /tmp/dl5.log; date +%s%3N >> /tmp/dl5.log ) &`,
          "sleep 8",
          `echo "$(date +%s%3N) $(curl -s -o /dev/null -D - -m 20 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | tr -d '\\r' | sed -n 's/^HTTP\\/1.1 \\([0-9]*\\).*/\\1/p;s/^x-cube-error: //Ip' | tr '\\n' '|')" > /tmp/after5.log`,
          `echo "public $(curl -s -o /dev/null -m 20 -w '%{http_code}' http://example.com/)" >> /tmp/after5.log`,
          "wait",
        ].join("\n");
        await b5.exec(holder.token, "b5-disconnect", { command: script, timeoutMs: 180000 });
        await b5.release(holder.token);
        await new Promise(resolve => setTimeout(resolve, 3000));
        for (const s of sessions.splice(0)) await s.close();
        const lost = Date.now();
        await new Promise(resolve => setTimeout(resolve, 12000));
        session = credentialSession();
        await session.hello();
        const back = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-b5:${process.pid}`, retryMs: 2000 });
        b5 = back;
        const backLease = await back.lease({ owner: "pi" });
        const ended = await settleOperation(back, backLease.token, "b5-disconnect");
        await back.release(backLease.token);
        assert.equal(ended.state, "succeeded", JSON.stringify(ended));
        const [dl, after] = [(await shell(back, "b5-dl", "cat /tmp/dl5.log | tr '\\n' '|'")).output.trim(), (await shell(back, "b5-after", "cat /tmp/after5.log")).output.trim()];
        const [dlStatus, dlBytes, dlExit, dlError, dlEnd] = dl.split("|");
        assert.ok(dlStatus === "200" && Number(dlBytes) > 0 && Number(dlBytes) < 100 * 1024 * 1024 && !["0", "28"].includes(dlExit ?? "") && Number(dlEnd) - lost < 60000,
          `the download: ${dl} (ended ${Number(dlEnd) - lost} ms after cubed went)`);
        assert.doesNotMatch(dlError ?? "", /reset/i, "never a reset");
        const [refusedLine = "", publicLine] = after.split("\n");
        const refused5 = /^(\d+) (\d+)\|(.*)\|$/.exec(refusedLine);
        assert.ok(refused5, after);
        const [, refusedAt, refusedStatus, refusedReason] = refused5;
        assert.equal(refusedStatus, "503", after);
        assert.equal(refusedReason, "credentials need cubed, which the runner cannot reach", after);
        assert.ok(Number(refusedAt) > lost && Number(refusedAt) < lost + 12000, `refused while cubed was gone: ${after}`);
        assert.equal(publicLine, "public 200", "ordinary egress goes on within the lease");
        for (let i = 0; i < 100 && !logged.some(line => /session info egress refused .*"reason":"credential_unavailable"/.test(line)); i++) await new Promise(resolve => setTimeout(resolve, 200));
        assert.ok(logged.some(line => /session info egress refused .*"host":"api\.github\.com".*"reason":"credential_unavailable"/.test(line)), logged.filter(l => l.includes("egress refused")).join("\n"));
        note(`disconnect: a download from the credential host ended ${Number(dlEnd) - lost} ms after cubed went (${dlBytes} bytes, curl exit ${dlExit}: ${dlError}); a credential request meanwhile 503 credential_unavailable, ordinary egress 200; the report reached cubed's next connection`);

        // The token: nowhere in the guest, the runner's directory (state,
        // journal, logs, rw.qcow2), its stderr or any log (the gateway keeps no state).
        const guestScan = await sh("v6-scan", `sudo bash -c 'a=${tokenHead}; b=${tokenTail}; grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e "$a$b" / | head -5; `
          + `for f in /proc/[0-9]*/environ; do grep -lsF -e "$a$b" "$f"; done | head -5'; echo scan-done`, 900000);
        assert.equal(guestScan, "scan-done", `the token is in the guest: ${guestScan}`);
        // Every regular file of berth's --dir, read in
        // full (leak-scan.ts; grep differs between hosts). The machine runs, so
        // its QMP, event and channel sockets are there: listed, never read;
        // anything else that is not a regular file fails the scan.
        const hostScan = scanForSecret([directory], ghToken);
        assert.deepEqual(hostScan.matches, [], "the token is in the runner's directory");
        assert.ok(hostScan.files > 0 && hostScan.skipped.every(s => s.kind === "socket"), `not scanned: ${show(hostScan.skipped)}`);
        assert.ok(hostScan.skipped.some(s => s.path.endsWith("qmp.sock")), `the running machine's sockets: ${show(hostScan.skipped)}`);
        assert.ok(!runner.banner.includes(ghToken) && !logged.some(line => line.includes(ghToken)), "the token is in berth's stderr or a log");
        assert.ok(logged.some(line => line.startsWith("gateway ")), "the gateway's log was captured");
        const diagnosed = (await diagnose(session, ref, epoch)).text;
        assert.ok(!diagnosed.includes(ghToken) && !diagnosed.includes(PH), "the token or the placeholder is in the diagnosis");
        note(`V6 leak scan: the token is in no guest file or process environment, not in berth's --dir (${hostScan.files} files, ${hostScan.bytes} bytes read, rw.qcow2 included; ${hostScan.skipped.length} sockets not read), its stderr, the machine's diagnosis or the ${logged.length} log lines of cubed's side`);
      } finally {
        await gateway.stop();
        await decider.close();
        github.close();
      }

      // ------------------------------------------------ V9 (masterplan B-6)
      // The portal over the runner's `dial` streams: cubed's real Portal ->
      // RunnerSession.dial at the machine's epoch (as RunnerMachines.dial)
      // -> berth vm -> the machine's LAN -> dial-app.pl, which the agent
      // starts with `cube service` (portal-dial.ts; offline in
      // runner-dial-test.ts against a fake runner).
      for (const s of sessions.splice(0)) await s.close();
      session = open();
      const b6 = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-b6:${process.pid}`, retryMs: 2000 });
      const sh9 = async (key: string, command: string, timeoutMs = 60000) => {
        const done = await shell(b6, `${key}-${randomBytes(3).toString("hex")}`, command, timeoutMs);
        assert.equal(done.exitCode, 0, `${key}: ${done.output}`);
        return done.output.trim();
      };
      assert.equal(await sh9("v9-perl", "perl -MDigest::SHA -MMIME::Base64 -e 'print qq(ok\\n)'"), "ok", "dial-app.pl needs perl with Digest::SHA and MIME::Base64");
      const appPort = 20000 + Math.floor(Math.random() * 20000);
      const appLease = await b6.lease({ owner: "pi" });
      try { await b6.writeFile(appLease.token, `v9-app-${process.pid}`, "v9/dial-app.pl", fs.readFileSync(DIAL_APP), { createParents: true }); }
      finally { await b6.release(appLease.token); }
      const started = JSON.parse(await sh9("v9-start", `mkdir -p /tmp/v9-state && cube service start dialapp --port ${appPort} --cwd v9 --env CUBE_APP_STATE=/tmp/v9-state --json -- perl dial-app.pl`, 120000)) as { ok: boolean };
      assert.equal(started.ok, true, show(started));
      v9 = { target: await dialPortal({ session: () => session, guest: () => session.guest(ref, () => epoch), ref, epoch: () => epoch, directory: path.join(root, "portal") }), port: appPort };
      const readState = async (name: string) => (await sh9("v9-state", `cat /tmp/v9-state/${name} 2>/dev/null; true`)) || null;
      for (const line of await portalContract(v9.target, "dialapp", readState)) note(`V9: ${line}`);

      // Refused by the runner whatever listens there: dial-app.pl as root on
      // port 80 (it answers inside the guest), nothing on 22 (keel has no sshd).
      await withListener(b6, `v9-low-${process.pid}`, {
        listener: "cd v9 && exec sudo env HOST=0.0.0.0 PORT=80 CUBE_SERVICE=low CUBE_APP_STATE=/tmp/v9-state perl dial-app.pl",
        probe: "for i in $(seq 100); do curl -s -m 2 http://127.0.0.1:80/ && break; sleep 0.2; done",
        expect: "dial-app: hello from low",
      }, async () => {
        for (const port of [80, 22, 1023]) await assert.rejects(session.dial(ref, epoch, port), dialRefused("PERMISSION_DENIED", "port"), `port ${port}`);
        await assert.rejects(session.dial(ref, epoch, 1999), dialRefused("UNAVAILABLE", "dial_failed"), "nothing listens on 1999");
      });
      // An old fence is refused; the machine's own goes through.
      await assert.rejects(session.dial(ref, epoch - 1, appPort), dialRefused("FAILED_PRECONDITION", "stale_epoch"));
      (await session.dial(ref, epoch, appPort)).destroy();
      note("V9: refused: port 80 with a listener (it answers inside the guest), 22 and 1023 (PERMISSION_DENIED/port), the fence before the machine's (stale_epoch); nothing on 1999: UNAVAILABLE/dial_failed");

      // cubed goes: an open connection through the portal ends; a new session dials again.
      const open9 = await Raw.open(v9.target.port, `GET /fin-client HTTP/1.1\r\nHost: ${v9.target.host("dialapp")}\r\nConnection: Upgrade\r\nUpgrade: cube-test\r\n\r\n`);
      assert.match(await open9.head(), /^HTTP\/1\.1 101 /);
      const went = Date.now();
      await session.close();
      await open9.until("the portal's connection ends when cubed's session closes", r => r.ended, 15000);
      const endedMs = Date.now() - went;
      open9.socket.destroy();
      session = open();
      const again9 = await request(v9.target.port, v9.target.host("dialapp"), "GET", "/");
      assert.equal(again9.status, 200, again9.body.toString());
      note(`V9: cubed's connection closed: an open portal connection ended after ${endedMs} ms; a new session dials again (200)`);
      transport = session.guest(ref, () => epoch);
    } finally {
      store.close();
      fs.rmSync(leases, { recursive: true, force: true });
    }
  } else {
    // Not ready: the image lacks what keel needs; operations are refused.
    assert.match(guest.reason, /^the image lacks /);
    await assert.rejects(transport.call("exec", { id: "x", epoch: 1, command: "true", timeoutMs: 1000 }), refusedBy("UNAVAILABLE", "not_ready"));
    note(`not ready (the image lacks what keel needs): exec refused UNAVAILABLE/not_ready over the guest stream`);
  }

  epoch += 10;
  await session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  await assert.rejects(session.call({ case: "machineStop", value: { ref, fence: { epoch: BigInt(epoch - 5) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "stale_epoch");
  await assert.rejects(session.call({ case: "machineDiscard", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "not_retained");

  // stop quits QEMU; the guest status goes; a start boots again on the same writable disk
  let pid = record(ref.id).boot!.pid;
  // V9: a connection through the portal while the machine stops.
  const heldOverStop = v9 ? await Raw.open(v9.target.port, `GET /fin-client HTTP/1.1\r\nHost: ${v9.target.host("dialapp")}\r\nConnection: Upgrade\r\nUpgrade: cube-test\r\n\r\n`) : null;
  if (heldOverStop) assert.match(await heldOverStop.head(), /^HTTP\/1\.1 101 /);
  const stopped = await stopVia(session, ref, epoch);
  assert.equal(stopped.status?.phase, MachineStatus_Phase.STOPPED);
  assert.equal(stopped.status?.bootId, "");
  assert.equal(stopped.status?.guest, undefined, "no guest status without QEMU");
  await gone(pid);
  assert.equal(condition(stopped, "Interrupted"), undefined, "a stop cubed asked for is no interruption");
  assert.equal(condition(stopped, "Stopped")?.reason, "controlled", show(stopped.status?.conditions));
  await assert.rejects(transport.call("hello", {}), refusedBy("UNAVAILABLE", "not_running"));
  // B-9 stopped: what is left of the last boot, said to be not current.
  {
    const { doc } = await diagnose(session, ref, epoch);
    assert.equal(doc.machine.phase, "stopped");
    assert.equal(doc.machine.bootId, null);
    assert.equal(doc.machine.newestBoot?.current, false);
    assert.equal(doc.machine.stopped?.kind, "controlled");
    assert.deepEqual([doc.qemu.running, doc.qemu.pid, doc.qemu.argv.present, doc.qemu.argv.current], [false, null, true, false]);
    assert.deepEqual([doc.qmp.asked, doc.qmp.status], [false, null]);
    assert.equal(doc.qmp.reason, "the machine is stopped: no QEMU runs");
    assert.equal(doc.guest.info, null);
    assert.match(doc.guest.reason, /goes with its QEMU/);
    assert.deepEqual([doc.console.present, doc.console.current], [true, false]);
    assert.ok(doc.events.lines.some((line: string) => /stop: controlled/.test(line)), show(doc.events.lines.slice(-5)));
    assert.equal(doc.egress.policy.current, false);
    note(`B-9 stopped: Stopped/${doc.machine.stopped.kind}, no QMP (${doc.qmp.reason}), no GuestInfo, console of boot ${doc.console.bootId} not current`);
  }
  if (v9 && heldOverStop) {
    await heldOverStop.until("the portal's connection ends when the machine stops", r => r.ended || r.closed, 15000);
    heldOverStop.socket.destroy();
    await assert.rejects(session.dial(ref, epoch, v9.port), dialRefused("UNAVAILABLE", "not_running"));
    await v9.target.portal.close();
    v9 = undefined;
    note("V9: the machine stopped: an open portal connection ended, and a dial to the stopped machine is refused (UNAVAILABLE/not_running)");
  }

  // ------------------------------------------------ V10 (masterplan B-8)
  // Templates as layers: a build machine (MachineSpec.build) gets a blank
  // template disk (vdd), its agent publishes its upper/ there, berth keeps it
  // as templates/<id>.erofs and deletes the build machine; a machine made
  // from it sees the build's files without the runner's CA or cube's
  // blocks, keeps what it writes, and the template survives a restart, is
  // refused on another image (template_image_changed) and goes with its
  // last machine after template_delete. The first machine is stopped here.
  if (guest.ready) {
    const leases10 = fs.mkdtempSync(path.join(os.tmpdir(), "runner-vm-b8-"));
    const store10 = new LeaseStore(leases10);
    try {
      const fence10 = { epoch: BigInt(epoch) };
      const workspace10 = (machine: { owner: string; id: string }) => new VmWorkspace({ guest: session.guest(machine, () => epoch), leases: store10, owner: "pi",
        binding: `runner-vm-test-b8-${machine.id}:${process.pid}`, retryMs: 2000 });
      const sh10 = async (workspace: Workspace, key: string, command: string, timeoutMs = 60000) => {
        const done = await shell(workspace, `${key}-${randomBytes(3).toString("hex")}`, command, timeoutMs);
        assert.equal(done.exitCode, 0, `${key}: ${done.output}`);
        return done.output;
      };
      // The runner CA's first base64 line: what any PEM copy of it holds.
      const caLine = caPem.split("\n")[1]!;
      assert.match(caLine, /^[A-Za-z0-9+/]{64}$/);
      // An ordinary machine has no template disk and never had one.
      assert.ok(!fs.existsSync(path.join(machineDir, "template.raw")));
      assert.ok(!(JSON.parse(fs.readFileSync(path.join(machineDir, "argv.json"), "utf8")) as { args: string[] }).args.some(a => a.includes("template.raw")));

      // cube's own source holds the marker inside a line (generated.rs, the
      // agent check): no block of cube's, so it travels as it is. A line of
      // the marker alone is one.
      const markerText = "# cube: begin (keel writes this block on every machine_setup)";
      const sourceLines = `pub const BEGIN: &str = "${markerText}";\nconst MARKER: &str = "${markerText}";\n`;
      const writeSource = `printf '%s' '${sourceLines.replaceAll("'", "'\\''")}' > app/source.rs`;
      const sourceSha = createHash("sha256").update(sourceLines).digest("hex");

      // The runner's real CA left where the scrub cannot cut it out, in four
      // forms made in the guest from /etc/cube/ca.pem, beside cube's source
      // and a block of cube's the scrub cannot cut out (an indented marker
      // line): the template would be bound to the CA, so the seal names
      // only the block; no template is made.
      const leakRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
      await session.machine({ case: "machineCreate", value: { ref: leakRef, fence: fence10,
        spec: { source: { case: "base", value: true }, size: { vcpus: 2, memoryMib: 1024, diskGib: 2 }, build: true } } });
      await session.machine({ case: "machineStart", value: { ref: leakRef, fence: fence10, boot: { documents, mac: "" } } });
      await session.until(leakRef, machine => !!machine.status?.guest?.ready, 180000);
      const leaker = workspace10(leakRef);
      const leakOut = await sh10(leaker, "v10-leaks", String.raw`set -e; mkdir -p app; ${writeSource}
body=$(sudo sed '/-----/d' /etc/cube/ca.pem | tr -d '\n')
printf '%s' "$body" | base64 -d > app/leak.der
printf '%s\n' "$body" | fold -w 76 > app/leak.b64
escaped=$(sudo awk '{printf "%s\\n", $0}' /etc/cube/ca.pem)
printf '{"ca":"%s"}\n' "$escaped" > app/leak.json
printf 'pub const CA: &str = "%s";\n' "$escaped" > app/leak.rs
printf '  %s\r\nGH_TOKEN=cube_ph_github_x\n' '${markerText}' > app/block.txt
sha256sum app/leak.der | cut -d' ' -f1; grep -c 'BEGIN CERTIFICATE' app/leak.json app/leak.rs; grep -c '^' app/leak.json app/leak.rs`, 120000);
      const caDer = Buffer.from(caPem.split("\n").filter(line => line && !line.startsWith("-----")).join(""), "base64");
      assert.equal(leakOut, `${createHash("sha256").update(caDer).digest("hex")}\napp/leak.json:1\napp/leak.rs:1\napp/leak.json:1\napp/leak.rs:1\n`,
        "the guest made the runner's own CA into DER and one-line escaped PEM copies");
      let sealed = "";
      await assert.rejects(session.call({ case: "templatePublish", value: { from: leakRef, fence: fence10, key: "v10-leaks", meta: "" } }, 600000),
        (error: unknown) => { sealed = String(error); return error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "seal_failed"; });
      const named = [...sealed.matchAll(/\/workspace\/app\/[^ ;]+/g)].map(m => m[0]).sort();
      assert.deepEqual(named, ["/workspace/app/block.txt"], sealed);
      assert.ok(!sealed.includes("source.rs") && !sealed.includes("leak."), sealed);
      const noLeakTemplate = await session.call({ case: "templateList", value: {} });
      assert.ok(noLeakTemplate.case === "templates" && noLeakTemplate.value.items.length === 0, show(noLeakTemplate));
      assert.ok(!fs.existsSync(path.join(directory, "templates", `${leakRef.id}.erofs`)));
      await stopVia(session, leakRef, epoch);
      await session.machine({ case: "machineDelete", value: { ref: leakRef, fence: fence10, retain: false } });
      note(`V10: the runner's real CA as DER, wrapped base64, escaped PEM in JSON and in a Rust string, beside cube's source and an indented marker line: seal_failed naming only the marker line, no template; the machine deleted`);

      // A build machine: its template disk is vdd, blank, sparse, writable.
      const buildRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
      const built = await session.machine({ case: "machineCreate", value: { ref: buildRef, fence: fence10,
        spec: { source: { case: "base", value: true }, size: { vcpus: 2, memoryMib: 1024, diskGib: 2 }, build: true } } });
      assert.equal(built.spec?.build, true);
      const vdd = fs.statSync(path.join(directory, buildRef.id, "template.raw"));
      assert.ok(vdd.size === 2 * 2 ** 30 && vdd.blocks * 512 < 2 ** 20, `a sparse 2 GiB vdd: ${vdd.size} bytes, ${vdd.blocks} blocks`);
      await session.machine({ case: "machineStart", value: { ref: buildRef, fence: fence10, boot: { documents, mac: "" } } });
      const buildBlocks = await qmp(buildRef.id, "query-block") as Array<{ inserted?: { ro: boolean; file: string } }>;
      const buildRo = Object.fromEntries(buildBlocks.filter(b => b.inserted).map(b => [path.basename(b.inserted!.file), b.inserted!.ro]));
      assert.deepEqual(buildRo, { "base.erofs": true, "layers.vmdk": true, "rw.qcow2": false, "template.raw": false }, "vdd is the build machine's writable template disk");
      await session.until(buildRef, machine => !!machine.status?.guest?.ready, 180000);
      const builder = workspace10(buildRef);
      const marker = randomBytes(8).toString("hex");
      const setupOut = await sh10(builder, "v10-setup", `set -e; mkdir -p app; printf ${marker} > app/built.txt; ${writeSource}; cp /etc/ssl/certs/ca-certificates.crt app/bundle-copy.pem
grep -c 'cube: begin' app/bundle-copy.pem; grep -cF '${caLine}' app/bundle-copy.pem
sudo mkdir -p /opt/v10 /etc/ssl/certs/java; echo setup-done | sudo tee /opt/v10/setup.txt >/dev/null
{ printf '\\376\\355\\376\\355'; sudo sed '/-----/d' /etc/cube/ca.pem | tr -d '\\n' | base64 -d; } | sudo tee /etc/ssl/certs/java/cacerts >/dev/null`, 120000);
      assert.equal(setupOut, "1\n1\n", "before the publication the build machine has the runner's CA and cube's block, in a copy too");

      // template_publish: the agent cleans and writes the layer, berth keeps it.
      const ask = { from: buildRef, fence: fence10, key: "v10-key", meta: "{\"setup\":\"v10\"}" };
      const t10 = Date.now();
      const published = await session.call({ case: "templatePublish", value: ask }, 600000);
      const publishMs = Date.now() - t10;
      assert.equal(published.case, "template");
      const template = published.value as Template;
      assert.deepEqual([template.id, template.state, template.key, template.meta, template.diskGib, template.users],
        [buildRef.id, Template_State.READY, "v10-key", "{\"setup\":\"v10\"}", 2, 0], show(template));
      const layer = path.join(directory, "templates", `${buildRef.id}.erofs`);
      const layerStat = fs.statSync(layer);
      assert.equal(BigInt(layerStat.size), template.bytes, "the layer file is cut to the superblock's size");
      assert.equal(erofsBytes(layer), template.bytes, "the size is the EROFS superblock's");
      assert.ok(template.bytes < 2n * 2n ** 30n, "the layer, not the whole template disk");
      assert.equal(layerStat.mode & 0o777, 0o444);
      const layerSha = createHash("sha256").update(fs.readFileSync(layer)).digest("hex");
      assert.ok(!fs.existsSync(path.join(directory, buildRef.id)), "the build machine's directory is gone");
      assert.equal((await session.machine({ case: "machineGet", value: { ref: buildRef } })).status?.phase, MachineStatus_Phase.DELETED);
      const again10 = await session.call({ case: "templatePublish", value: ask }, 60000);
      assert.equal(show(again10.value), show(template), "a publication asked again gets the same template");
      await assert.rejects(session.call({ case: "templatePublish", value: { ...ask, key: "other" } }), (error: unknown) => error instanceof RunnerError && error.code === "ALREADY_EXISTS");
      const listed = await session.call({ case: "templateList", value: {} });
      assert.ok(listed.case === "templates" && listed.value.items.length === 1 && listed.value.items[0]!.state === Template_State.READY, show(listed));
      const summaryDeadline = Date.now() + 10000;
      while (!(await session.hello()).runner?.templates.some(t => t.id === buildRef.id && t.state === Template_State.READY)) {
        assert.ok(Date.now() < summaryDeadline, "the runner's templates (watch) name the new template");
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (env.CUBE_TEST_BERTH_FSCK) {
        execFileSync(env.CUBE_TEST_BERTH_FSCK, [layer], { stdio: "pipe" });
        note(`V10: fsck.erofs (${env.CUBE_TEST_BERTH_FSCK}) passed on the template layer`);
      }
      note(`V10: build machine ${buildRef.id} (vdd 2 GiB sparse, writable) published in ${publishMs} ms: template READY, ${template.bytes} bytes, 0444, sha256 ${layerSha}; the build machine DELETED; asked again: the same template; another key: ALREADY_EXISTS; in template_list and the runner's templates`);

      // A machine made from it: the build's files, nothing of cube's from the build.
      const userRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
      const made = await session.machine({ case: "machineCreate", value: { ref: userRef, fence: fence10,
        spec: { source: { case: "templateId", value: buildRef.id }, size: { vcpus: 2, memoryMib: 1024, diskGib: 4 } } } });
      assert.deepEqual([made.spec?.source.case, made.spec?.source.value, made.spec?.build], ["templateId", buildRef.id, false]);
      assert.ok(!fs.existsSync(path.join(directory, userRef.id, "template.raw")), "a machine from a template is no build machine");
      const userExtents = fs.readFileSync(path.join(directory, userRef.id, "layers.vmdk"), "utf8").split("\n").filter(line => /\.erofs"/.test(line));
      assert.equal(userExtents.length, machineImage.diffIds.length + 1);
      assert.ok(userExtents.at(-1)!.includes(layer), "the template is the topmost partition, read where it is");
      await session.machine({ case: "machineStart", value: { ref: userRef, fence: fence10, boot: { documents, mac: "" } } });
      const userReady = await session.until(userRef, machine => !!machine.status?.guest?.ready, 180000);
      // The stand-in is no keystore keel can read: reported, left as it is (its sha256 below).
      assert.equal(userReady.status?.guest?.hooks["runner-ca"], "skipped", show(userReady.status?.guest?.hooks));
      const user = workspace10(userRef);
      const seen10 = await sh10(user, "v10-seen", `cat app/built.txt; echo; cat /opt/v10/setup.txt
grep -c 'cube: begin' app/bundle-copy.pem || true; grep -cF '${caLine}' app/bundle-copy.pem || true
grep -c 'cube: begin' /etc/ssl/certs/ca-certificates.crt; grep -cF '${caLine}' /etc/ssl/certs/ca-certificates.crt; grep -c '^agent:' /etc/passwd
sha256sum app/source.rs /etc/ssl/certs/java/cacerts | cut -d' ' -f1`);
      const keystoreSha = createHash("sha256").update(Buffer.concat([Buffer.from([0xfe, 0xed, 0xfe, 0xed]), caDer])).digest("hex");
      assert.equal(seen10, `${marker}\nsetup-done\n0\n0\n1\n1\n1\n${sourceSha}\n${keystoreSha}\n`,
        "the build's files are there, cube's source as it was; its copy of the bundle lost the runner's CA and cube's block; the keystore stand-in kept the runner's CA (bound); the machine has its own CA block once and one agent account");
      const token10 = randomBytes(8).toString("hex");
      await sh10(user, "v10-write", `printf ${token10} > app/after.txt`);
      const stopped10 = await stopVia(session, userRef, epoch);
      assert.equal(condition(stopped10, "Stopped")?.reason, "controlled");
      await session.machine({ case: "machineStart", value: { ref: userRef, fence: fence10, boot: { documents, mac: "" } } });
      await session.until(userRef, machine => !!machine.status?.guest?.ready, 180000);
      assert.equal(await sh10(user, "v10-read", "cat app/after.txt; echo; cat app/built.txt"), `${token10}\n${marker}`);
      assert.equal(createHash("sha256").update(fs.readFileSync(layer)).digest("hex"), layerSha, "the template's layer never changes");
      await stopVia(session, userRef, epoch);
      note(`V10: machine ${userRef.id} from the template: the build's files there (${marker}, /opt/v10), its bundle copy without the runner CA or a marker line, the keystore stand-in with it, one CA block and one agent account of its own; a write kept over a controlled stop; the layer's sha256 unchanged`);

      // A restart keeps the template; another image refuses it (B-8 D3).
      await stop(runner.child);
      runner = await start(["--listen", "127.0.0.1:0"]);
      assert.match(runner.banner, /^templates: 1 in /m);
      writeConfig(runner.address, runner.peer);
      session = open();
      assert.ok((await session.hello()).runner?.templates.some(t => t.id === buildRef.id && t.state === Template_State.READY), "a template survives the runner's restart");
      const usersAfter = await session.call({ case: "templateList", value: {} });
      assert.ok(usersAfter.case === "templates" && usersAfter.value.items[0]!.users === 1, show(usersAfter));
      // A new runner CA (its files moved aside, made again at the start):
      // the template may hold the old one, so no machine is made from it.
      // The old CA back: usable again.
      const caAside = fs.mkdtempSync(path.join(root, "ca-aside-"));
      await stop(runner.child);
      for (const name of ["ca.key", "ca.pem"]) fs.renameSync(path.join(caDir, name), path.join(caAside, name));
      runner = await start(["--listen", "127.0.0.1:0"]);
      writeConfig(runner.address, runner.peer);
      session = open();
      const newCa = (await session.hello()).runner?.caPem ?? "";
      assert.ok(newCa && newCa !== caPem, "the runner made a new CA");
      assert.match(runner.banner, new RegExp(`^template ${buildRef.id}: built under runner CA [0-9a-f]{64}, not this one`, "m"));
      let caRefused = "";
      await assert.rejects(session.machine({ case: "machineCreate", value: { ref: { owner: "thread-1", id: randomBytes(8).toString("hex") }, fence: fence10,
        spec: { source: { case: "templateId", value: buildRef.id } } } }),
      (error: unknown) => { caRefused = String(error); return error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "template_runner_ca_changed"; });
      await stop(runner.child);
      for (const name of ["ca.key", "ca.pem"]) fs.renameSync(path.join(caAside, name), path.join(caDir, name));
      runner = await start(["--listen", "127.0.0.1:0"]);
      writeConfig(runner.address, runner.peer);
      session = open();
      assert.equal((await session.hello()).runner?.caPem, caPem, "the old CA is back");
      note(`V10: under a new runner CA a machine from the template was refused (${caRefused.slice(0, 160)}); with the old CA back it is the runner's again`);
      if (otherImage) {
        await stop(runner.child);
        runner = await start(["--listen", "127.0.0.1:0"], imageB);
        writeConfig(runner.address, runner.peer);
        session = open();
        const otherRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
        await assert.rejects(session.call({ case: "machineCreate", value: { ref: otherRef, fence: fence10, spec: { source: { case: "templateId", value: buildRef.id } } } }),
          (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "template_image_changed");
        const kept10 = await session.call({ case: "templateList", value: {} });
        assert.ok(kept10.case === "templates" && kept10.value.items.length === 1, "the template stays until it is deleted");
        assert.ok(fs.existsSync(layer));
        await stop(runner.child);
        runner = await start(["--listen", "127.0.0.1:0"]);
        writeConfig(runner.address, runner.peer);
        session = open();
        note(`V10: the template survived a restart (users 1); with --image ${imageB} a machine from it was refused (FAILED_PRECONDITION/template_image_changed) and the template stayed`);
      } else {
        note("V10: template_image_changed NOT checked here: CUBE_TEST_BERTH_IMAGE_B (another image pinned by digest) is unset");
      }

      // template_delete: removing while a machine is made from it, gone with the last.
      const removing = await session.call({ case: "templateDelete", value: { id: buildRef.id } });
      assert.ok(removing.case === "template" && removing.value.state === Template_State.REMOVING && removing.value.users === 1, show(removing));
      assert.ok(fs.existsSync(layer), "a machine is still made from it");
      await assert.rejects(session.call({ case: "machineCreate", value: { ref: { owner: "thread-1", id: randomBytes(8).toString("hex") }, fence: fence10,
        spec: { source: { case: "templateId", value: buildRef.id } } } }),
      (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "template_removing");
      const removed = await session.machine({ case: "machineDelete", value: { ref: userRef, fence: fence10, retain: false } });
      assert.equal(removed.status?.phase, MachineStatus_Phase.DELETED);
      assert.ok(!fs.existsSync(layer), "the template went with its last machine");
      assert.deepEqual(fs.readdirSync(path.join(directory, "templates")), []);
      const none = await session.call({ case: "templateList", value: {} });
      assert.ok(none.case === "templates" && none.value.items.length === 0);
      await assert.rejects(session.call({ case: "templateDelete", value: { id: buildRef.id } }), (error: unknown) => error instanceof RunnerError && error.code === "NOT_FOUND");
      note("V10: template_delete: REMOVING with 1 user (a new machine from it refused: template_removing), gone (file and record) once that machine was deleted; again: NOT_FOUND");

      // A real JDK (CUBE_TEST_BERTH_JAVA=1, the image's apt over the
      // runner's egress), installed by a build machine's setup with apt and
      // nothing else: keel's link (/etc/ssl/certs/cube-runner.pem) makes
      // ca-certificates-java put the runner's CA in Java's keystore. The
      // template is bound to the CA and published; in a machine made from it
      // Java's HTTPS works (example.com, and services.gradle.org, which the
      // Gradle wrapper reaches). Its keystore without the CA (a template
      // built before the link) and with a stale CA under cube's alias (a CA
      // rotation) is repaired by keel at the next boot, every other
      // certificate kept; the boot after that changes nothing.
      if (env.CUBE_TEST_BERTH_JAVA === "1") {
        // cubed's own policy for a thread without secrets (EgressPolicy.policyFor):
        // public HTTP and HTTPS, the 15-minute lease; a start without one has no egress.
        const javaPolicy = new EgressPolicy({ vms: { vm: () => null }, secrets: [] }).policyFor({});
        assert.equal(javaPolicy.default, EgressPolicy_Default.ALLOW_PUBLIC_HTTP);
        assert.deepEqual([javaPolicy.denyHosts, javaPolicy.rules], [[], []], "no credential rule, nothing widened");
        const startJava = (ref: { owner: string; id: string }) =>
          session.machine({ case: "machineStart", value: { ref, fence: fence10, boot: { documents, mac: "" }, policy: javaPolicy as never } });
        // keel's check of Java's keystore at this boot's setup (status.guest.hooks["runner-ca"]).
        const bootJava = async (ref: { owner: string; id: string }, expected: string | undefined) => {
          await startJava(ref);
          const booted = await session.until(ref, machine => !!machine.status?.guest?.ready, 180000);
          assert.equal(booted.status?.guest?.hooks["runner-ca"], expected, `${ref.id}: keel's keystore check at boot: ${show(booted.status?.guest?.hooks)}`);
        };
        // Both machines get it: apt and Java's HTTPS are refused by policy without it.
        const publicEgress = async (ref: { owner: string; id: string }, key: string) => {
          const reached = await sh10(workspace10(ref), key, "curl -s -o /dev/null -m 30 -w '%{http_code}' http://deb.debian.org/debian/dists/trixie/Release; echo; curl -s -o /dev/null -m 30 -w '%{http_code}' https://example.com/");
          assert.equal(reached, "200\n200", `${key}: the Java leg's machine runs with cubed's public policy (deb.debian.org over HTTP, example.com over HTTPS)`);
        };
        const javaRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
        const javaSize = { vcpus: 2, memoryMib: 2048, diskGib: 6 };
        await session.machine({ case: "machineCreate", value: { ref: javaRef, fence: fence10,
          spec: { source: { case: "base", value: true }, size: javaSize, build: true } } });
        await bootJava(javaRef, undefined); // no keystore yet: nothing checked
        await publicEgress(javaRef, "v10-java-egress");
        const fingerprint = createHash("sha256").update(caDer).digest("hex").toUpperCase().match(/../g)!.join(":");
        const fetchJava = "public class Fetch { public static void main(String[] a) throws Exception { var c = java.net.http.HttpClient.newHttpClient(); "
          + "System.out.println(c.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create(a[0])).build(), java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode()); } }";
        const listing = "sudo keytool -list -cacerts -storepass changeit 2>/dev/null";
        // The runner's CA in the keystore (1), and Java's HTTPS.
        const javaCheck = `${listing} | grep -c '${fingerprint}'; java app/Fetch.java https://example.com/; java app/Fetch.java https://services.gradle.org/versions/current`;
        const javaSetup = await sh10(workspace10(javaRef), "v10-java-setup", `set -e
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends default-jdk-headless >/dev/null
sudo apt-get clean
readlink /etc/ssl/certs/cube-runner.pem
mkdir -p app; printf '%s\\n' '${fetchJava}' > app/Fetch.java
${javaCheck}`, 1500000);
        assert.equal(javaSetup, "/usr/local/share/ca-certificates/cube-runner.crt\n1\n200\n200\n",
          "apt alone: the build machine's Java trusts the runner's CA (no update-ca-certificates, no hook)");
        const javaTemplate = await session.call({ case: "templatePublish", value: { from: javaRef, fence: fence10, key: "v10-java", meta: "" } }, 600000);
        assert.ok(javaTemplate.case === "template" && javaTemplate.value.state === Template_State.READY, show(javaTemplate));
        const javaUserRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
        const javaUser = workspace10(javaUserRef);
        await session.machine({ case: "machineCreate", value: { ref: javaUserRef, fence: fence10,
          spec: { source: { case: "templateId", value: javaRef.id }, size: javaSize } } });
        await bootJava(javaUserRef, "ok");
        await publicEgress(javaUserRef, "v10-java-user-egress");
        assert.equal(await sh10(javaUser, "v10-java-seen", javaCheck, 300000), "1\n200\n200\n",
          "a machine from the template: Java's keystore has the runner's CA and its HTTPS works");
        const entries = Number(await sh10(javaUser, "v10-java-entries", `${listing} | grep -c trustedCertEntry`));
        assert.ok(entries > 100, `Debian's public roots and the runner's CA: ${entries}`);
        const state = `${listing} | grep -c trustedCertEntry; ${listing} | grep -c '${fingerprint}' || true; sudo sha256sum /etc/ssl/certs/java/cacerts | cut -d' ' -f1`;
        const pkix = "java app/Fetch.java https://services.gradle.org/versions/current 2>&1 | grep -q 'PKIX path building failed' && echo pkix";

        // A keystore without the CA (as a template built before the link has it).
        const dropped = await sh10(javaUser, "v10-java-drop", `sudo keytool -delete -alias debian:cube-runner.pem -cacerts -storepass changeit >/dev/null; ${state}; ${pkix}`, 300000);
        assert.match(dropped, new RegExp(`^${entries - 1}\n0\n[0-9a-f]{64}\npkix\n$`), "without the CA Java's HTTPS fails");
        await stopVia(session, javaUserRef, epoch);
        await bootJava(javaUserRef, "repaired");
        const repaired = await sh10(javaUser, "v10-java-repaired", `cat /run/cube/runner-ca; ${state}; ${javaCheck}`, 300000);
        const [repairNote, repairedEntries, repairedCa, repairedSha, ...repairedRest] = repaired.trim().split("\n");
        assert.equal(repairNote, `repaired added the runner's CA to /etc/ssl/certs/java/cacerts; its ${entries - 1} other certificates kept`);
        assert.deepEqual([Number(repairedEntries), repairedCa, repairedRest], [entries, "1", ["1", "200", "200"]], "repaired at boot: the CA back, every root kept, Java's HTTPS works");
        await stopVia(session, javaUserRef, epoch);
        await bootJava(javaUserRef, "ok");
        assert.equal((await sh10(javaUser, "v10-java-again", state)).trim().split("\n")[2], repairedSha, "the next boot writes nothing");

        // A stale CA under cube's alias (as after a CA rotation).
        const stale = await sh10(javaUser, "v10-java-stale", `set -e
sudo rm -f /tmp/old.p12
sudo keytool -genkeypair -alias old -keyalg EC -dname CN=old-runner-ca -validity 2 -keystore /tmp/old.p12 -storetype PKCS12 -storepass changeit >/dev/null 2>&1
sudo keytool -exportcert -rfc -alias old -keystore /tmp/old.p12 -storepass changeit > /tmp/old.pem
sudo keytool -delete -alias debian:cube-runner.pem -cacerts -storepass changeit >/dev/null
sudo keytool -importcert -noprompt -alias debian:cube-runner.pem -file /tmp/old.pem -cacerts -storepass changeit >/dev/null 2>&1
${state}; ${pkix}`, 300000);
        assert.match(stale, new RegExp(`^${entries}\n0\n[0-9a-f]{64}\npkix\n$`), "a stale CA under cube's alias: Java's HTTPS fails");
        await stopVia(session, javaUserRef, epoch);
        await bootJava(javaUserRef, "repaired");
        const refreshed = await sh10(javaUser, "v10-java-refreshed", `cat /run/cube/runner-ca; ${state}; ${javaCheck}`, 300000);
        const [refreshNote, refreshedEntries, refreshedCa, , ...refreshedRest] = refreshed.trim().split("\n");
        assert.equal(refreshNote, `repaired added the runner's CA to /etc/ssl/certs/java/cacerts, in place of a stale one under its alias; its ${entries - 1} other certificates kept`);
        assert.deepEqual([Number(refreshedEntries), refreshedCa, refreshedRest], [entries, "1", ["1", "200", "200"]], "the stale CA replaced, every root kept");

        await stopVia(session, javaUserRef, epoch);
        await session.machine({ case: "machineDelete", value: { ref: javaUserRef, fence: fence10, retain: false } });
        await session.call({ case: "templateDelete", value: { id: javaRef.id } });
        note(`V10 Java: setup installed default-jdk-headless with apt only (keel's link /etc/ssl/certs/cube-runner.pem; the keystore holds runner CA ${fingerprint.slice(0, 23)}...); template_publish READY; a machine from it: runner-ca ok, java HttpClient https://example.com/ and https://services.gradle.org/versions/current 200; the CA taken out of the keystore: PKIX, repaired at the next boot (${entries} entries kept), the boot after unchanged; a stale CA under cube's alias: replaced at the next boot`);
      } else {
        note("V10 Java: NOT checked here: CUBE_TEST_BERTH_JAVA=1 (a real JDK from the image's apt) is unset");
      }
    } finally {
      store10.close();
      fs.rmSync(leases10, { recursive: true, force: true });
    }
  }
  const again = await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) }, boot: { documents, mac: "" } } });
  assert.notEqual(again.status?.bootId, firstBoot);
  assert.equal(fs.statSync(path.join(machineDir, "rw.qcow2")).ino, disk.ino, "the writable disk is kept");
  const second = await session.until(ref, machine => SESSION.test(machine.status?.guest?.session ?? "") && machine.status?.guest?.session !== firstSession, 180000);
  note(`stopped (QEMU ${pid} gone) and started again: boot ${again.status?.bootId}, session ${second.status!.guest!.session}`);

  // Ctrl-C: the runner quits its machines' QEMUs (they are in process groups
  // of their own, so the signal does not end them first) and marks them interrupted
  pid = record(ref.id).boot!.pid;
  await stop(runner.child, "SIGINT");
  await gone(pid);
  assert.equal(record(ref.id).interrupted?.reason, "runner_stopped");
  assert.doesNotMatch(fs.readFileSync(path.join(machineDir, "qemu.log"), "utf8"), /terminating on signal/,
    "the runner told QEMU to quit; the Ctrl-C did not reach it");
  runner = await start(["--listen", "127.0.0.1:0"]);
  assert.deepEqual(bannerMachines(runner.banner), { machines: 1, interrupted: 1, suspended: 0, atOnce: 8 },
    "after the Ctrl-C the one machine is interrupted, none suspended, berth's default bound");
  assert.match(runner.banner, /^image: .+ is in /m, "a restart finds the image in the directory");
  assert.doesNotMatch(runner.banner, /^layer \d+ .*: fetched /m, "and fetches nothing");
  writeConfig(runner.address, runner.peer);
  session = open();
  assert.equal((await session.hello()).runner?.caPem, caPem, "the runner's CA is kept across restarts");
  let after = await session.until(ref, machine => condition(machine, "Interrupted") !== undefined, 10000);
  assert.equal(after.status?.phase, MachineStatus_Phase.STOPPED);
  assert.equal(condition(after, "Interrupted")?.reason, "runner_stopped");
  assert.equal(after.fenceEpoch, BigInt(epoch), "the fence survives a restart");
  note(`runner stopped (SIGINT to its process group): QEMU ${pid} quit, machine ${MachineStatus_Phase[after.status!.phase]}, Interrupted/${condition(after, "Interrupted")?.reason}; CA kept`);

  // the runner crashes: its QEMU runs on; the next runner quits it and interrupts the machine
  const resumed = await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.equal(resumed.status?.phase, MachineStatus_Phase.RUNNING);
  assert.equal(condition(resumed, "Interrupted"), undefined, "a start clears the interruption");
  pid = record(ref.id).boot!.pid;
  await stop(runner.child, "SIGKILL");
  assert.ok(alive(pid), "QEMU outlives a runner killed outright (its own process group)");
  runner = await start(["--listen", "127.0.0.1:0"]);
  await gone(pid);
  writeConfig(runner.address, runner.peer);
  session = open();
  after = await session.until(ref, machine => condition(machine, "Interrupted")?.reason === "runner_restarted", 10000);
  assert.equal(after.status?.phase, MachineStatus_Phase.STOPPED);
  assert.match(condition(after, "Interrupted")!.message, /while the machine was running; its QEMU still ran and was told to quit/);
  note(`runner killed (SIGKILL): QEMU ${pid} outlived it, the next runner quit it: "${condition(after, "Interrupted")!.message}"`);

  // the machine type stays pinned: a record pinned to a type this QEMU lacks does not start
  await stop(runner.child);
  const file = path.join(machineDir, "machine.json");
  const saved = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, saved.replace(`"machineType": "${pinned}"`, `"machineType": "${pinned.replace(/\d+\.\d+$/, "99.9")}"`));
  runner = await start(["--listen", "127.0.0.1:0"]);
  writeConfig(runner.address, runner.peer);
  session = open();
  await assert.rejects(session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "machine_type");
  // and the image stays: a record built on another image does not start
  await stop(runner.child);
  fs.writeFileSync(file, saved.replace(/"manifest": "sha256:[0-9a-f]{64}"/, `"manifest": "sha256:${"e".repeat(64)}"`));
  runner = await start(["--listen", "127.0.0.1:0"]);
  writeConfig(runner.address, runner.peer);
  session = open();
  await assert.rejects(session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "FAILED_PRECONDITION" && error.reason === "image_changed");
  await stop(runner.child);
  fs.writeFileSync(file, saved);
  runner = await start(["--listen", "127.0.0.1:0"]);
  writeConfig(runner.address, runner.peer);
  session = open();
  assert.equal((await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } })).status?.phase, MachineStatus_Phase.RUNNING);
  note("refused: a machine pinned to a machine type its QEMU lacks (machine_type), one built on another image (image_changed)");

  // delete keeps the disk when asked; discard deletes it; the id is never reused
  pid = record(ref.id).boot!.pid;
  const retained = await session.machine({ case: "machineDelete", value: { ref, fence: { epoch: BigInt(epoch) }, retain: true } });
  assert.equal(retained.status?.phase, MachineStatus_Phase.RETAINED);
  await gone(pid);
  assert.equal(fs.statSync(path.join(machineDir, "rw.qcow2")).ino, disk.ino, "a retained machine keeps its writable disk");
  await assert.rejects(session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "retained");
  const discarded = await session.machine({ case: "machineDiscard", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.equal(discarded.status?.phase, MachineStatus_Phase.DELETED);
  assert.ok(!fs.existsSync(machineDir), "discard deletes the machine's directory");
  assert.equal((await session.machine({ case: "machineDiscard", value: { ref, fence: { epoch: BigInt(epoch) } } })).status?.phase, MachineStatus_Phase.DELETED, "discard again changes nothing");
  assert.equal((await session.machine({ case: "machineGet", value: { ref } })).status?.phase, MachineStatus_Phase.DELETED);
  await assert.rejects(session.call({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "deleted");
  note("retained (disk kept, start refused), discarded (directory gone, DELETED, id not reused)");

  // a machine deleted without retain and never interrupted goes at once
  const other = { owner: "thread-3", id: randomBytes(8).toString("hex") };
  await session.machine({ case: "machineCreate", value: { ref: other, fence: { epoch: 1n }, spec: { size } } });
  await session.machine({ case: "machineStart", value: { ref: other, fence: { epoch: 1n } } });
  pid = record(other.id).boot!.pid;
  const deleted = await session.machine({ case: "machineDelete", value: { ref: other, fence: { epoch: 1n }, retain: false } });
  assert.equal(deleted.status?.phase, MachineStatus_Phase.DELETED);
  await gone(pid);
  assert.ok(!fs.existsSync(path.join(directory, other.id)));
  const list = await session.call({ case: "machineList", value: {} });
  assert.ok(list.case === "machines" && list.value.items.length === 0);
  note("a second machine deleted without retain: QEMU quit, directory gone");

  // V10, the cache (B-8 D2): with no machine left, a template keeps the
  // layers of its image beyond a 0 GiB limit on another image, until it goes.
  if (guest.ready && otherImage) {
    const lruRef = { owner: "thread-1", id: randomBytes(8).toString("hex") };
    const lruFence = { epoch: 1n };
    await session.machine({ case: "machineCreate", value: { ref: lruRef, fence: lruFence, spec: { size: { vcpus: 2, memoryMib: 1024, diskGib: 2 }, build: true } } });
    await session.machine({ case: "machineStart", value: { ref: lruRef, fence: lruFence, boot: { documents, mac: "" } } });
    await session.until(lruRef, machine => !!machine.status?.guest?.ready, 180000);
    const lru = await session.call({ case: "templatePublish", value: { from: lruRef, fence: lruFence, key: "v10-lru", meta: "" } }, 600000);
    assert.ok(lru.case === "template" && lru.value.state === Template_State.READY, show(lru));
    await stop(runner.child);
    runner = await start(["--listen", "127.0.0.1:0", "--layer-cache-gib", "0"], imageB);
    writeConfig(runner.address, runner.peer);
    session = open();
    const digestB = imageB.split("@")[1]!;
    const layersB = (JSON.parse(fs.readFileSync(path.join(directory, "images", `${digestB}.json`), "utf8")) as { layers: Array<{ diffId: string }> }).layers.map(l => l.diffId);
    const onlyA = machineImage.diffIds.filter(d => !layersB.includes(d));
    const cached = (d: string) => fs.existsSync(path.join(directory, "layers", "1", `${d}.erofs`));
    assert.ok(onlyA.length > 0, "CUBE_TEST_BERTH_IMAGE_B shares every layer with CUBE_TEST_BERTH_IMAGE");
    assert.ok(onlyA.every(cached), `the template's image keeps its ${onlyA.length} layers beyond a 0 GiB limit`);
    const gone = await session.call({ case: "templateDelete", value: { id: lruRef.id } });
    assert.ok(gone.case === "template" && gone.value.users === 0, show(gone));
    assert.ok(onlyA.every(d => !cached(d)), "with the template gone, its image's layers are trimmed");
    assert.ok(layersB.every(cached), "the runner's image keeps its layers");
    assert.ok(!fs.existsSync(path.join(directory, "templates", `${lruRef.id}.erofs`)));
    note(`V10 cache: on ${imageB} with --layer-cache-gib 0 and no machine left, template ${lruRef.id} kept its image's ${onlyA.length} other layers; template_delete removed it and the cache trimmed them`);
  } else if (guest.ready) {
    note("V10 cache: NOT checked natively: CUBE_TEST_BERTH_IMAGE_B (another image pinned by digest) is unset");
  }
  passed = true;
  console.log(`ok: berth vm over protocol 4 (${accel}): floor, image, CA, hello, create, start, guest channel (session, setup, ${guest.ready ? "ready, Workspace contract, agent restart, network V5, credentials V6-V8, portal V9, templates V10" : "not ready: image lacks tools"}), guest streams, fencing, diagnosis (B-9), stop, restart and crash interrupt, pinned machine type and image, retained disk, discard, delete`);
} finally {
  await v9?.target.portal.close();
  await Promise.allSettled(sessions.map(session => session.close()));
  await stop(runner.child);
  // Any QEMU this test's machines left.
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  // CUBE_TEST_KEEP=1 keeps a failed run's root (berth's directory, logs, disks) for reading.
  if (!passed && env.CUBE_TEST_KEEP === "1") console.error(`kept for reading: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
