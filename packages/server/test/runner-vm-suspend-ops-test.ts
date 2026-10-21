/** #208's bound on `machine_suspend`'s wait for the runner's `ops` (B-207-3)
 * against the real `berth vm`: two machines, one of which holds `ops` for
 * berth's whole SHUTDOWN_WAIT (30 s: a forced `machine_stop` of a paused
 * guest, as runner-vm-cubed-test.ts makes one).
 *
 *   1. machine_suspend of the other machine meanwhile is refused
 *      FAILED_PRECONDITION/busy after OPS_WAIT (5 s), well before the stop
 *      ends; the machine keeps running;
 *   2. it never runs later: once the stop has ended, the machine is still
 *      RUNNING and berth's events.log has no suspend for it;
 *   3. the pair: the same suspend with `ops` free saves it (SUSPENDED).
 *
 * A berth from before #208 waits for `ops` without a bound: it suspends
 * the machine after the stop, so step 1 fails ("answered in …"). That is the
 * control.
 *
 *   node packages/server/test/runner-vm-suspend-ops-test.ts target/debug/berth
 *
 * The environment is runner-vm-suspend-test.ts's (CUBE_TEST_BERTH_QEMU,
 * _QEMU_IMG, _KEEL, _IMAGE, _MKFS, _ACCEL, _PULLED, _TMP, and
 * CUBE_TEST_SUSPEND_MEMORY_MIB for both guests, 1024); skipped without it, a
 * failure with CUBE_TEST_BERTH_VM=required. Loopback only; nothing outside
 * its temporary directory, kept when the run fails. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { EgressPolicy_Default, MachineStatus_Phase } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const began = Date.now();
const note = (line: string) => console.log(`runner-vm-suspend-ops-test [${((Date.now() - began) / 1000).toFixed(1)}s]: ${line}`);

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
  console.error(`\nSKIP: machine_suspend's bounded wait for ops on berth vm (#208) did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "csop-")));
const directory = path.join(root, "m");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const node = "node-vm-suspend-ops";
const show = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
const child: ChildProcess = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
  "--accel", accel, "--image", image, "--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0",
  "--max-machines", "2", "--suspend-disk-margin-gib", "1"],
{ stdio: ["ignore", "ignore", "pipe"], detached: true });
let banner = "";
child.stderr!.setEncoding("utf8");
const log = fs.createWriteStream(path.join(root, "berth.log"), { flags: "a" });
child.stderr!.on("data", chunk => log.write(chunk));
await new Promise<void>((resolve, reject) => {
  child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
  child.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
});
const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
note(banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|machines|suspend):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 1 },
  controlKey, serverPeer: field("peer"), network: "loopback", address: field("listen").split(", ")[0] }), { mode: 0o600 });
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
const session = new RunnerSession(loadSessionConfig(configPath).config, { log: quiet });
const policy = { default: EgressPolicy_Default.DENY, denyHosts: [], rules: [], lease: { seconds: 900n, nanos: 0 } };
const epoch = Date.now();
const fence = { epoch: BigInt(epoch) };
const machine = (name: string) => ({ owner: `thread-${name}`, id: randomBytes(8).toString("hex") });
const holder = machine("holder");
const idle = machine("idle");
const events = (id: string) => { try { return fs.readFileSync(path.join(directory, id, "events.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const suspendEvents = (id: string) => events(id).filter(line => / suspend(ed| failed)?: /.test(line));
/** One QMP command on a machine's socket (berth holds no connection between verbs). */
async function qmp(socketPath: string, command: string): Promise<void> {
  const socket = net.connect(socketPath);
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
    const answer = await next() as { return?: unknown };
    assert.ok(answer.return !== undefined, `${command}: ${JSON.stringify(answer)}`);
  } finally { socket.destroy(); }
}

let failed = false;
try {
  const hello = await session.hello();
  assert.ok(hello.capabilities.includes("machine.suspend"), `capabilities: ${hello.capabilities.join(", ")}`);
  for (const ref of [holder, idle]) {
    await session.machine({ case: "machineCreate", value: { ref, fence, spec: { source: { case: "base", value: true }, size: { vcpus: 2, memoryMib, diskGib: 4 } } } });
    const started = await session.machine({ case: "machineStart", value: { ref, fence, boot: { documents: { hostname: Buffer.from(`cube-${ref.owner}\n`) }, mac: "" }, policy } });
    await session.until(ref, m => !!m.status?.guest?.connected && !!m.status.guest.ready && m.status.bootId === started.status!.bootId, 300000);
  }
  note(`machines ${holder.id} (holds ops) and ${idle.id} (to suspend) ready, ${memoryMib} MiB each`);

  // The holder's guest is paused: its stop waits berth's whole SHUTDOWN_WAIT under `ops`.
  await qmp(path.join(directory, holder.id, "qmp.sock"), "stop");
  const stopping = Date.now();
  const stopped = session.call({ case: "machineStop", value: { ref: holder, fence } }, 120000);
  await delay(1000);

  // 1. refused busy after OPS_WAIT, long before the stop ends
  const asked = Date.now();
  const refused = await session.call({ case: "machineSuspend", value: { ref: idle, fence } }, 90000).then(result => result, (error: unknown) => error);
  const answerMs = Date.now() - asked;
  assert.ok(refused instanceof RunnerError, `machine_suspend while ops was held answered ${answerMs} ms after it was sent: ${show(refused)}`);
  assert.deepEqual([refused.code, refused.reason], ["FAILED_PRECONDITION", "busy"], refused.message);
  assert.match(refused.message, /another operation held the runner for 5 s; the machine keeps running/);
  assert.ok(answerMs >= 4500 && answerMs < 10000, `answered in ${answerMs} ms (OPS_WAIT 5 s)`);
  const during = await session.machine({ case: "machineGet", value: { ref: idle } });
  assert.equal(during.status?.phase, MachineStatus_Phase.RUNNING, show(during.status));
  note(`1. machine_suspend while another stop held ops: ${refused.code}/${refused.reason} in ${answerMs} ms ("${refused.message}"); the machine runs`);

  // 2. never later
  const stop = await stopped;
  const stopMs = Date.now() - stopping;
  assert.ok(stop.case === "machine", show(stop));
  assert.equal(stop.value.status?.phase, MachineStatus_Phase.STOPPED, show(stop.value.status));
  assert.ok(stopMs >= 25000, `the holder's stop held ops for ${stopMs} ms (SHUTDOWN_WAIT 30 s)`);
  await delay(5000);
  const after = await session.machine({ case: "machineGet", value: { ref: idle } });
  assert.equal(after.status?.phase, MachineStatus_Phase.RUNNING, show(after.status));
  assert.deepEqual(suspendEvents(idle.id), [], "berth never ran the refused suspend");
  note(`2. the holder's stop ended after ${(stopMs / 1000).toFixed(1)} s; 5 s later the other machine still runs and berth never saved it`);

  // 3. the pair: with ops free it is suspended
  const t0 = Date.now();
  const saved = await session.call({ case: "machineSuspend", value: { ref: idle, fence } }, 90000);
  assert.ok(saved.case === "machine", show(saved));
  assert.equal(saved.value.status?.phase, MachineStatus_Phase.SUSPENDED, show(saved.value.status));
  note(`3. with ops free: SUSPENDED in ${Date.now() - t0} ms; berth: ${suspendEvents(idle.id).join(" | ")}`);

  for (const ref of [holder, idle]) await session.machine({ case: "machineDelete", value: { ref, fence, retain: false } });
  console.log(`ok: berth vm (${accel}) refuses machine_suspend busy after ${answerMs} ms while another operation holds the runner, never runs it later, and suspends with the runner free`);
} catch (error) {
  failed = true;
  if (error instanceof RunnerError) console.error(`runner: ${error.code}/${error.reason}: ${error.message}`);
  throw error;
} finally {
  session.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    process.kill(-child.pid!, "SIGINT");
    await exited;
  }
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  if (failed) console.error(`kept for reading: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
