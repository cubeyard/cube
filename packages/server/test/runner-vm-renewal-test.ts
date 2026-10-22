/** #231's renewal on real keel machines (review f0234478 B2/B3), with the
 * real `berth vm`, QEMU and keel: no layer ever changes under a machine's
 * writable disk.
 *
 * A. This berth, a machine on an older official Debian (`--image`
 *    CUBE_TEST_BERTH_OLD_DEBIAN): it boots, is not ready (the image lacks
 *    keel's tools), and its `readiness.json` says never ready. berth again
 *    without `--image` (cube's default, prepared): the machine's next start
 *    gives it a new blank disk on the default image, its earlier disk kept
 *    under `kept/`, and it gets ready.
 * B. An earlier berth (CUBE_TEST_BERTH_LEGACY, the released v0.3.32
 *    binary), a machine on the pinned Debian digest and one on the older
 *    digest, neither ready, neither with a readiness record. This berth
 *    without `--image`: their layers are exactly their official Debian
 *    image's own, so they are provably never ready (the user's ruling P1);
 *    each gets a new blank disk on the default image and gets ready, its
 *    earlier disk kept with its bytes.
 * C. Negative control: an earlier berth's machine whose image's record in
 *    `images/` is gone is not provably never ready: not renewed (its
 *    events.log says why), refused as made on another image, its disk the
 *    same file with the same bytes.
 * D. Negative control: A's machine, once ready, keeps its disk (the same
 *    file) across a berth restart and a start; nothing is renewed.
 *
 * Needs CUBE_TEST_BERTH_QEMU, _QEMU_IMG, _KEEL, _MKFS, _OLD_DEBIAN
 * (docker.io/library/debian@sha256:… other than the pinned one) and, for B,
 * _LEGACY; without them it says SKIP, and CUBE_TEST_BERTH_VM=required makes
 * a skip a failure. Every directory is a new one under CUBE_TEST_BERTH_TMP
 * (default /tmp); nothing else is touched.
 * node packages/server/test/runner-vm-renewal-test.ts target/debug/berth */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { type Machine } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const mkfs = env.CUBE_TEST_BERTH_MKFS ?? "";
const old = env.CUBE_TEST_BERTH_OLD_DEBIAN ?? "";
const legacy = env.CUBE_TEST_BERTH_LEGACY ?? "";
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const plan = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../berth/debian/trixie.json"), "utf8")) as { image: string };
const pinned = `docker.io/library/debian@${plan.image.split("@")[1]}`;
const required = env.CUBE_TEST_BERTH_VM === "required";
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL"]),
  ...(path.isAbsolute(mkfs) && fs.existsSync(mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS"]),
  ...(/^docker\.io\/library\/debian(:[^@]+)?@sha256:[0-9a-f]{64}$/.test(old) && !old.endsWith(pinned.split("@")[1]!)
    ? [] : ["CUBE_TEST_BERTH_OLD_DEBIAN (official Debian, pinned, not the default's digest)"]),
  ...(required && !(path.isAbsolute(legacy) && fs.existsSync(legacy)) ? ["CUBE_TEST_BERTH_LEGACY (the released v0.3.32 berth)"] : []),
];
if (missing.length) {
  console.error(`\nSKIP: berth renewal on real machines did NOT run; missing: ${missing.join(", ")}`);
  process.exit(required ? 1 : 0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "crn-")));
const note = (line: string) => console.log(`runner-vm-renewal-test: ${line}`);
const STEP_MS = 300_000;
const children: ChildProcess[] = [];

/** One runner directory, its control key and node. */
function runnerDir(name: string) {
  const directory = path.join(root, name);
  const controlKey = path.join(root, `${name}.key`);
  const peer = (JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string }).peerId;
  const node = `node-renewal-${name}`;
  const configPath = path.join(root, `${name}.json`);
  return {
    directory,
    /** berth `bin` in it, with `image` (null: no --image) until its banner; a session to it. */
    async start(bin: string, image: string | null) {
      const args = ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs, "--accel", accel,
        ...(image ? ["--image", image] : []), "--allow-peer", peer, "--node-id", node, "--listen", "127.0.0.1:0"];
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
      children.push(child);
      let banner = "";
      child.stderr!.setEncoding("utf8");
      await new Promise<void>((resolve, reject) => {
        child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
        child.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
      });
      const field = (n: string) => banner.match(new RegExp(`^${n}: (.+)$`, "m"))?.[1]?.trim() ?? "";
      fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 1 }, controlKey,
        serverPeer: field("peer"), network: "loopback", address: field("listen").split(", ")[0] }), { mode: 0o600 });
      const session = new RunnerSession(loadSessionConfig(configPath).config);
      await session.hello();
      return { child, session, banner };
    },
    record: (id: string) => JSON.parse(fs.readFileSync(path.join(directory, id, "machine.json"), "utf8")) as { image: { reference: string; diffIds: string[] } },
    readiness: (id: string) => {
      const file = path.join(directory, id, "readiness.json");
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { everReady: boolean }).everReady : null;
    },
    events: (id: string) => fs.readFileSync(path.join(directory, id, "events.log"), "utf8"),
    kept: () => fs.existsSync(path.join(directory, "kept")) ? fs.readdirSync(path.join(directory, "kept")).sort() : [],
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGINT");
  await exited;
}
const size = { vcpus: 2, memoryMib: 1024, diskGib: 4 };
const fence = { epoch: 1n };
const boot = { documents: { hostname: Buffer.from("cube-renewal\n") }, mac: "" };
/** Starts the machine and waits for its agent's word: ready, or what the image lacks. */
async function settle(session: RunnerSession, ref: { owner: string; id: string }): Promise<NonNullable<Machine["status"]>["guest"]> {
  await session.machine({ case: "machineStart", value: { ref, fence, boot } });
  const settled = await session.until(ref, machine => {
    const guest = machine.status?.guest;
    return !!guest && guest.connected && (guest.ready || /lacks/.test(guest.reason) || /machine_setup failed/.test(guest.reason));
  }, STEP_MS);
  return settled.status!.guest;
}
async function stopMachine(session: RunnerSession, ref: { owner: string; id: string }) {
  const result = await session.call({ case: "machineStop", value: { ref, fence } }, 90_000);
  assert.equal(result.case, "machine");
}
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

try {
  // A. This berth: never ready on the older Debian, then renewed on the default.
  {
    const r = runnerDir("a");
    let run = await r.start(binary, old);
    const ref = { owner: "thread-a", id: randomBytes(8).toString("hex") };
    await run.session.machine({ case: "machineCreate", value: { ref, fence, spec: { source: { case: "base", value: true }, size } } });
    const first = await settle(run.session, ref);
    assert.ok(!first!.ready && /the image lacks/.test(first!.reason), `on ${old}: ${first!.reason}`);
    assert.equal(r.readiness(ref.id), false, "never ready, recorded from creation on");
    await stopMachine(run.session, ref);
    const before = sha(path.join(r.directory, ref.id, "rw.qcow2"));
    await run.session.close();
    await stop(run.child);
    note(`A: ${ref.id} on ${old}: not ready ("${first!.reason}"), readiness.json everReady=false`);

    run = await r.start(binary, null);
    assert.match(run.banner, /prepared for cube by layer sha256:[0-9a-f]{64}/, run.banner);
    const second = await settle(run.session, ref);
    assert.match(r.events(ref.id), /renewed: never ready on .*: a new blank disk on .*; the earlier disk is kept as /);
    assert.ok(second!.ready, `renewed, but not ready: ${second!.reason}`);
    assert.equal(r.readiness(ref.id), true, "ready, recorded");
    const kept = r.kept();
    const disk = kept.find(name => name.startsWith(ref.id) && name.endsWith(".rw.qcow2"));
    assert.ok(disk && kept.some(name => name.startsWith(ref.id) && name.endsWith(".json")), `kept: ${kept.join(", ")}`);
    assert.equal(sha(path.join(r.directory, "kept", disk)), before, "the earlier disk is kept as it was");
    assert.equal(r.record(ref.id).image.reference, pinned, "on the default image");
    await stopMachine(run.session, ref);
    // Started again: nothing more moves.
    const again = await settle(run.session, ref);
    assert.ok(again!.ready);
    assert.deepEqual(r.kept(), kept);
    await stopMachine(run.session, ref);
    await run.session.close();
    await stop(run.child);
    note(`A: renewed on the default image and ready; the earlier disk kept as kept/${disk} (sha256 unchanged); a second start changed nothing`);

    // D (negative control): that machine was ready; a berth restart and a
    // start leave its disk the same file, add nothing to kept/, renew nothing.
    const rw = path.join(r.directory, ref.id, "rw.qcow2");
    const inode = fs.statSync(rw).ino;
    const renewals = (r.events(ref.id).match(/ renewed: /g) ?? []).length;
    run = await r.start(binary, null);
    const third = await settle(run.session, ref);
    assert.ok(third!.ready);
    assert.equal(fs.statSync(rw).ino, inode, "an ever-ready machine keeps its disk");
    assert.deepEqual(r.kept(), kept);
    assert.equal((r.events(ref.id).match(/ renewed: /g) ?? []).length, renewals);
    assert.equal(r.readiness(ref.id), true);
    await stopMachine(run.session, ref);
    await run.session.close();
    await stop(run.child);
    note("D: the ever-ready machine kept its disk (same inode) across a berth restart and a start; nothing renewed");
  }

  // B. An earlier berth's machines: no readiness record, so left as they were.
  if (legacy && fs.existsSync(legacy)) {
    const r = runnerDir("b");
    const onPinned = { owner: "thread-b", id: randomBytes(8).toString("hex") };
    const onOld = { owner: "thread-b", id: randomBytes(8).toString("hex") };
    for (const [image, ref] of [[pinned, onPinned], [old, onOld]] as const) {
      const run = await r.start(legacy, image);
      await run.session.machine({ case: "machineCreate", value: { ref, fence, spec: { source: { case: "base", value: true }, size } } });
      const guest = await settle(run.session, ref);
      assert.ok(!guest!.ready && /the image lacks/.test(guest!.reason), `legacy on ${image}: ${guest!.reason}`);
      await stopMachine(run.session, ref);
      await run.session.close();
      await stop(run.child);
      assert.equal(r.readiness(ref.id), null, "an earlier berth keeps no readiness record");
    }
    const disks = Object.fromEntries([onPinned, onOld].map(ref => [ref.id, sha(path.join(r.directory, ref.id, "rw.qcow2"))]));
    const run = await r.start(binary, null);
    for (const ref of [onPinned, onOld]) {
      const guest = await settle(run.session, ref);
      assert.match(r.events(ref.id), /renewed: never ready on .*: a new blank disk on .*; the earlier disk is kept as /, `${ref.id}: ${r.events(ref.id)}`);
      assert.ok(guest!.ready, `${ref.id} renewed, but not ready: ${guest!.reason}`);
      assert.equal(r.readiness(ref.id), true, "tracked from its new disk on, and ready");
      const disk = r.kept().find(name => name.startsWith(ref.id) && name.endsWith(".rw.qcow2"));
      assert.ok(disk, `${ref.id}: kept ${r.kept().join(", ")}`);
      assert.equal(sha(path.join(r.directory, "kept", disk)), disks[ref.id], `${ref.id}: its earlier disk keeps its bytes`);
      assert.equal(r.record(ref.id).image.reference, pinned);
      await stopMachine(run.session, ref);
    }
    await run.session.close();
    await stop(run.child);
    note(`B: an earlier berth's never-ready machines on ${pinned} and ${old}: each renewed on the default image and ready; both earlier disks kept unchanged`);

    // C (negative control): an earlier berth's machine berth cannot prove
    // never ready (its image's record in images/ is gone): left as it was.
    const c = runnerDir("c");
    const ambiguous = { owner: "thread-c", id: randomBytes(8).toString("hex") };
    {
      const legacyRun = await c.start(legacy, old);
      await legacyRun.session.machine({ case: "machineCreate", value: { ref: ambiguous, fence, spec: { source: { case: "base", value: true }, size } } });
      const guest = await settle(legacyRun.session, ambiguous);
      assert.ok(!guest!.ready);
      await stopMachine(legacyRun.session, ambiguous);
      await legacyRun.session.close();
      await stop(legacyRun.child);
    }
    const oldRecord = path.join(c.directory, "images", `${old.split("@")[1]}.json`);
    assert.ok(fs.existsSync(oldRecord), oldRecord);
    fs.rmSync(oldRecord);
    const cDisk = path.join(c.directory, ambiguous.id, "rw.qcow2");
    const cBefore = { sha: sha(cDisk), ino: fs.statSync(cDisk).ino };
    const cRun = await c.start(binary, null);
    await assert.rejects(cRun.session.call({ case: "machineStart", value: { ref: ambiguous, fence, boot } }),
      (error: unknown) => error instanceof RunnerError && error.reason === "image_changed");
    assert.match(c.events(ambiguous.id), /not renewed: a machine on official Debian whose layers are not exactly that image's own/);
    assert.deepEqual({ sha: sha(cDisk), ino: fs.statSync(cDisk).ino }, cBefore, "its disk is the same file with the same bytes");
    assert.deepEqual(c.kept(), []);
    await cRun.session.close();
    await stop(cRun.child);
    note("C: an earlier berth's machine without its image's record: not renewed (event says why), refused as image_changed, disk unchanged");
  } else {
    note("B: NOT checked: CUBE_TEST_BERTH_LEGACY (the released v0.3.32 berth) is unset");
  }
  console.log(`ok: berth renewal on real machines (${accel}): a never-ready official-Debian machine gets a new disk on the default image and gets ready, its earlier disk kept${legacy ? "; so do an earlier berth's never-ready machines on the pinned and an older digest; an ambiguous one is left" : ""}; an ever-ready one is left`);
} finally {
  for (const child of children) await stop(child).catch(() => {});
  if (env.CUBE_TEST_KEEP === "1") console.log(`kept ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
