import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-host-production-"));
const stage = path.join(root, "stage");
const restored = path.join(root, "restored");
const bin = (version: string, name = `host-${version}`) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = version ] || exit 1\nprintf '%s\\n' '{"softwareVersion":"${version}","protocolVersion":1,"minimumProtocolVersion":1}'\n`, { mode: 0o755 });
  return file;
};
const run = (script: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", [path.join(repo, "scripts/host", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, CUBE_HOST_ROOT: stage, CUBE_HOST_USER: os.userInfo().username, ...extra },
  });
  if (result.status !== 0) throw new Error(`${script}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

try {
  const v1 = bin("1.0.0");
  run("install.sh", [v1]);
  assert.equal(fs.readlinkSync(path.join(stage, "opt/cube-host/current")), path.join(stage, "opt/cube-host/releases/1.0.0"));
  assert.equal(mode(path.join(stage, "var/lib/cube-host")), 0o700);
  assert.equal(mode(path.join(stage, "var/lib/cube-host/identity")), 0o700);
  assert.equal(mode(path.join(stage, "etc/systemd/system/cube-host.service")), 0o644);
  const unit = fs.readFileSync(path.join(stage, "etc/systemd/system/cube-host.service"), "utf8");
  assert.match(unit, /User=cube-host/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /--network relay/);
  assert.match(unit, /--stop-policy \$\{CUBE_HOST_STOP_POLICY\}/);
  assert.doesNotMatch(unit, /RestrictSUIDSGID=yes/,
    "systemd's RestrictSUIDSGID seccomp must not block the required openat2 cwd boundary");

  fs.mkdirSync(path.join(stage, "var/lib/cube-host/state"));
  fs.writeFileSync(path.join(stage, "var/lib/cube-host/state/journal.db"), "durable-journal", { mode: 0o600 });
  fs.writeFileSync(path.join(stage, "var/lib/cube-host/identity/node.key"), "private-key", { mode: 0o600 });
  fs.writeFileSync(path.join(stage, "var/lib/cube-host/workspace/result"), "side-effect");
  const backup = path.join(root, "host.tar.gz");
  run("backup.sh", ["host", backup]);
  assert.equal(mode(backup), 0o600);
  assert.equal(mode(`${backup}.sha256`), 0o600);
  run("restore.sh", ["host", backup], { CUBE_HOST_ROOT: restored });
  assert.equal(fs.readFileSync(path.join(restored, "var/lib/cube-host/workspace/result"), "utf8"), "side-effect");
  assert.equal(mode(path.join(restored, "var/lib/cube-host/state/restore-quarantine")), 0o600);
  run("acknowledge-recovery.sh", ["--i-reviewed-unknown-operations"], { CUBE_HOST_ROOT: restored });
  assert.equal(fs.existsSync(path.join(restored, "var/lib/cube-host/state/restore-quarantine")), false);

  fs.mkdirSync(path.join(stage, "control/config"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, "control/cubed.db"), "control-registry");
  fs.writeFileSync(path.join(stage, "control/config/node.json"), "private-admission");
  const controlBackup = path.join(root, "control.tar.gz");
  const controlEnv = { CUBE_CONTROL_DB: "/control/cubed.db", CUBE_CONTROL_CONFIG: "/control/config" };
  run("backup.sh", ["control", controlBackup], controlEnv);
  const restoredControl = path.join(root, "restored-control");
  run("restore.sh", ["control", controlBackup], { ...controlEnv, CUBE_HOST_ROOT: restoredControl });
  assert.equal(fs.readFileSync(path.join(restoredControl, "control/cubed.db"), "utf8"), "control-registry");
  assert.equal(fs.readFileSync(path.join(restoredControl, "control/config/node.json"), "utf8"), "private-admission");

  const unsafeVersion = spawnSync("bash", [path.join(repo, "scripts/host/install.sh"), bin("1.0.0/../../unsafe", "unsafe-version")], {
    encoding: "utf8",
    env: { ...process.env, CUBE_HOST_ROOT: path.join(root, "unsafe-stage"), CUBE_HOST_USER: os.userInfo().username },
  });
  assert.notEqual(unsafeVersion.status, 0);
  assert.match(unsafeVersion.stderr, /path-safe semantic software version/);

  const fakeSystemctl = path.join(root, "systemctl");
  fs.writeFileSync(fakeSystemctl, `#!/bin/sh
set -eu
root="$CUBE_HOST_ROOT"; action="$1"; ready="$root/run/cube-host/ready.json"
mkdir -p "$(dirname "$ready")"
case "$action" in
  reload) printf '%s\\n' '{"lifecycle":"draining"}' > "$ready" ;;
  stop) rm -f "$ready" ;;
  start)
    version=$(basename "$(readlink "$root/opt/cube-host/current")")
    [ "$version" != 1.2.0 ] || exit 1
    printf '{"lifecycle":"ready","softwareVersion":"%s","protocolVersion":1}\\n' "$version" > "$ready" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const installedUnit = path.join(stage, "etc/systemd/system/cube-host.service");
  const candidateUnit = fs.readFileSync(path.join(repo, "scripts/host/cube-host.service"), "utf8");
  fs.writeFileSync(installedUnit, `${candidateUnit}RestrictSUIDSGID=yes\n`);
  run("upgrade.sh", [bin("1.1.0")], { CUBE_HOST_SYSTEMCTL: fakeSystemctl });
  assert.match(fs.readlinkSync(path.join(stage, "opt/cube-host/current")), /1\.1\.0$/);
  assert.equal(fs.readFileSync(installedUnit, "utf8"), candidateUnit, "upgrade installs the candidate systemd unit");
  fs.writeFileSync(installedUnit, "previous production unit\n");
  const failed = spawnSync("bash", [path.join(repo, "scripts/host/upgrade.sh"), bin("1.2.0")], {
    encoding: "utf8",
    env: { ...process.env, CUBE_HOST_ROOT: stage, CUBE_HOST_USER: os.userInfo().username, CUBE_HOST_SYSTEMCTL: fakeSystemctl },
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /rollback to 1\.1\.0 is healthy/);
  assert.match(fs.readlinkSync(path.join(stage, "opt/cube-host/current")), /1\.1\.0$/);
  assert.equal(fs.readFileSync(installedUnit, "utf8"), "previous production unit\n", "rollback restores the previous systemd unit");

  console.log("host-production-test: install permissions, backup/restore quarantine, upgrade and rollback pass");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
