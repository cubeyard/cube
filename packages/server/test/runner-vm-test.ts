/** Runner protocol 4 against the real `berth vm` (masterplan B-1 and B-2):
 * the session part of runner-host-test.ts (hello, a wrong node, create,
 * watch, fencing, UNIMPLEMENTED, a runner restart, delete) with keel machines
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
 * (3 s here) running out with an open flow closed and cubed's return, and
 * the runner's report stream read as cubed would read it, with
 * `dropped_before` after its queue overflowed.
 *
 *   node packages/server/test/runner-vm-test.ts target/debug/berth
 *
 * Always: berth vm refuses to start without QEMU given by path, and with
 * CUBE_TEST_BERTH_OLD_QEMU (a QEMU below the floor, such as Ubuntu 24.04's
 * 8.2.2) it refuses that QEMU and writes nothing. The machines need
 * CUBE_TEST_BERTH_QEMU and CUBE_TEST_BERTH_QEMU_IMG (absolute paths to a
 * QEMU that meets the floor and its qemu-img), CUBE_TEST_BERTH_KEEL (a keel
 * build's out/<arch>, with vmlinuz and base.erofs), CUBE_TEST_BERTH_IMAGE (a
 * public image pinned by digest, which the test pulls with `berth image
 * pull`) and CUBE_TEST_BERTH_MKFS (an absolute mkfs.erofs), and an
 * accelerator (CUBE_TEST_BERTH_ACCEL, default kvm on Linux and hvf on
 * macOS); without them that part is skipped with a notice, and
 * CUBE_TEST_BERTH_VM=required turns the skip into a failure.
 * CUBE_TEST_BERTH_PULLED names a berth directory the image was pulled into
 * before: its images/ and layers/ are copied instead of pulling again.
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
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fromJsonString } from "@bufbuild/protobuf";
import { Endpoint, EndpointAddr, EndpointId, SecretKey } from "@number0/iroh/index.js";
import { EgressPolicy_Default, EgressReportSchema, MachineStatus_Phase, OpenSchema, Runner_Kind, type EgressReport, type Machine } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { GuestTransportError } from "../src/guest-ssh.ts";
import { resumeWorkspace } from "../src/vm.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { settleOperation, type Workspace } from "../src/workspace.ts";
import { workspaceContract, workspaceServicesContract } from "./workspace-contract.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
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
assert.ok(!fs.existsSync(directory), "a refused start writes nothing");
note("refused: no --qemu, a relative --qemu, a missing --qemu");
if (env.CUBE_TEST_BERTH_OLD_QEMU) {
  const old = env.CUBE_TEST_BERTH_OLD_QEMU;
  // The floor is read before anything else is used, so any file stands for qemu-img.
  const said = refused(["--dir", directory, "--qemu", old, "--qemu-img", process.execPath, "--keel", missingKeel,
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
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(image) ? [] : ["CUBE_TEST_BERTH_IMAGE=<registry/repository@sha256:digest>"]),
  ...(pulled || (path.isAbsolute(mkfs) && fs.existsSync(mkfs)) ? [] : ["CUBE_TEST_BERTH_MKFS=<absolute mkfs.erofs path> (or CUBE_TEST_BERTH_PULLED)"]),
];
if (missing.length) {
  console.error(`\nSKIP: berth vm with keel machines did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  fs.rmSync(root, { recursive: true, force: true });
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------- the runner

const vmArgs = (extra: string[] = []) => ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--accel", accel, "--image", image, ...extra];
async function start(args: string[]): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, vmArgs(args),
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
  { machineType: string; phase: string; boot?: { pid: number; bootId: string; qemu: string }; interrupted?: { reason: string };
    image?: { reference: string; manifest: string; diffIds: string[] }; stopped?: { kind: string; message: string } };
const condition = (machine: Machine, type: string) => machine.status?.conditions.find(c => c.type === type);
async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!alive(pid), `QEMU ${pid} still runs`);
}
const events = (id: string) => fs.readFileSync(path.join(directory, id, "events.log"), "utf8");

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
async function shell(workspace: Workspace, key: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.exec(lease.token, key, { command, timeoutMs: 30000 });
    const done = await settleOperation(workspace, lease.token, key);
    assert.equal(done.state, "succeeded", JSON.stringify(done));
    return { exitCode: done.state === "succeeded" ? done.exitCode : null, output: done.state === "succeeded" ? Buffer.from(done.output).toString("utf8") : "" };
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

const refusedBy = (code: string, reason: string) => (error: unknown) =>
  error instanceof GuestTransportError && error.cause instanceof RunnerError && error.cause.code === code && error.cause.reason === reason;
const SESSION = /^[0-9a-f]{32}$/;
const show = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
/** A stop waits up to 30 s for the agent's shutdown, then QEMU may take 20 s. */
const STOP_MS = 70000;
async function stopVia(session: RunnerSession, ref: { owner: string; id: string }, epoch: number): Promise<Machine> {
  const result = await session.call({ case: "machineStop", value: { ref, fence: { epoch: BigInt(epoch) } } }, STOP_MS);
  assert.equal(result.case, "machine");
  return result.value as Machine;
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

// The image, as the runner reads it: pulled into its directory first.
const firstArgs = ["--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0", "--labels", "site=test"];
assert.match(refused(vmArgs(firstArgs).slice(1)), /pull it first: berth image pull/);
note("refused: an image not pulled into the runner's directory");
if (pulled) {
  for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
  note(`image copied from ${pulled}`);
} else {
  const pull = spawnSync(binary, ["image", "pull", "--dir", directory, "--mkfs-erofs", mkfs, "--image", image], { encoding: "utf8", timeout: 900000 });
  assert.equal(pull.status, 0, `berth image pull: ${pull.stderr}`);
  note(`pulled ${image}: ${pull.stderr.trim().split("\n").filter(line => /layer|index/.test(line)).join(" | ")}`);
}

const documents = {
  hostname: Buffer.from("cube-vm-test\n"),
  env: Buffer.from("GH_TOKEN=cube_ph_github_vmtest\n"),
  "hooks/pre-resume": Buffer.from("#!/bin/bash\necho \"pre-resume as $(id -un) in $(pwd) token=$GH_TOKEN\"\n"),
};

// The refused start bound the directory to this control peer and node already.
let runner = await start(["--listen", "127.0.0.1:0"]);
const sessions: RunnerSession[] = [];
try {
  assert.match(runner.banner, /^qemu: \d+\.\d+\.\d+ .+ \(meets keel's floor; new machines get (pc-q35|virt)-\d+\.\d+\)$/m);
  assert.match(runner.banner, /^image: .+ \(linux\/(amd64|arm64), \d+ layers, manifest sha256:[0-9a-f]{64}\)$/m);
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
  assert.ok(hello.capabilities.includes("machine.discard") && hello.capabilities.includes("watch") && hello.capabilities.includes("guest"));
  assert.equal(hello.runner?.caPem, caPem, "Runner.ca_pem is the runner's CA certificate");
  assert.doesNotMatch(hello.runner?.caPem ?? "", /PRIVATE KEY/);

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
  const unsupported: Array<Parameters<RunnerSession["call"]>[0]> = [{ case: "templateList", value: {} }, { case: "machineDiagnose", value: { ref } }];
  for (const verb of unsupported) {
    await assert.rejects(session.call(verb), (error: unknown) => error instanceof RunnerError && error.code === "UNIMPLEMENTED" && error.reason === "vm_runner", verb.case);
  }

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
      assert.match(facts.output, /^cube-vm-test\ncube_ph_github_vmtest\n1\n/, "the boot documents and the runner's CA reached the machine");
      note("Workspace contract (leases, files, commands, services, hooks) over RunnerGuestTransport: ok; hostname, placeholder and runner CA from machine_setup");

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
      assert.equal(await deniedBy("v5-credential", "-H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/"), "credentials are not available on this runner yet");
      assert.equal(await deniedBy("v5-placeholder", "-H \"Authorization: Bearer $GH_TOKEN\" https://example.com/"), "a secret placeholder is only sent where a credential rule allows it");
      await startWith({ default: EgressPolicy_Default.DENY, denyHosts: [], rules: [{ hosts: ["example.com"], ports: [443], kind: open443 }], lease: { seconds: 3n, nanos: 0 } });
      assert.equal(await code("v5-deny-allowed", "https://example.com/"), "200");
      assert.equal(await deniedBy("v5-deny-other", "https://example.org/"), "host is not allowed by the egress policy");
      assert.equal(await deniedBy("v5-deny-http", "http://example.com/"), "host is not allowed by the egress policy");
      note("V5 4: deny_hosts, credential_unavailable, placeholder and DENY by default refused; a new start replaced the policy of the running machine");

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

      // 5. the lease: 3 s after cubed's last connection goes, new flows are
      // refused and open ones closed; the next connection ends the grace.
      // The guest runs on its own meanwhile: probes every 250 ms, a flow held
      // open from the start, and (once the lease is over) 300 connections,
      // more refusals than the runner's queue of 256 holds.
      await startWith(policyA);
      const leaseHolder = await egressWorkspace.lease({ owner: "pi" });
      const script = [
        "rm -f /tmp/lease.log /tmp/held.log",
        "( exec 3<>/dev/tcp/203.0.113.1/80; cat <&3 >/dev/null; date +%s%3N > /tmp/held.log ) &",
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
      const backWorkspace = new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-test-egress-2:${process.pid}`, retryMs: 2000 });
      const backLease = await backWorkspace.lease({ owner: "pi" });
      const settled = await settleOperation(backWorkspace, backLease.token, "v5-lease");
      await backWorkspace.release(backLease.token);
      assert.equal(settled.state, "succeeded", JSON.stringify(settled));
      const log = (await shell(backWorkspace, "v5-lease-log", "cat /tmp/lease.log; echo held $(cat /tmp/held.log); echo flood $(cat /tmp/flood.log)")).output.trim().split("\n");
      const flood = Number(log.pop()!.split(" ")[1]);
      const held = Number(log.pop()!.split(" ")[1]);
      const probes = log.map(line => line.split(" ")).map(([at, status]) => ({ at: Number(at), status }));
      const leaseMs = 3000;
      const within = probes.filter(p => p.at < lost + leaseMs - 500);
      const expired = probes.filter(p => p.at > lost + leaseMs + 1500 && p.at < returned - 500);
      const again = probes.filter(p => p.at > returned + 2500);
      assert.ok(within.length >= 4 && within.every(p => p.status === "200"), `within the lease: ${show(within)}`);
      assert.ok(expired.length >= 4 && expired.every(p => p.status !== "200"), `after it: ${show(expired)}`);
      assert.ok(again.length >= 2 && again.every(p => p.status === "200"), `after cubed came returned: ${show(again)}`);
      assert.ok(held - lost >= leaseMs - 300 && held - lost < leaseMs + 2000, `the held flow closed ${held - lost} ms after cubed went (lease ${leaseMs} ms)`);
      assert.ok(flood > lost + leaseMs && flood < returned, `the 300 connections ran while the lease was over (${flood - lost} ms after cubed went, returned at ${returned - lost})`);
      note(`V5 5: lease 3 s: ${within.length} probes 200 within it, ${expired.length} refused after it, ${again.length} 200 after cubed came returned; the held flow closed ${held - lost} ms after cubed went`);

      // 6b. what was refused while cubed was gone, then the count of what the full queue dropped
      const queued = await reader.take(256, 30000);
      assert.ok(queued.every(r => r.reason === "lease_expired" && /^203\.0\.113\.1:80$|^[0-9.]+:(80|443)$/.test(r.host)), show(queued.slice(0, 3)));
      assert.equal(await deniedBy("v5-after-flood", "https://example.net/"), "host is denied by the egress policy");
      const [next] = await reader.take(1, 20000);
      assert.equal(next!.reason, "deny_host");
      assert.ok(next!.droppedBefore > 0n, `dropped_before ${next!.droppedBefore}`);
      note(`V5 6b: 256 lease_expired reports kept while cubed was gone; the next report says dropped_before=${next!.droppedBefore}`);
      reader.discard();
      await reader.close();
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
  const stopped = await stopVia(session, ref, epoch);
  assert.equal(stopped.status?.phase, MachineStatus_Phase.STOPPED);
  assert.equal(stopped.status?.bootId, "");
  assert.equal(stopped.status?.guest, undefined, "no guest status without QEMU");
  await gone(pid);
  assert.equal(condition(stopped, "Interrupted"), undefined, "a stop cubed asked for is no interruption");
  assert.equal(condition(stopped, "Stopped")?.reason, "controlled", show(stopped.status?.conditions));
  await assert.rejects(transport.call("hello", {}), refusedBy("UNAVAILABLE", "not_running"));
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
  assert.match(runner.banner, /^machines: 1 \(1 interrupted; /m);
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
  console.log(`ok: berth vm over protocol 4 (${accel}): floor, image, CA, hello, create, start, guest channel (session, setup, ${guest.ready ? "ready, Workspace contract, agent restart, network V5" : "not ready: image lacks tools"}), guest streams, fencing, UNIMPLEMENTED, stop, restart and crash interrupt, pinned machine type and image, retained disk, discard, delete`);
} finally {
  await Promise.allSettled(sessions.map(session => session.close()));
  await stop(runner.child);
  // Any QEMU this test's machines left.
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
