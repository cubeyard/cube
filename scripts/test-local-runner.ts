/** `cubed runners init-local` with the real cube-runner: keygen, init with
 * the fake QEMU (no accelerator needed), the config cubed reads, and the
 * attempt to start the runner for enrollment. With a usable /dev/kvm the
 * runner starts and the enrollment is recorded; otherwise the command must
 * leave the setup in place and say what to run once the runner is up. The
 * fake-runner orchestration is in packages/server/test/runner-enroll-test.ts.
 * node scripts/test-local-runner.ts target/debug/cube-runner */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Registry } from "../packages/server/src/registry.ts";

const [runner] = process.argv.slice(2);
if (!runner || !fs.existsSync(runner)) throw new Error("usage: node scripts/test-local-runner.ts /path/to/cube-runner");
const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-local-real-"));
try {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const support = path.join(repo, "packages/node-transport/tests/support");
  fs.copyFileSync(path.join(support, "fake-qemu.py"), path.join(bin, "qemu-system-fake"));
  fs.copyFileSync(path.join(support, "fake-qemu-img.sh"), path.join(bin, "qemu-img"));
  fs.chmodSync(path.join(bin, "qemu-system-fake"), 0o755);
  fs.chmodSync(path.join(bin, "qemu-img"), 0o755);
  fs.writeFileSync(path.join(bin, "firmware.fd"), "fake firmware");
  const image = path.join(root, "debian.qcow2");
  const header = Buffer.alloc(4096);
  header.write("QFI\xfb", 0, "binary");
  header.writeUInt32BE(3, 4);
  header.writeBigUInt64BE(3n << 30n, 24);
  fs.writeFileSync(image, header);
  const home = path.join(root, "cube");
  const state = path.join(root, "state");
  const kvm = (() => { try { fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK); return process.platform === "linux"; } catch { return false; } })();
  const result = spawnSync(process.execPath, [path.join(repo, "packages/server/src/index.ts"), "runners", "init-local", "--state", state,
    "--image", image, "--home", home, "--listen", "127.0.0.1:47811", "--node-id", "node-local-test", "--qemu", path.join(bin, "qemu-system-fake"),
    "--firmware", path.join(bin, "firmware.fd"), "--max-vcpus", "2", "--max-memory-mib", "4096"],
  { encoding: "utf8", env: { ...process.env, CUBE_RUNNER: path.resolve(runner), CUBED_CLAUDE: "off" }, timeout: 120_000 });
  const output = result.stdout + result.stderr;
  assert.ok(fs.existsSync(path.join(home, "control.key")), output);
  assert.ok(fs.existsSync(path.join(home, "runner/runner.key")), output);
  assert.ok(fs.existsSync(path.join(home, "runner/state/journal.db")), output);
  const direct = JSON.parse(fs.readFileSync(path.join(home, "runner/runner.json"), "utf8"));
  assert.equal(direct.network, "loopback");
  assert.equal(direct.listen, "127.0.0.1:47811");
  const config = JSON.parse(fs.readFileSync(path.join(home, "runner.json"), "utf8"));
  assert.equal(config.version, 2);
  assert.deepEqual(config.binding, { nodeId: "node-local-test", threadId: "node-local-test", environmentId: 1 });
  assert.equal(config.network, "loopback");
  assert.equal(config.address, "127.0.0.1:47811");
  assert.match(config.serverPeer, /^[0-9a-f]{64}$/);
  assert.equal(config.controlKey, path.join(home, "control.key"));
  assert.match(result.stdout, new RegExp(`qemu:\\s+${path.join(bin, "qemu-system-fake")}`), "the given QEMU path is recorded, not resolved");
  assert.match(result.stdout, /image:\s+sha256 [0-9a-f]{64}/);
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    if (kvm) {
      assert.equal(result.status, 0, output);
      assert.match(result.stdout, /enrolled in .*: cube-runner \d+\.\d+\.\d+, linux-x86_64, up to \d+ thread machine/);
      assert.equal(registry.listRunners().length, 1);
      assert.equal(registry.listRunners()[0].nodeId, "node-local-test");
      console.log("ok: init-local with the real cube-runner (KVM): initialized, started, enrolled, stopped");
    } else {
      assert.equal(result.status, 1, output);
      assert.match(result.stderr, /set up but not enrolled: the runner exited \(1\): .*(kvm|Hypervisor)/i);
      assert.match(result.stderr, new RegExp(`cubed runners enroll --config ${path.join(home, "runner.json")} --state ${state}`));
      assert.equal(registry.listRunners().length, 0);
      console.log("ok: init-local with the real cube-runner (no accelerator here): initialized and configured; enrollment deferred with the command to run");
    }
  } finally { registry.close(); }
  // The second attempt into the same home changes nothing.
  const again = spawnSync(process.execPath, [path.join(repo, "packages/server/src/index.ts"), "runners", "init-local", "--state", state,
    "--image", image, "--home", home, "--listen", "127.0.0.1:47811"], { encoding: "utf8", env: { ...process.env, CUBE_RUNNER: path.resolve(runner), CUBED_CLAUDE: "off" } });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /never rebound/);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
