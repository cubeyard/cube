/** S-7a's functional gate (G-F) against the real `berth vm`: one machine
 * under QEMU with keel's agent, suspended while a command runs and resumed.
 *
 *   1. work: a file of random bytes and its sha256; a command of about 60 s
 *      that appends a counter to a file once a second;
 *   2. suspend (`machine_suspend`, the runner started with
 *      --suspend-disk-margin-gib): SUSPENDED with `MachineStatus.suspended`,
 *      the same boot id, no QEMU process left, its memory file on disk, a
 *      guest call UNAVAILABLE/suspended;
 *   3. resume (`machine_start`): RUNNING with the same boot id, the agent's
 *      `hello` in a new session and ready again; the time from the start's
 *      answer to ready is printed;
 *   4. the command goes on to exit 0 with every count from 1 to 60, the
 *      file's sha256 is unchanged, and a new write reads back;
 *   5. the cold control: suspended again with a command running, the
 *      runner stopped, the snapshot's key in the journal changed as another
 *      berth would have written it, the runner started: `machine_start`
 *      boots cold with SnapshotDropped/version, a new boot id, the memory
 *      file gone, the command's result not found as finished.
 *
 *   node packages/server/test/runner-vm-suspend-test.ts target/debug/berth
 *
 * The environment is runner-vm-test.ts's: CUBE_TEST_BERTH_QEMU,
 * CUBE_TEST_BERTH_QEMU_IMG, CUBE_TEST_BERTH_KEEL, CUBE_TEST_BERTH_IMAGE (an
 * image keel calls ready), CUBE_TEST_BERTH_MKFS, CUBE_TEST_BERTH_ACCEL,
 * CUBE_TEST_BERTH_PULLED and CUBE_TEST_BERTH_TMP; without them it is
 * skipped with a notice, and CUBE_TEST_BERTH_VM=required makes that a
 * failure. CUBE_TEST_SUSPEND_MEMORY_MIB is the guest's memory (1024).
 * Loopback only; nothing outside its temporary directory. Under TCG the
 * times say nothing; only KVM and HVF runs are the gate. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { EgressPolicy_Default, MachineStatus_Phase, type Machine } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { settleOperation, type Workspace } from "../src/workspace.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const began = Date.now();
const note = (line: string) => console.log(`runner-vm-suspend-test [${((Date.now() - began) / 1000).toFixed(1)}s]: ${line}`);

const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const image = env.CUBE_TEST_BERTH_IMAGE ?? "";
const mkfs = env.CUBE_TEST_BERTH_MKFS ?? "";
const pulled = env.CUBE_TEST_BERTH_PULLED ?? "";
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const memoryMib = Number(env.CUBE_TEST_SUSPEND_MEMORY_MIB ?? 1024);
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(image) ? [] : ["CUBE_TEST_BERTH_IMAGE=<registry/repository@sha256:digest>"]),
  ...(path.isAbsolute(mkfs) && fs.existsSync(mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS=<absolute mkfs.erofs path>"]),
];
if (missing.length) {
  console.error(`\nSKIP: suspend and resume on berth vm (S-7a, G-F) did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "csus-")));
const directory = path.join(root, "m");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const node = "node-vm-suspend";
const show = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--accel", accel, "--image", image, "--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0",
    "--suspend-disk-margin-gib", "1"],
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
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGINT");
  await exited;
}
/** QEMU processes of this test's machine. */
function qemus(id: string): string {
  try { return execFileSync("pgrep", ["-f", path.join(directory, id)], { encoding: "utf8" }).trim(); } catch { return ""; }
}

async function shell(workspace: Workspace, key: string, command: string, timeoutMs = 120000): Promise<string> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.exec(lease.token, key, { command, timeoutMs });
    const done = await settleOperation(workspace, lease.token, key);
    assert.ok(done.state === "succeeded" && done.exitCode === 0, `${key}: ${JSON.stringify(done)}`);
    return Buffer.from(done.output).toString("utf8").trim();
  } finally { await workspace.release(lease.token).catch(() => {}); }
}
async function begin(workspace: Workspace, key: string, command: string, timeoutMs: number): Promise<void> {
  const lease = await workspace.lease({ owner: "pi" });
  try { await workspace.exec(lease.token, key, { command, timeoutMs }); } finally { await workspace.release(lease.token).catch(() => {}); }
}
async function outcome(workspace: Workspace, key: string) {
  const lease = await workspace.lease({ owner: "pi" });
  try { return await settleOperation(workspace, lease.token, key); } finally { await workspace.release(lease.token).catch(() => {}); }
}

if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
let runner = await start();
note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|machines|suspend):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
const writeConfig = () => fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 1 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });
writeConfig();
const leases = fs.mkdtempSync(path.join(os.tmpdir(), "runner-vm-suspend-"));
const store = new LeaseStore(leases);
const ref = { owner: "thread-suspend", id: randomBytes(8).toString("hex") };
const epoch = Date.now();
const fence = { epoch: BigInt(epoch) };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
let session = new RunnerSession(loadSessionConfig(configPath).config, { log: quiet });
const workspace = () => new VmWorkspace({ guest: session.guest(ref, () => epoch), leases: store, owner: "pi", binding: `runner-vm-suspend:${process.pid}`, retryMs: 2000 });
const policy = { default: EgressPolicy_Default.DENY, denyHosts: [], rules: [], lease: { seconds: 900n, nanos: 0 } };
const startCall = { case: "machineStart" as const, value: { ref, fence, boot: { documents: { hostname: Buffer.from("cube-suspend\n") }, mac: "" }, policy } };
const ready = (bootId?: string) => session.until(ref, m => !!m.status?.guest?.connected && !!m.status.guest.ready
  && (!bootId || m.status.bootId === bootId), 300000);
let failed = false;
const suspend = async (): Promise<Machine> => {
  const result = await session.call({ case: "machineSuspend", value: { ref, fence } }, 90000);
  assert.equal(result.case, "machine", show(result));
  return result.value as Machine;
};
try {
  const hello = await session.hello();
  assert.ok(hello.capabilities.includes("machine.suspend"), `capabilities: ${hello.capabilities.join(", ")}`);
  await session.machine({ case: "machineCreate", value: { ref, fence, spec: { source: { case: "base", value: true }, size: { vcpus: 2, memoryMib, diskGib: 4 } } } });
  const started = await session.machine(startCall);
  const boot = started.status!.bootId;
  await ready(boot);
  note(`machine ${ref.id} ready on boot ${boot} (${memoryMib} MiB)`);

  // 1. work
  let ws = workspace();
  const sha = await shell(ws, "s-data", "head -c 16777216 /dev/urandom > /workspace/data && sync && sha256sum /workspace/data | cut -d' ' -f1");
  await begin(ws, "s-count", "rm -f /workspace/count; for i in $(seq 1 60); do echo $i >> /workspace/count; sleep 1; done; echo finished", 600000);
  await delay(5000);

  // 2. suspend
  const t0 = Date.now();
  const suspended = await suspend();
  const saveMs = Date.now() - t0;
  assert.equal(suspended.status?.phase, MachineStatus_Phase.SUSPENDED, show(suspended.status));
  assert.equal(suspended.status?.bootId, boot);
  const memoryBytes = Number(suspended.status?.suspended?.memoryBytes ?? 0n);
  assert.ok(memoryBytes > 0, show(suspended.status));
  const memoryFile = path.join(directory, ref.id, "memory");
  const apparent = fs.statSync(memoryFile).size;
  for (let i = 0; qemus(ref.id) && i < 100; i++) await delay(100);
  assert.equal(qemus(ref.id), "", "no QEMU runs for the suspended machine");
  const refused = await ws.lease({ owner: "pi" }).then(async lease => {
    try { return await ws.exec(lease.token, "s-refused", { command: "true", timeoutMs: 10000 }).then(() => "ran", (error: unknown) => error); }
    finally { await ws.release(lease.token).catch(() => {}); }
  }, (error: unknown) => error);
  assert.ok(String(refused instanceof Error ? refused.message : refused).includes("suspended"), `a guest call to a suspended machine: ${String(refused)}`);
  note(`2. suspended in ${saveMs} ms: memory file ${(memoryBytes / 2 ** 20).toFixed(1)} MiB allocated, ${(apparent / 2 ** 20).toFixed(1)} MiB apparent; no QEMU left; a guest call refused (${refused instanceof Error ? refused.message : String(refused)})`);
  await delay(5000);

  // 3. resume
  const t1 = Date.now();
  const resumed = await session.call(startCall, 120000);
  assert.equal(resumed.case, "machine");
  const answerMs = Date.now() - t1;
  const back = resumed.value as Machine;
  assert.equal(back.status?.phase, MachineStatus_Phase.RUNNING, show(back.status));
  assert.equal(back.status?.bootId, boot, "a resume is not a boot");
  assert.ok(!back.status?.conditions.some(c => c.type === "SnapshotDropped"), show(back.status?.conditions));
  const readyAgain = await ready(boot);
  const readyMs = Date.now() - t1;
  assert.ok(!fs.existsSync(memoryFile), "the memory file is deleted after the resume");
  note(`3. resumed: the start answered in ${answerMs} ms, ready again ${readyMs} ms after it was sent; same boot ${boot}, session ${readyAgain.status?.guest?.session}`);

  // 4. the command goes on, the data is intact
  ws = workspace();
  const counted = await outcome(ws, "s-count");
  assert.ok(counted.state === "succeeded" && counted.exitCode === 0, `the command over the suspend: ${show(counted)}`);
  assert.equal(Buffer.from(counted.output).toString("utf8").trim(), "finished");
  const counts = (await shell(ws, "s-read-count", "cat /workspace/count")).split("\n").map(Number);
  assert.deepEqual(counts, Array.from({ length: 60 }, (_, i) => i + 1), "every count once, in order");
  assert.equal(await shell(ws, "s-sha", "sha256sum /workspace/data | cut -d' ' -f1"), sha, "the file is unchanged");
  assert.equal(await shell(ws, "s-write", "echo after > /workspace/after && sync && cat /workspace/after"), "after");
  note("4. the command over the suspend exited 0 with counts 1..60; the data's sha256 is unchanged; a new write reads back");

  // 5. the cold control: another berth's snapshot boots cold
  await begin(ws, "s-cold", "sleep 300; echo never", 600000);
  await delay(2000);
  const again = await suspend();
  assert.equal(again.status?.phase, MachineStatus_Phase.SUSPENDED);
  session.close();
  await stop(runner.child);
  const journalPath = path.join(directory, ref.id, "machine.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { snapshot: { key: { berth: string } } };
  journal.snapshot.key.berth = "0.0.0-other";
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  runner = await start();
  writeConfig();
  session = new RunnerSession(loadSessionConfig(configPath).config, { log: quiet });
  const cold = await session.call(startCall, 120000);
  assert.equal(cold.case, "machine");
  const coldMachine = cold.value as Machine;
  const dropped = coldMachine.status?.conditions.find(c => c.type === "SnapshotDropped");
  assert.equal(dropped?.reason, "version", show(coldMachine.status?.conditions));
  assert.notEqual(coldMachine.status?.bootId, boot, "a cold boot");
  assert.ok(!fs.existsSync(memoryFile), "the dropped snapshot's file is gone");
  await ready(coldMachine.status!.bootId);
  ws = workspace();
  const lost = await outcome(ws, "s-cold");
  assert.ok(!(lost.state === "succeeded" && lost.exitCode === 0), `the command of the dropped snapshot did not finish: ${show(lost)}`);
  note(`5. cold control: SnapshotDropped/${dropped?.reason} ("${dropped?.message}"), new boot ${coldMachine.status?.bootId}, the memory file gone, the old command ${lost.state}`);

  await session.machine({ case: "machineDelete", value: { ref, fence, retain: false } });
  console.log(`ok: berth vm suspend and resume (${accel}): a command over the suspend finished, data intact, same boot id; save ${saveMs} ms, `
    + `memory file ${(memoryBytes / 2 ** 20).toFixed(1)} MiB of ${memoryMib} MiB; resume answered ${answerMs} ms, ready ${readyMs} ms; cold control SnapshotDropped/version`);
} catch (error) {
  failed = true;
  if (error instanceof RunnerError) console.error(`runner: ${error.code}/${error.reason}: ${error.message}`);
  throw error;
} finally {
  session.close();
  await stop(runner.child);
  for (let i = 0; qemus("") && i < 50; i++) await delay(100);
  assert.equal(qemus(""), "", "no process of the runner's directory is left");
  // A failed run keeps the machine's directory (events.log, qemu.log, console) to read.
  if (failed) console.error(`kept for reading: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(leases, { recursive: true, force: true });
}
