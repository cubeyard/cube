import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-production-"));
const user = os.userInfo().username;
const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
const binary = (version: string, protocol = 3) => {
  const file = path.join(root, `runner-${version}-p${protocol}`);
  fs.writeFileSync(file, `#!/bin/sh
set -eu
if [ "$1" = version ]; then
  printf '%s\\n' '{"softwareVersion":"${version}","protocolVersion":${protocol},"minimumProtocolVersion":${protocol}}'
elif [ "$1" = verify-release ]; then
  printf '%s\n' "$CUBE_TEST_VERIFY"
elif [ "$1" = idle ]; then
  printf '{"activeVms":%s,"idle":%s}\n' "\${CUBE_TEST_ACTIVE:-0}" "$([ "\${CUBE_TEST_ACTIVE:-0}" = 0 ] && echo true || echo false)"
elif [ "$1" = runner-acknowledge-recovery ]; then
  shift; state=""
  while [ "$#" -gt 0 ]; do
    [ "$1" = --state ] && state="$2"
    shift 2
  done
  [ -n "$state" ]
  touch "$state/recovery-command-ran"
  [ "\${CUBE_TEST_FAIL_RECOVERY:-}" != 1 ]
  rm "$state/restore-quarantine"
else
  exit 1
fi
`, { mode: 0o755 });
  return file;
};
const plutilMarker = path.join(root, "linux-must-not-call-plutil");
const testBin = path.join(root, "test-bin");
if (process.platform === "linux") {
  fs.mkdirSync(testBin);
  fs.writeFileSync(path.join(testBin, "plutil"), `#!/bin/sh
touch ${JSON.stringify(plutilMarker)}
exit 97
`, { mode: 0o755 });
}
const platformPath = process.platform === "linux" ? `${testBin}:${process.env.PATH}` : process.env.PATH;
const script = (name: string, args: string[], stage: string, extra: NodeJS.ProcessEnv) =>
  spawnSync("bash", [path.join(repo, "scripts/runner", name), ...args], { encoding: "utf8",
    env: { ...process.env, PATH: platformPath, CUBE_RUNNER_ROOT: stage, CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group,
      CUBE_RUNNER_PLATFORM: "Linux", CUBE_RUNNER_ARCH: "x86_64", ...extra } });
const run = (_area: "runner", name: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = script(name, args, stage, extra);
  if (result.status !== 0) throw new Error(`runner/${name}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const reject = (_area: "runner", name: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = script(name, args, stage, extra);
  assert.notEqual(result.status, 0, `runner/${name} unexpectedly succeeded`);
  return result;
};

const testLinux = () => {
  const direct = path.join(root, "direct-linux");
  const managerMarker = path.join(root, "direct-linux-called-systemctl");
  const manager = path.join(root, "direct-linux-systemctl");
  fs.writeFileSync(manager, `#!/bin/sh\ntouch ${JSON.stringify(managerMarker)}\nexit 97\n`, { mode: 0o755 });
  run("runner", "install.sh", [binary("0.1.9")], direct, {
    CUBE_RUNNER_PREFIX: path.join(direct, "home/.local"), CUBE_RUNNER_SYSTEMCTL: manager,
  });
  assert.ok(fs.existsSync(path.join(direct, "home/.local/bin/cube-runner")));
  assert.equal(fs.existsSync(managerMarker), false, "direct install must not call systemd");
  assert.equal(fs.existsSync(path.join(direct, "etc/systemd/system/cube-runner.service")), false);
  const directDarwin = path.join(root, "direct-darwin");
  const launchctlMarker = path.join(root, "direct-darwin-called-launchctl");
  const launchctl = path.join(root, "direct-darwin-launchctl");
  fs.writeFileSync(launchctl, `#!/bin/sh\ntouch ${JSON.stringify(launchctlMarker)}\nexit 97\n`, { mode: 0o755 });
  run("runner", "install.sh", [binary("0.1.8")], directDarwin, {
    CUBE_RUNNER_PLATFORM: "Darwin", CUBE_RUNNER_ARCH: "x86_64", CUBE_RUNNER_MODE: "user",
    CUBE_RUNNER_PREFIX: path.join(directDarwin, "home/.local"), CUBE_RUNNER_LAUNCHCTL: launchctl,
  });
  assert.ok(fs.existsSync(path.join(directDarwin, "home/.local/bin/cube-runner")));
  assert.equal(fs.existsSync(launchctlMarker), false, "direct install must not call launchd");
  assert.equal(fs.existsSync(plutilMarker), false, "direct install must not create or validate a plist");

  const fresh = path.join(root, "fresh");
  for (const protocol of [1, 2]) {
    const old = reject("runner", "install.sh", ["--service", binary("0.3.0", protocol)], path.join(root, `protocol-${protocol}`));
    assert.match(old.stderr + old.stdout, /runner protocol 3/, `a protocol-${protocol} runner is not installable`);
  }
  run("runner", "install.sh", ["--service", binary("0.2.0")], fresh);
  assert.equal(fs.readlinkSync(path.join(fresh, "opt/cube-runner/current")), path.join(fresh, "opt/cube-runner/releases/0.2.0"));
  assert.equal(fs.statSync(path.join(fresh, "var/lib/cube-runner")).mode & 0o777, 0o700);
  const freshUnit = fs.readFileSync(path.join(fresh, "etc/systemd/system/cube-runner.service"), "utf8");
  assert.match(freshUnit, /User=cube-runner/);
  assert.match(freshUnit, /cube-runner runner-serve/);
  assert.match(freshUnit, /SupplementaryGroups=kvm/);
  assert.match(freshUnit, /TimeoutStopSec=60/);
  assert.doesNotMatch(freshUnit, /cube-host|same-UID/);
  assert.equal(fs.existsSync(path.join(fresh, "var/lib/cube-runner/workspace")), false, "no runner workspace in protocol 3");
  fs.mkdirSync(path.join(fresh, "var/lib/cube-runner/state"));
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/identity/node.key"), "fresh-private-key", { mode: 0o600 });
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/state/journal.db"), "fresh-journal", { mode: 0o600 });
  fs.mkdirSync(path.join(fresh, "var/lib/cube-runner/state/vms/1"), { recursive: true });
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/state/vms/1/disk.qcow2"), "fresh-disk");
  const backup = path.join(root, "fresh-backup.tar.gz");
  run("runner", "backup.sh", [backup], fresh);
  assert.equal(fs.readFileSync(`${backup}.sha256`, "utf8").trim().split(/\s+/)[1], path.basename(backup),
    "portable checksum records only the archive basename");
  const restored = path.join(root, "restored");
  run("runner", "restore.sh", [backup], restored);
  assert.equal(fs.readFileSync(path.join(restored, "var/lib/cube-runner/identity/node.key"), "utf8"), "fresh-private-key");
  assert.equal(fs.readFileSync(path.join(restored, "var/lib/cube-runner/state/vms/1/disk.qcow2"), "utf8"), "fresh-disk");
  assert.equal(fs.statSync(path.join(restored, "var/lib/cube-runner/state/restore-quarantine")).mode & 0o777, 0o600);
  run("runner", "install.sh", ["--service", binary("0.2.0")], restored);
  run("runner", "acknowledge-recovery.sh", ["--i-reviewed-retained-vms"], restored);
  assert.equal(fs.existsSync(path.join(restored, "var/lib/cube-runner/state/restore-quarantine")), false);
  assert.ok(fs.existsSync(path.join(restored, "var/lib/cube-runner/state/recovery-command-ran")),
    "acknowledgement delegates journal and base image checks to the runner binary");
  run("runner", "uninstall.sh", ["--keep-state"], fresh, { CUBE_RUNNER_SYSTEMCTL: "/usr/bin/true" });
  assert.equal(fs.existsSync(path.join(fresh, "opt/cube-runner")), false);
  assert.equal(fs.existsSync(path.join(fresh, "var/lib/cube-runner")), true, "clean uninstall preserves durable state");

  const systemctl = path.join(root, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh
set -eu
root="$CUBE_RUNNER_ROOT"; action="$1"; service="\${2:-}"
case "$action:$service" in
  reload:cube-runner.service) mkdir -p "$root/run/cube-runner"; printf '%s\\n' '{"lifecycle":"draining"}' > "$root/run/cube-runner/ready.json" ;;
  stop:*) rm -f "$root/run/cube-runner/ready.json" ;;
  start:cube-runner.service)
    mkdir -p "$root/run/cube-runner"; version=$(basename "$(readlink "$root/opt/cube-runner/current")")
    [ "\${CUBE_TEST_FAIL_VERSION:-}" != "$version" ] || exit 1
    printf '{"lifecycle":"ready","softwareVersion":"%s","protocolVersion":1}\\n' "$version" > "$root/run/cube-runner/ready.json" ;;
  *) : ;;
esac
`, { mode: 0o755 });
  const env = { CUBE_RUNNER_SYSTEMCTL: systemctl };
  const native = path.join(root, "native");
  run("runner", "install.sh", ["--service", binary("0.2.0")], native);
  fs.mkdirSync(path.join(native, "run/cube-runner"), { recursive: true });
  fs.writeFileSync(path.join(native, "run/cube-runner/ready.json"), '{"lifecycle":"ready","softwareVersion":"0.2.0","protocolVersion":1}\n');
  run("runner", "upgrade.sh", [binary("0.3.0")], native, env);
  assert.match(fs.readlinkSync(path.join(native, "opt/cube-runner/current")), /0\.3\.0$/);
  const unitBeforeFailure = fs.readFileSync(path.join(native, "etc/systemd/system/cube-runner.service"));
  reject("runner", "upgrade.sh", [binary("0.4.0")], native, { ...env, CUBE_TEST_FAIL_VERSION: "0.4.0" });
  assert.match(fs.readlinkSync(path.join(native, "opt/cube-runner/current")), /0\.3\.0$/, "failed native upgrade restores release link");
  assert.deepEqual(fs.readFileSync(path.join(native, "etc/systemd/system/cube-runner.service")), unitBeforeFailure,
    "failed native upgrade restores its systemd unit");
  assert.match(fs.readFileSync(path.join(native, "run/cube-runner/ready.json"), "utf8"), /"softwareVersion":"0.3.0"/);

  // Self-update: install placed the updater, its pinned key and an hourly timer.
  const updaterScript = path.join(native, "opt/cube-runner/updater/scripts/runner/update.sh");
  assert.ok(fs.existsSync(updaterScript), "install places the updater");
  assert.ok(fs.existsSync(path.join(native, "opt/cube-runner/updater/update-public-key.pem")), "with the pinned key");
  assert.match(fs.readFileSync(path.join(native, "etc/systemd/system/cube-runner-update.timer"), "utf8"), /OnUnitActiveSec=1h/);
  assert.match(fs.readFileSync(path.join(native, "etc/systemd/system/cube-runner-update.service"), "utf8"),
    /ExecStart=\/bin\/bash \/opt\/cube-runner\/updater\/scripts\/runner\/update.sh/);
  // A signed bundle in a local "feed"; curl is replaced by a copy from it.
  const feed = path.join(root, "feed");
  const bundleStage = path.join(root, "bundle-stage/cube-runner");
  fs.mkdirSync(path.join(bundleStage, "bin"), { recursive: true });
  fs.copyFileSync(binary("0.6.0"), path.join(bundleStage, "bin/cube-runner"));
  fs.chmodSync(path.join(bundleStage, "bin/cube-runner"), 0o755);
  fs.cpSync(path.join(repo, "scripts/runner"), path.join(bundleStage, "scripts/runner"), { recursive: true });
  fs.copyFileSync(path.join(repo, "scripts/cubed/update-public-key.pem"), path.join(bundleStage, "update-public-key.pem"));
  fs.mkdirSync(feed);
  spawnSync("tar", ["-czf", path.join(feed, "bundle.tar.gz"), "-C", path.dirname(bundleStage), "cube-runner"]);
  fs.writeFileSync(path.join(feed, "cube-runner-linux-x64-gnu.json"), "{}\n");
  fs.writeFileSync(path.join(feed, "cube-runner-linux-x64-gnu.json.sig"), "sig\n");
  const bundleBytes = fs.statSync(path.join(feed, "bundle.tar.gz")).size;
  const bundleSha = spawnSync("sha256sum", [path.join(feed, "bundle.tar.gz")], { encoding: "utf8" }).stdout.split(" ")[0];
  const curl = path.join(root, "curl");
  fs.writeFileSync(curl, `#!/bin/sh
out=""; url=""
while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
cp "${feed}/$(basename "$url")" "$out"
`, { mode: 0o755 });
  const verify = (version: string, newer: boolean, sha = bundleSha) =>
    JSON.stringify({ version, newer, url: "https://example.invalid/bundle.tar.gz", sha256: sha, bytes: bundleBytes });
  const updateEnv = { ...env, CUBE_RUNNER_CURL: curl };
  const update = (extra: NodeJS.ProcessEnv) => spawnSync("bash", [updaterScript], { encoding: "utf8",
    env: { ...process.env, PATH: platformPath, CUBE_RUNNER_ROOT: native, CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group,
      CUBE_RUNNER_PLATFORM: "Linux", CUBE_RUNNER_ARCH: "x86_64", ...updateEnv, ...extra } });
  let result = update({ CUBE_TEST_VERIFY: verify("0.3.0", false) });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /up to date/);
  result = update({ CUBE_TEST_VERIFY: verify("0.6.0", true), CUBE_TEST_ACTIVE: "1" });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /waits: the runner has an active thread machine/);
  assert.match(fs.readlinkSync(path.join(native, "opt/cube-runner/current")), /0\.3\.0$/, "a busy runner is not updated");
  result = update({ CUBE_TEST_VERIFY: verify("0.6.0", true, "0".repeat(64)) });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum does not match/);
  assert.match(fs.readlinkSync(path.join(native, "opt/cube-runner/current")), /0\.3\.0$/, "a bad artifact changes nothing");
  result = update({ CUBE_TEST_VERIFY: verify("0.6.0", true) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readlinkSync(path.join(native, "opt/cube-runner/current")), /0\.6\.0$/, "idle runner updated to the signed release");
  assert.match(fs.readFileSync(path.join(native, "run/cube-runner/ready.json"), "utf8"), /"softwareVersion":"0.6.0"/);
  // Roll the test installation back to 0.3.0 for the checks below.
  fs.rmSync(path.join(native, "opt/cube-runner/current"));
  fs.symlinkSync(path.join(native, "opt/cube-runner/releases/0.3.0"), path.join(native, "opt/cube-runner/current"));

  // A protocol-2 installation (same-UID execution) is not upgraded in place.
  const old = path.join(root, "protocol-two-installed");
  run("runner", "install.sh", ["--service", binary("0.4.1")], old);
  const p2 = path.join(old, "opt/cube-runner/releases/0.3.9");
  fs.mkdirSync(p2);
  fs.copyFileSync(binary("0.3.9", 2), path.join(p2, "cube-runner"));
  fs.chmodSync(path.join(p2, "cube-runner"), 0o755);
  fs.rmSync(path.join(old, "opt/cube-runner/current"));
  fs.symlinkSync(p2, path.join(old, "opt/cube-runner/current"));
  const refused = reject("runner", "upgrade.sh", [binary("0.4.2")], old, env);
  assert.match(refused.stderr, /protocol 2; protocol 3 needs a new state directory/);
  assert.equal(fs.readlinkSync(path.join(old, "opt/cube-runner/current")), p2, "refusal changes nothing");
  assert.equal(fs.existsSync(plutilMarker), false, "Linux systemd lifecycle must never invoke plutil");
};

const testDarwin = () => {
  const darwin = path.join(root, "darwin");
  const darwinHome = path.join(darwin, "Library/Application Support/CubeRunner");
  const darwinPlist = path.join(darwin, "Library/LaunchAgents/com.cubeyard.cube-runner.plist");
  const darwinEnv = { CUBE_RUNNER_PLATFORM: "Darwin", CUBE_RUNNER_ARCH: process.arch === "arm64" ? "arm64" : "x86_64",
    CUBE_RUNNER_MODE: "user", CUBE_RUNNER_HOME: darwinHome, CUBE_RUNNER_PLIST: darwinPlist };
  run("runner", "install.sh", ["--service", binary("0.2.0")], darwin, darwinEnv);
  assert.equal(fs.readlinkSync(path.join(darwinHome, "current")), path.join(darwinHome, "releases/0.2.0"));
  assert.equal(fs.statSync(path.join(darwinHome, "data")).mode & 0o777, 0o700);
  const plist = fs.readFileSync(darwinPlist, "utf8");
  assert.match(plist, /com\.cubeyard\.cube-runner/);
  assert.match(plist, /<string>runner-serve<\/string>/);
  assert.match(plist, /<string>relay<\/string>/);
  assert.match(plist, /<string>--stop-policy<\/string><string>wait<\/string>/);
  assert.doesNotMatch(plist, /<key>UserName<\/key>/, "per-user LaunchAgent uses its login account");
  assert.equal(spawnSync("plutil", ["-lint", darwinPlist]).status, 0);
  reject("runner", "install.sh", ["--service", binary("0.2.1")], path.join(root, "invalid-stop-policy"), {
    ...darwinEnv, CUBE_RUNNER_HOME: path.join(root, "invalid-stop-policy/home"),
    CUBE_RUNNER_PLIST: path.join(root, "invalid-stop-policy/runner.plist"), CUBE_RUNNER_STOP_POLICY: "detach",
  });

  const darwinSystem = path.join(root, "darwin-system");
  const darwinSystemEnv = { CUBE_RUNNER_PLATFORM: "Darwin", CUBE_RUNNER_ARCH: process.arch === "arm64" ? "arm64" : "x86_64",
    CUBE_RUNNER_MODE: "system", CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group, CUBE_RUNNER_STOP_POLICY: "cancel" };
  run("runner", "install.sh", ["--service", binary("0.2.1")], darwinSystem, darwinSystemEnv);
  const systemPlistPath = path.join(darwinSystem, "Library/LaunchDaemons/com.cubeyard.cube-runner.plist");
  const systemPlist = fs.readFileSync(systemPlistPath, "utf8");
  assert.match(systemPlist, new RegExp(`<key>UserName</key><string>${user}</string>`));
  assert.match(systemPlist, /<string>--stop-policy<\/string><string>cancel<\/string>/);
  assert.match(systemPlist, /\/Library\/Application Support\/CubeRunner\/data\/state/);
  assert.equal(spawnSync("plutil", ["-lint", systemPlistPath]).status, 0);
  const launchctl = path.join(root, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/sh
set -eu
home="$CUBE_RUNNER_HOME"; action="$1"; ready="$home/run/ready.json"
case "$action" in
  print) [ -f "$ready" ] ;;
  kill) printf '%s\\n' '{"lifecycle":"draining"}' > "$ready" ;;
  bootout) rm -f "$ready" ;;
  bootstrap|kickstart)
    version=$(basename "$(readlink "$home/current")")
    [ "\${CUBE_TEST_FAIL_VERSION:-}" != "$version" ] || exit 1
    printf '{"lifecycle":"ready","softwareVersion":"%s","protocolVersion":1}\\n' "$version" > "$ready" ;;
esac
`, { mode: 0o755 });
  const darwinLifecycle = { ...darwinEnv, CUBE_RUNNER_LAUNCHCTL: launchctl };
  fs.writeFileSync(path.join(darwinHome, "run/ready.json"), '{"lifecycle":"ready","softwareVersion":"0.2.0","protocolVersion":1}\n');
  run("runner", "upgrade.sh", [binary("0.3.0")], darwin, darwinLifecycle);
  assert.match(fs.readlinkSync(path.join(darwinHome, "current")), /0\.3\.0$/);
  reject("runner", "upgrade.sh", [binary("0.4.0")], darwin, { ...darwinLifecycle, CUBE_TEST_FAIL_VERSION: "0.4.0" });
  assert.match(fs.readlinkSync(path.join(darwinHome, "current")), /0\.3\.0$/, "failed launchd upgrade restores release link");
  assert.match(fs.readFileSync(path.join(darwinHome, "run/ready.json"), "utf8"), /"softwareVersion":"0.3.0"/);
  fs.mkdirSync(path.join(darwinHome, "data/state"));
  fs.writeFileSync(path.join(darwinHome, "data/identity/node.key"), "darwin-private-key", { mode: 0o600 });
  fs.writeFileSync(path.join(darwinHome, "data/state/journal.db"), "darwin-journal", { mode: 0o600 });
  fs.mkdirSync(path.join(darwinHome, "data/state/vms/1"), { recursive: true });
  fs.writeFileSync(path.join(darwinHome, "data/state/vms/1/disk.qcow2"), "darwin-disk");
  const darwinBackup = path.join(root, "darwin-backup.tar.gz");
  run("runner", "backup.sh", [darwinBackup], darwin, darwinEnv);
  const darwinRestore = path.join(root, "darwin-restored");
  const restoredHome = path.join(darwinRestore, "Library/Application Support/CubeRunner");
  run("runner", "restore.sh", [darwinBackup], darwinRestore, { ...darwinEnv,
    CUBE_RUNNER_HOME: restoredHome, CUBE_RUNNER_PLIST: path.join(darwinRestore, "runner.plist") });
  assert.equal(fs.readFileSync(path.join(restoredHome, "data/identity/node.key"), "utf8"), "darwin-private-key");
  assert.equal(fs.readFileSync(path.join(restoredHome, "data/state/vms/1/disk.qcow2"), "utf8"), "darwin-disk");
  assert.equal(fs.statSync(path.join(restoredHome, "data/state/restore-quarantine")).mode & 0o777, 0o600);
  run("runner", "install.sh", ["--service", binary("0.3.0")], darwinRestore, {
    ...darwinEnv, CUBE_RUNNER_HOME: restoredHome, CUBE_RUNNER_PLIST: path.join(darwinRestore, "runner.plist"),
  });
  reject("runner", "acknowledge-recovery.sh", ["--i-reviewed-retained-vms"], darwinRestore, {
    ...darwinEnv, CUBE_RUNNER_HOME: restoredHome, CUBE_RUNNER_PLIST: path.join(darwinRestore, "runner.plist"),
    CUBE_TEST_FAIL_RECOVERY: "1",
  });
  assert.ok(fs.existsSync(path.join(restoredHome, "data/state/restore-quarantine")),
    "failed recovery stays quarantined");
  run("runner", "acknowledge-recovery.sh", ["--i-reviewed-retained-vms"], darwinRestore, {
    ...darwinEnv, CUBE_RUNNER_HOME: restoredHome, CUBE_RUNNER_PLIST: path.join(darwinRestore, "runner.plist"),
  });
  assert.ok(fs.existsSync(path.join(restoredHome, "data/state/recovery-command-ran")));
};

try {
  if (process.platform === "linux") testLinux();
  if (process.platform === "darwin") testDarwin();
  console.log(process.platform === "darwin"
    ? "runner-production-test: macOS launchd lifecycle, plist validation and backup/restore preserve durable identity"
    : "runner-production-test: Linux systemd lifecycle, protocol-3 gate and backup/restore preserve durable identity without plutil");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
