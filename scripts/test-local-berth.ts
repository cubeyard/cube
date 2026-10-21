/** `cubed runners init-local` with the real `berth vm`: berth's own first
 * run binds its directory to the control key init-local made, pulls the
 * image, prints its peer and waits for cubed; the admission is recorded and
 * berth is stopped. A second run, as after `brew uninstall` and `brew
 * install`, changes nothing and starts nothing. Needs what runner-vm-test.ts
 * needs (CUBE_TEST_BERTH_QEMU, _QEMU_IMG, _KEEL, _IMAGE, _MKFS and an
 * accelerator berth accepts: KVM on Linux, HVF on macOS); without it the
 * test is skipped with a notice, and CUBE_TEST_BERTH_VM=required turns the
 * skip into a failure. The fake-berth orchestration and every refusal are in
 * packages/server/test/runner-enroll-test.ts.
 * node scripts/test-local-berth.ts target/debug/berth */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Registry } from "../packages/server/src/registry.ts";

const [binary] = process.argv.slice(2);
if (!binary || !fs.existsSync(binary)) throw new Error("usage: node scripts/test-local-berth.ts /path/to/berth");
const env = process.env;
const given = { qemu: env.CUBE_TEST_BERTH_QEMU ?? "", qemuImg: env.CUBE_TEST_BERTH_QEMU_IMG ?? "", keel: env.CUBE_TEST_BERTH_KEEL ?? "",
  image: env.CUBE_TEST_BERTH_IMAGE ?? "", mkfs: env.CUBE_TEST_BERTH_MKFS ?? "" };
const missing = [
  ...(path.isAbsolute(given.qemu) && fs.existsSync(given.qemu) ? [] : ["CUBE_TEST_BERTH_QEMU"]),
  ...(path.isAbsolute(given.qemuImg) && fs.existsSync(given.qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG"]),
  ...(fs.existsSync(path.join(given.keel, "vmlinuz")) && fs.existsSync(path.join(given.keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(given.image) ? [] : ["CUBE_TEST_BERTH_IMAGE"]),
  ...(path.isAbsolute(given.mkfs) && fs.existsSync(given.mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS"]),
];
if (missing.length) {
  console.error(`\nSKIP: init-local with the real berth vm did NOT run; missing: ${missing.join(", ")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// A short root: berth keeps <dir>/<machine id>/qmp.sock within 100 bytes.
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "clb-")));
try {
  const home = path.join(root, "cube");
  const state = path.join(root, "state");
  const cubed = () => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../packages/server/src/index.ts"), "runners", "init-local",
    "--state", state, "--home", home, "--image", given.image, "--listen", "127.0.0.1:47812", "--node-id", "node-berth-test"],
  { encoding: "utf8", timeout: 30 * 60_000, env: { ...env, CUBE_BERTH: path.resolve(binary), CUBE_BERTH_QEMU: given.qemu, CUBE_BERTH_QEMU_IMG: given.qemuImg,
    CUBE_BERTH_KEEL: given.keel, CUBE_BERTH_MKFS_EROFS: given.mkfs, CUBED_CLAUDE: "off" } });
  const first = cubed();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /enrolled in .*: berth \d+\.\d+\.\d+, \S+, up to \d+ thread machines?/);
  const config = JSON.parse(fs.readFileSync(path.join(home, "berth.json"), "utf8"));
  const bound = JSON.parse(fs.readFileSync(path.join(home, "berth", ".berth", "vm.json"), "utf8"));
  assert.equal(bound.nodeId, "node-berth-test");
  assert.equal(bound.network, "loopback");
  assert.equal(config.address, "127.0.0.1:47812");
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    const runner = registry.getRunner("node-berth-test");
    assert.equal(runner?.protocol, 4);
    assert.equal(runner?.kind, "vm");
  } finally { registry.close(); }
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const kept = ["berth.json", "berth.env", "berth.control.key", "berth/.berth/vm.json", "berth/.berth/runner.key"].map(file => [file, digest(path.join(home, file))]);
  const again = cubed();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /already set up and enrolled in .*; nothing changed/);
  assert.doesNotMatch(again.stdout, /starting berth vm/);
  for (const [file, sum] of kept) assert.equal(digest(path.join(home, file!)), sum, `${file} is unchanged`);
  console.log(`ok: init-local with the real berth vm: enrolled ${config.serverPeer.slice(0, 12)}…, then a second run changed nothing`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
