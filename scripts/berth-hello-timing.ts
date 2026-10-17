/** Hello and ready time of a keel machine under `berth vm`, over N stops
 * and starts of one machine (masterplan §6.6 targets 1 and 2): from
 * `machine_start` to the agent's `hello` (a new session in `status.guest`),
 * and from the same start to that session's first `ready` (its
 * `machine_setup` applied). A session that says it will not become ready
 * fails the run with its reason. Masterplan B-4 asks for hello with and
 * without the network: run it with this head's berth (virtio-net, `ip=` on
 * the kernel command line) and with the berth of the base commit (no network
 * device); the script itself does not depend on either.
 *
 *   node scripts/berth-hello-timing.ts <berth> [runs=10]
 *
 * Needs CUBE_TEST_BERTH_{QEMU,QEMU_IMG,KEEL,IMAGE} and
 * CUBE_TEST_BERTH_PULLED (a berth directory the image was pulled into, as
 * runner-vm-test.ts takes it), CUBE_TEST_BERTH_ACCEL (kvm or hvf) and
 * optionally CUBE_TEST_BERTH_TMP; CUBE_TEST_BERTH_MKFS for a berth from B-7
 * on, which requires --mkfs-erofs (it finds the image there and pulls
 * nothing). Prints one JSON line. Loopback only; the
 * machine and its directory are removed at the end. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { RunnerSession, loadSessionConfig } from "../packages/server/src/runner-session.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const runs = Number(process.argv[3] ?? 10);
const env = process.env;
const [qemu, qemuImg, keel, image, pulled] = ["QEMU", "QEMU_IMG", "KEEL", "IMAGE", "PULLED"].map(k => env[`CUBE_TEST_BERTH_${k}`] ?? "");
assert.ok(qemu && qemuImg && keel && image && pulled, "CUBE_TEST_BERTH_{QEMU,QEMU_IMG,KEEL,IMAGE,PULLED} are needed");
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cht-")));
const directory = path.join(root, "m");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });

let child: ChildProcess | undefined;
let session: RunnerSession | undefined;
try {
  const mkfs = env.CUBE_TEST_BERTH_MKFS ? ["--mkfs-erofs", env.CUBE_TEST_BERTH_MKFS] : [];
  child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, ...mkfs, "--accel", accel, "--image", image,
    "--allow-peer", control.peerId, "--node-id", "node-hello-timing", "--listen", "127.0.0.1:0"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child!.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child!.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  const configPath = path.join(root, "runner.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: "node-hello-timing", threadId: "t", environmentId: 1 },
    controlKey, serverPeer: field("peer"), network: "loopback", address: field("listen").split(", ")[0] }), { mode: 0o600 });
  session = new RunnerSession(loadSessionConfig(configPath).config);
  const ref = { owner: "timing", id: randomBytes(8).toString("hex") };
  const fence = { epoch: 1n };
  await session.machine({ case: "machineCreate", value: { ref, fence, spec: { source: { case: "base", value: true }, size: { vcpus: 2, memoryMib: 1024, diskGib: 4 } } } });
  const samples: number[] = [];
  const readyMs: number[] = [];
  const helloToReadyMs: number[] = [];
  // What keel's agent says while its setup is still coming or being applied;
  // any other reason with ready false (the image lacks…, machine_setup
  // failed…) means this session will not become ready.
  const pending = new Set(["waiting for machine_setup", "applying machine_setup"]);
  let previous = "";
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await session.machine({ case: "machineStart", value: { ref, fence } });
    const up = await session.until(ref, m => !!m.status?.guest?.session && m.status.guest.session !== previous, 180000);
    const hello = Math.round(performance.now() - t0);
    samples.push(hello);
    previous = up.status!.guest!.session;
    const settled = await session.until(ref, m => {
      const info = m.status?.guest;
      return info?.session === previous && (info.ready || (!!info.reason && !pending.has(info.reason)));
    }, 180000);
    const guest = settled.status!.guest!;
    if (!guest.ready) throw new Error(`session ${previous} will not become ready: "${guest.reason}"`);
    // Hello and ready in one status: no time between them.
    const ready = up.status!.guest!.ready ? hello : Math.round(performance.now() - t0);
    readyMs.push(ready);
    helloToReadyMs.push(ready - hello);
    await session.call({ case: "machineStop", value: { ref, fence } }, 70000);
  }
  const quantiles = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]!;
    return { median: at(0.5), p25: at(0.25), p75: at(0.75), min: sorted[0], max: sorted.at(-1) };
  };
  const ready = quantiles(readyMs);
  const network = fs.readFileSync(path.join(directory, ref.id, "argv.json"), "utf8").includes("virtio-net-pci");
  console.log(JSON.stringify({ berth: binary, accel, network, runs, ms: samples, ...quantiles(samples), readyMs, helloToReadyMs,
    readyMedian: ready.median, readyP25: ready.p25, readyP75: ready.p75, readyMin: ready.min, readyMax: ready.max }));
} finally {
  await session?.close();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); process.kill(-child.pid!, "SIGINT"); await exited; }
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
