/** Runner protocol 4 against the real `berth vm` (masterplan B-1): the
 * session part of runner-host-test.ts (hello, a wrong node, create, watch,
 * fencing, UNIMPLEMENTED, a runner restart, delete) with keel machines under
 * QEMU, plus what only a VM runner has: keel's QEMU floor, a pinned machine
 * type, a read-only layer disk, a retained writable disk, and machines a
 * runner restart interrupts. Loopback only.
 *
 *   node packages/server/test/runner-vm-test.ts target/debug/berth
 *
 * Always: berth vm refuses to start without QEMU given by path, and with
 * CUBE_TEST_BERTH_OLD_QEMU (a QEMU below the floor, such as Ubuntu 24.04's
 * 8.2.2) it refuses that QEMU and writes nothing. The machines need
 * CUBE_TEST_BERTH_QEMU and CUBE_TEST_BERTH_QEMU_IMG (absolute paths to a
 * QEMU that meets the floor and its qemu-img), CUBE_TEST_BERTH_KEEL (a keel
 * build's out/<arch>, with vmlinuz and base.erofs) and an accelerator
 * (CUBE_TEST_BERTH_ACCEL, default kvm on Linux and hvf on macOS); without
 * them that part is skipped with a notice, and CUBE_TEST_BERTH_VM=required
 * turns the skip into a failure. It works in /tmp/cvm-* unless
 * CUBE_TEST_BERTH_TMP names another (short) directory. Mocks are not runner
 * acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { MachineStatus_Phase, Runner_Kind, type Machine } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { GuestTransportError } from "../src/guest-ssh.ts";

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
    "--allow-peer", control.peerId, "--node-id", node, "--accel", "tcg"]);
  assert.match(said, /is below keel's QEMU floor; missing: .*virtio-rtc-pci/, said);
  assert.ok(!fs.existsSync(directory), "a QEMU below the floor is refused before the runner writes anything");
  note(`refused below the floor: ${said.trim().split("\n")[0]}`);
}

const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
];
if (missing.length) {
  console.error(`\nSKIP: berth vm with keel machines did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  fs.rmSync(root, { recursive: true, force: true });
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------- the runner

async function start(args: string[]): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--accel", accel, ...args],
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
  { machineType: string; phase: string; boot?: { pid: number; bootId: string; qemu: string }; interrupted?: { reason: string } };
const condition = (machine: Machine, type: string) => machine.status?.conditions.find(c => c.type === type);
async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!alive(pid), `QEMU ${pid} still runs`);
}

/** One QMP command on the machine's socket (berth holds no connection between verbs). */
async function qmp(id: string, command: string): Promise<unknown> {
  const socket = net.connect(path.join(directory, id, "qmp.sock"));
  socket.setEncoding("utf8");
  let buffer = "";
  const lines: unknown[] = [];
  const next = async () => {
    for (;;) {
      const line = buffer.indexOf("\n");
      if (line >= 0) { const message = JSON.parse(buffer.slice(0, line)); buffer = buffer.slice(line + 1); if (!("event" in message)) return message; continue; }
      const [chunk] = await once(socket, "data") as [string];
      buffer += chunk;
    }
  };
  try {
    lines.push(await next());
    socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
    await next();
    socket.write(`${JSON.stringify({ execute: command })}\n`);
    const answer = await next() as { return?: unknown; error?: unknown };
    assert.ok(answer.return !== undefined, `${command}: ${JSON.stringify(answer)}`);
    return answer.return;
  } finally { socket.destroy(); }
}

/** keel's cube-agent, booted from base.erofs by cube-init, says `hello` on
 * cube.0 (runner.proto's guest channel). Only this test reads it: the
 * channel is masterplan B-2's. */
async function agentHello(id: string, timeoutMs: number): Promise<{ hello: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const socket = net.connect(path.join(directory, id, "ctl.sock"));
      await once(socket, "connect");
      try {
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(new Error("no hello")), Math.max(1000, deadline - Date.now()));
        for await (const chunk of socket) {
          bytes = Buffer.concat([bytes, chunk as Buffer]);
          if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32BE(0)) break;
        }
        clearTimeout(timer);
        const frame = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString("utf8")) as { ch?: number; hello?: Record<string, unknown> };
        assert.ok(frame.hello, `not a hello: ${JSON.stringify(frame)}`);
        return { hello: frame.hello };
      } finally { socket.destroy(); }
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

let runner = await start(["--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0", "--labels", "site=test"]);
const sessions: RunnerSession[] = [];
try {
  assert.match(runner.banner, /^qemu: \d+\.\d+\.\d+ .+ \(meets keel's floor; new machines get (pc-q35|virt)-\d+\.\d+\)$/m);
  assert.doesNotMatch(runner.banner, /UNSANDBOXED/);
  note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel):/.test(line)).join(" | "));
  const configPath = path.join(root, "runner.json");
  const writeConfig = (address: string, peer: string) => fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4,
    binding: { nodeId: node, threadId: node, environmentId: 1 }, controlKey, serverPeer: peer, network: "loopback", address }), { mode: 0o600 });
  writeConfig(runner.address, runner.peer);
  const open = () => { const session = new RunnerSession(loadSessionConfig(configPath).config); sessions.push(session); return session; };
  let session = open();

  // hello: a VM runner, its QEMU by version and path, no guest streams yet
  const hello = await session.hello();
  assert.equal(hello.protocol, 4);
  assert.equal(hello.runner?.kind, Runner_Kind.VM);
  assert.equal(hello.runner?.nodeId, node);
  assert.equal(hello.runner?.platform?.accelerator, accel);
  assert.equal(hello.runner?.platform?.qemuVersion.split(" ")[1], qemu, "Platform.qemu_version is version and path (A17)");
  assert.match(hello.runner?.platform?.baseImageSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(hello.runner?.labels, { site: "test" });
  assert.ok(hello.capabilities.includes("machine.discard") && hello.capabilities.includes("watch") && !hello.capabilities.includes("guest"));

  // a wrong node id is refused at hello
  const wrongPath = path.join(root, "wrong.json");
  fs.writeFileSync(wrongPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: "node-other", threadId: "x", environmentId: 1 },
    controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });
  const wrong = new RunnerSession(loadSessionConfig(wrongPath).config);
  sessions.push(wrong);
  await assert.rejects(wrong.hello(), (error: unknown) => error instanceof RunnerError && error.code === "PERMISSION_DENIED" && error.reason === "wrong_node");

  // create: stopped, a writable disk and an empty layer disk, the machine type pinned
  const ref = { owner: "thread-1", id: randomBytes(8).toString("hex") };
  let epoch = Date.now();
  const size = { vcpus: 1, memoryMib: 768, diskGib: 4 };
  const created = await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) }, spec: { source: { case: "base", value: true }, size } } });
  assert.equal(created.status?.phase, MachineStatus_Phase.STOPPED);
  const machineDir = path.join(directory, ref.id);
  const disk = fs.statSync(path.join(machineDir, "rw.qcow2"));
  assert.ok(fs.statSync(path.join(machineDir, "layers.vmdk")).isFile());
  const pinned = record(ref.id).machineType;
  assert.equal(pinned, runner.banner.match(/new machines get (\S+)\)/)![1]);
  assert.equal((await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) } } })).ref?.id, ref.id, "create again changes nothing");
  assert.equal(fs.statSync(path.join(machineDir, "rw.qcow2")).ino, disk.ino);
  await assert.rejects(session.call({ case: "machineCreate", value: { ref: { owner: "thread-2", id: ref.id }, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "ALREADY_EXISTS");
  note(`created ${ref.id}: stopped, machine type ${pinned}`);

  // start: QEMU runs keel; the watch says running with a boot id
  const started = await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.equal(started.status?.phase, MachineStatus_Phase.RUNNING);
  const firstBoot = started.status!.bootId;
  assert.match(firstBoot, /^[0-9a-f]{32}$/);
  const watched = await session.until(ref, machine => machine.status?.phase === MachineStatus_Phase.RUNNING && machine.status.bootId === firstBoot, 10000);
  assert.equal(watched.status?.guest, undefined, "no guest status before the channel (B-2)");
  const argv = JSON.parse(fs.readFileSync(path.join(machineDir, "argv.json"), "utf8")) as { qemu: string; args: string[] };
  assert.equal(argv.qemu, qemu);
  assert.ok(argv.args.includes(`${pinned},accel=${accel}`));
  const blocks = await qmp(ref.id, "query-block") as Array<{ inserted?: { ro: boolean; file: string } }>;
  const ro = Object.fromEntries(blocks.filter(b => b.inserted).map(b => [path.basename(b.inserted!.file), b.inserted!.ro]));
  assert.deepEqual(ro, { "base.erofs": true, "layers.vmdk": true, "rw.qcow2": false }, "vda and vdb read-only, vdc writable");
  const { hello: agent } = await agentHello(ref.id, 120000);
  assert.equal(agent.ready ?? false, false, "not ready before machine_setup (B-2)");
  note(`started: boot ${firstBoot}, QEMU pid ${record(ref.id).boot!.pid}; disks ${JSON.stringify(ro)}; cube-agent hello on cube.0: build ${String(agent.build).slice(0, 12)}…, reason "${String(agent.reason)}"`);

  // what a VM runner does not do yet, and fencing
  await assert.rejects(session.guest(ref, () => epoch).call("hello", {}), (error: unknown) => error instanceof GuestTransportError && /guest channel/.test(error.message));
  const unsupported: Array<Parameters<RunnerSession["call"]>[0]> = [{ case: "templateList", value: {} }, { case: "machineDiagnose", value: { ref } }];
  for (const verb of unsupported) {
    await assert.rejects(session.call(verb), (error: unknown) => error instanceof RunnerError && error.code === "UNIMPLEMENTED" && error.reason === "vm_runner", verb.case);
  }
  epoch += 10;
  await session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  await assert.rejects(session.call({ case: "machineStop", value: { ref, fence: { epoch: BigInt(epoch - 5) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "stale_epoch");
  await assert.rejects(session.call({ case: "machineDiscard", value: { ref, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.reason === "not_retained");

  // stop quits QEMU; a start boots again on the same writable disk
  let pid = record(ref.id).boot!.pid;
  const stopped = await session.machine({ case: "machineStop", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.equal(stopped.status?.phase, MachineStatus_Phase.STOPPED);
  assert.equal(stopped.status?.bootId, "");
  await gone(pid);
  assert.equal(condition(stopped, "Interrupted"), undefined, "a stop cubed asked for is no interruption");
  const again = await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  assert.notEqual(again.status?.bootId, firstBoot);
  assert.equal(fs.statSync(path.join(machineDir, "rw.qcow2")).ino, disk.ino, "the writable disk is kept");
  note(`stopped (QEMU ${pid} gone) and started again: boot ${again.status?.bootId}`);

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
  let after = await session.until(ref, machine => condition(machine, "Interrupted") !== undefined, 10000);
  assert.equal(after.status?.phase, MachineStatus_Phase.STOPPED);
  assert.equal(condition(after, "Interrupted")?.reason, "runner_stopped");
  assert.equal(after.fenceEpoch, BigInt(epoch), "the fence survives a restart");
  note(`runner stopped (SIGINT to its process group): QEMU ${pid} quit, machine ${MachineStatus_Phase[after.status!.phase]}, Interrupted/${condition(after, "Interrupted")?.reason}`);

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
  await stop(runner.child);
  fs.writeFileSync(file, saved);
  runner = await start(["--listen", "127.0.0.1:0"]);
  writeConfig(runner.address, runner.peer);
  session = open();
  assert.equal((await session.machine({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } })).status?.phase, MachineStatus_Phase.RUNNING);
  note("a machine pinned to a machine type its QEMU lacks is refused (FAILED_PRECONDITION machine_type)");

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
  console.log(`ok: berth vm over protocol 4 (${accel}): floor, hello, create, start, read-only layer disk, cube-agent hello, fencing, UNIMPLEMENTED, stop, restart and crash interrupt, pinned machine type, retained disk, discard, delete`);
} finally {
  await Promise.allSettled(sessions.map(session => session.close()));
  await stop(runner.child);
  // Any QEMU this test's machines left.
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
