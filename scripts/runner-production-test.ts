import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-production-"));
const user = os.userInfo().username;
const binary = (version: string) => {
  const file = path.join(root, `runner-${version}`);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = version ] || exit 1\nprintf '%s\\n' '{"softwareVersion":"${version}","protocolVersion":1,"minimumProtocolVersion":1}'\n`, { mode: 0o755 });
  return file;
};
const run = (area: "host" | "runner", script: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", [path.join(repo, "scripts", area, script), ...args], { encoding: "utf8",
    env: { ...process.env, CUBE_RUNNER_ROOT: stage, CUBE_RUNNER_USER: user, CUBE_HOST_ROOT: stage,
      CUBE_HOST_USER: user, ...extra } });
  if (result.status !== 0) throw new Error(`${area}/${script}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const reject = (area: "host" | "runner", script: string, args: string[], stage: string, extra: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", [path.join(repo, "scripts", area, script), ...args], { encoding: "utf8",
    env: { ...process.env, CUBE_RUNNER_ROOT: stage, CUBE_RUNNER_USER: user, CUBE_HOST_ROOT: stage,
      CUBE_HOST_USER: user, ...extra } });
  assert.notEqual(result.status, 0, `${area}/${script} unexpectedly succeeded`);
  return result;
};
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

try {
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
  run("runner", "uninstall.sh", ["--keep-state"], fresh, { CUBE_RUNNER_SYSTEMCTL: "/bin/true" });
  assert.equal(fs.existsSync(path.join(fresh, "opt/cube-runner")), false);
  assert.equal(fs.existsSync(path.join(fresh, "var/lib/cube-runner")), true, "clean uninstall preserves durable state");

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

  console.log("runner-production-test: fresh backup/restore/uninstall, native upgrade rollback, and cube-host 0.1.1 migration preserve durable identity");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
