import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-production-"));
const user = os.userInfo().username;
const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
const binary = (version: string) => {
  const file = path.join(root, `runner-${version}`);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = version ] || exit 1\nprintf '%s\\n' '{"softwareVersion":"${version}","protocolVersion":1,"minimumProtocolVersion":1}'\n`, { mode: 0o755 });
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
const run = (area: "host" | "runner", script: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", [path.join(repo, "scripts", area, script), ...args], { encoding: "utf8",
    env: { ...process.env, PATH: platformPath, CUBE_RUNNER_ROOT: stage, CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group, CUBE_HOST_ROOT: stage,
      CUBE_HOST_USER: user, CUBE_RUNNER_PLATFORM: "Linux", CUBE_RUNNER_ARCH: "x86_64", ...extra } });
  if (result.status !== 0) throw new Error(`${area}/${script}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const reject = (area: "host" | "runner", script: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", [path.join(repo, "scripts", area, script), ...args], { encoding: "utf8",
    env: { ...process.env, PATH: platformPath, CUBE_RUNNER_ROOT: stage, CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group, CUBE_HOST_ROOT: stage,
      CUBE_HOST_USER: user, CUBE_RUNNER_PLATFORM: "Linux", CUBE_RUNNER_ARCH: "x86_64", ...extra } });
  assert.notEqual(result.status, 0, `${area}/${script} unexpectedly succeeded`);
  return result;
};
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const testLinux = () => {
  const fresh = path.join(root, "fresh");
  run("runner", "install.sh", [binary("0.2.0")], fresh);
  assert.equal(fs.readlinkSync(path.join(fresh, "opt/cube-runner/current")), path.join(fresh, "opt/cube-runner/releases/0.2.0"));
  assert.equal(fs.statSync(path.join(fresh, "var/lib/cube-runner")).mode & 0o777, 0o700);
  const freshUnit = fs.readFileSync(path.join(fresh, "etc/systemd/system/cube-runner.service"), "utf8");
  assert.match(freshUnit, /User=cube-runner/);
  assert.match(freshUnit, /cube-runner runner-serve/);
  assert.doesNotMatch(freshUnit, /cube-host/);
  fs.mkdirSync(path.join(fresh, "var/lib/cube-runner/state"));
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/identity/node.key"), "fresh-private-key", { mode: 0o600 });
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/state/journal.db"), "fresh-journal", { mode: 0o600 });
  fs.writeFileSync(path.join(fresh, "var/lib/cube-runner/workspace/result"), "fresh-result");
  const backup = path.join(root, "fresh-backup.tar.gz");
  run("runner", "backup.sh", [backup], fresh);
  assert.equal(fs.readFileSync(`${backup}.sha256`, "utf8").trim().split(/\s+/)[1], path.basename(backup),
    "portable checksum records only the archive basename");
  const restored = path.join(root, "restored");
  run("runner", "restore.sh", [backup], restored);
  assert.equal(fs.readFileSync(path.join(restored, "var/lib/cube-runner/identity/node.key"), "utf8"), "fresh-private-key");
  assert.equal(fs.readFileSync(path.join(restored, "var/lib/cube-runner/workspace/result"), "utf8"), "fresh-result");
  assert.equal(fs.statSync(path.join(restored, "var/lib/cube-runner/state/restore-quarantine")).mode & 0o777, 0o600);
  run("runner", "acknowledge-recovery.sh", ["--i-reviewed-unknown-operations"], restored);
  assert.equal(fs.existsSync(path.join(restored, "var/lib/cube-runner/state/restore-quarantine")), false);
  run("runner", "uninstall.sh", ["--keep-state"], fresh, { CUBE_RUNNER_SYSTEMCTL: "/usr/bin/true" });
  assert.equal(fs.existsSync(path.join(fresh, "opt/cube-runner")), false);
  assert.equal(fs.existsSync(path.join(fresh, "var/lib/cube-runner")), true, "clean uninstall preserves durable state");

  const systemctl = path.join(root, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh
set -eu
root="$CUBE_RUNNER_ROOT"; action="$1"; service="\${2:-}"
case "$action:$service" in
  reload:cube-host.service) printf '%s\\n' '{"lifecycle":"draining"}' > "$root/run/cube-host/ready.json" ;;
  reload:cube-runner.service) mkdir -p "$root/run/cube-runner"; printf '%s\\n' '{"lifecycle":"draining"}' > "$root/run/cube-runner/ready.json" ;;
  stop:*) rm -f "$root/run/cube-host/ready.json" "$root/run/cube-runner/ready.json" ;;
  start:cube-runner.service)
    mkdir -p "$root/run/cube-runner"; version=$(basename "$(readlink "$root/opt/cube-runner/current")")
    [ "\${CUBE_TEST_FAIL_VERSION:-}" != "$version" ] || exit 1
    printf '{"lifecycle":"ready","softwareVersion":"%s","protocolVersion":1}\\n' "$version" > "$root/run/cube-runner/ready.json" ;;
  start:cube-host.service)
    mkdir -p "$root/run/cube-host"; printf '%s\\n' '{"lifecycle":"ready","softwareVersion":"0.1.1","protocolVersion":1}' > "$root/run/cube-host/ready.json" ;;
  *) : ;;
esac
`, { mode: 0o755 });
  const env = { CUBE_RUNNER_SYSTEMCTL: systemctl };
  const legacy = path.join(root, "legacy");
  run("host", "install.sh", [binary("0.1.1")], legacy);
  fs.mkdirSync(path.join(legacy, "var/lib/cube-host/state"));
  const key = path.join(legacy, "var/lib/cube-host/identity/node.key");
  const journal = path.join(legacy, "var/lib/cube-host/state/journal.db");
  const binding = path.join(legacy, "var/lib/cube-host/state/installation.json");
  fs.writeFileSync(key, "unchanged-private-key", { mode: 0o600 });
  fs.writeFileSync(journal, "durable-no-replay-journal", { mode: 0o600 });
  fs.writeFileSync(binding, '{"nodeId":"redacted","threadId":"redacted","environmentId":17}', { mode: 0o600 });
  const before = [key, journal, binding].map(digest);
  fs.mkdirSync(path.join(legacy, "run/cube-host"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "run/cube-host/ready.json"), '{"lifecycle":"ready","softwareVersion":"0.1.1","protocolVersion":1}\n');
  reject("runner", "upgrade.sh", [binary("0.2.0")], legacy, { ...env, CUBE_TEST_FAIL_VERSION: "0.2.0" });
  assert.deepEqual([key, journal, binding].map(digest), before, "failed migration preserves all durable state");
  assert.equal(fs.existsSync(path.join(legacy, "etc/cube-runner/legacy-layout")), false, "failed migration clears compatibility marker");
  assert.ok(fs.existsSync(path.join(legacy, "run/cube-host/ready.json")), "failed migration restores the legacy service");
  run("runner", "upgrade.sh", [binary("0.2.0")], legacy, env);
  assert.deepEqual([key, journal, binding].map(digest), before, "upgrade never rewrites key, journal or binding");
  assert.ok(fs.existsSync(path.join(legacy, "etc/cube-runner/legacy-layout")));
  const migratedUnit = fs.readFileSync(path.join(legacy, "etc/systemd/system/cube-runner.service"), "utf8");
  assert.match(migratedUnit, /User=cube-host/);
  assert.match(migratedUnit, /\/var\/lib\/cube-host\/state/);
  assert.match(migratedUnit, /\/run\/cube-runner\/ready\.json/);
  run("runner", "upgrade.sh", [binary("0.3.0")], legacy, env);
  assert.match(fs.readlinkSync(path.join(legacy, "opt/cube-runner/current")), /0\.3\.0$/, "phase-1 layout remains upgradeable");
  assert.ok(fs.existsSync(path.join(legacy, "etc/cube-runner/legacy-layout")));
  assert.deepEqual([key, journal, binding].map(digest), before, "phase-1 runner upgrade preserves legacy durable state");
  run("runner", "rollback-legacy.sh", [], legacy, env);
  assert.deepEqual([key, journal, binding].map(digest), before, "rollback also leaves durable identity untouched");
  assert.ok(fs.existsSync(path.join(legacy, "run/cube-host/ready.json")));

  const native = path.join(root, "native");
  run("runner", "install.sh", [binary("0.2.0")], native);
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
  assert.equal(fs.existsSync(plutilMarker), false, "Linux systemd lifecycle must never invoke plutil");
};

const testDarwin = () => {
  const darwin = path.join(root, "darwin");
  const darwinHome = path.join(darwin, "Library/Application Support/CubeRunner");
  const darwinPlist = path.join(darwin, "Library/LaunchAgents/com.cubeyard.cube-runner.plist");
  const darwinEnv = { CUBE_RUNNER_PLATFORM: "Darwin", CUBE_RUNNER_ARCH: process.arch === "arm64" ? "arm64" : "x86_64",
    CUBE_RUNNER_MODE: "user", CUBE_RUNNER_HOME: darwinHome, CUBE_RUNNER_PLIST: darwinPlist };
  run("runner", "install.sh", [binary("0.2.0")], darwin, darwinEnv);
  assert.equal(fs.readlinkSync(path.join(darwinHome, "current")), path.join(darwinHome, "releases/0.2.0"));
  assert.equal(fs.statSync(path.join(darwinHome, "data")).mode & 0o777, 0o700);
  const plist = fs.readFileSync(darwinPlist, "utf8");
  assert.match(plist, /com\.cubeyard\.cube-runner/);
  assert.match(plist, /<string>runner-serve<\/string>/);
  assert.match(plist, /<string>relay<\/string>/);
  assert.match(plist, /<string>--stop-policy<\/string><string>wait<\/string>/);
  assert.doesNotMatch(plist, /<key>UserName<\/key>/, "per-user LaunchAgent uses its login account");
  assert.equal(spawnSync("plutil", ["-lint", darwinPlist]).status, 0);
  reject("runner", "install.sh", [binary("0.2.1")], path.join(root, "invalid-stop-policy"), {
    ...darwinEnv, CUBE_RUNNER_HOME: path.join(root, "invalid-stop-policy/home"),
    CUBE_RUNNER_PLIST: path.join(root, "invalid-stop-policy/runner.plist"), CUBE_RUNNER_STOP_POLICY: "detach",
  });

  const darwinSystem = path.join(root, "darwin-system");
  const darwinSystemEnv = { CUBE_RUNNER_PLATFORM: "Darwin", CUBE_RUNNER_ARCH: process.arch === "arm64" ? "arm64" : "x86_64",
    CUBE_RUNNER_MODE: "system", CUBE_RUNNER_USER: user, CUBE_RUNNER_GROUP: group, CUBE_RUNNER_STOP_POLICY: "cancel" };
  run("runner", "install.sh", [binary("0.2.1")], darwinSystem, darwinSystemEnv);
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
  fs.writeFileSync(path.join(darwinHome, "data/workspace/result"), "darwin-result");
  const darwinBackup = path.join(root, "darwin-backup.tar.gz");
  run("runner", "backup.sh", [darwinBackup], darwin, darwinEnv);
  const darwinRestore = path.join(root, "darwin-restored");
  const restoredHome = path.join(darwinRestore, "Library/Application Support/CubeRunner");
  run("runner", "restore.sh", [darwinBackup], darwinRestore, { ...darwinEnv,
    CUBE_RUNNER_HOME: restoredHome, CUBE_RUNNER_PLIST: path.join(darwinRestore, "runner.plist") });
  assert.equal(fs.readFileSync(path.join(restoredHome, "data/identity/node.key"), "utf8"), "darwin-private-key");
  assert.equal(fs.readFileSync(path.join(restoredHome, "data/workspace/result"), "utf8"), "darwin-result");
  assert.equal(fs.statSync(path.join(restoredHome, "data/state/restore-quarantine")).mode & 0o777, 0o600);
};

try {
  if (process.platform === "linux") testLinux();
  if (process.platform === "darwin") testDarwin();
  console.log(process.platform === "darwin"
    ? "runner-production-test: macOS launchd lifecycle, plist validation and backup/restore preserve durable identity"
    : "runner-production-test: Linux systemd lifecycle, migration and backup/restore preserve durable identity without plutil");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
