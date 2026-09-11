import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const launcher = join(root, "launcher/cube");
const temp = mkdtempSync(join(tmpdir(), "cube-launcher-network-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
const home = join(temp, "home");
mkdirSync(home);

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [launcher, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CUBE_HOME: home, ...env },
  });
}

function openssl(args: string[]) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// Explicit adapters keep library probes offline even if command lookup in a
// sourced shell would otherwise select the host's curl or ssh executable.
const libraryPrelude = `source "$1";
curl() { "$CUBE_HOME/../bin/curl" "$@"; }
ssh() { exec "$CUBE_HOME/../bin/ssh" "$@"; }
`;
function library(body: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", libraryPrelude + body, "test", launcher], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CUBE_HOME: home, CUBE_LIB_ONLY: "1", NO_COLOR: "1", ...env },
  });
}

const caKey = join(temp, "ca.key");
const ca = join(temp, "ca.pem");
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=cube test root", "-addext", "basicConstraints=critical,CA:TRUE",
  "-keyout", caKey, "-out", ca]);

let result = run(["ca", "set", ca]);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(readFileSync(join(home, "ca.pem")), readFileSync(ca), "set is an exact replacement");
result = run(["ca", "status"]);
assert.match(result.stdout, /additional CA bundle is configured/);

const bundle = join(temp, "bundle.pem");
writeFileSync(bundle, `${readFileSync(ca, "utf8")}\n${readFileSync(ca, "utf8")}`);
assert.equal(run(["ca", "set", bundle]).status, 0, "CA bundles are accepted");
const installedBundle = readFileSync(join(home, "ca.pem"));

const leafKey = join(temp, "leaf.key");
const leaf = join(temp, "leaf.pem");
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=CA:TRUE", "-addext", "basicConstraints=critical,CA:FALSE",
  "-keyout", leafKey, "-out", leaf]);
result = run(["ca", "set", leaf]);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /not a CA/);
assert.deepEqual(readFileSync(join(home, "ca.pem")), installedBundle, "invalid input leaves prior CA intact");

result = run(["ca", "set", caKey]);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /private key/);
const malformed = join(temp, "bad.pem");
writeFileSync(malformed, "not a certificate\n");
assert.notEqual(run(["ca", "set", malformed]).status, 0);
writeFileSync(malformed, readFileSync(ca, "utf8").replaceAll("\n", "\r\n"));
assert.equal(run(["ca", "set", malformed]).status, 0, "accept Windows PEM line endings");
assert.deepEqual(readFileSync(join(home, "ca.pem")), readFileSync(ca));

// Exercise the actual seed path without generating an ISO or booting a VM.
result = library(`ensure_ssh_key() { printf test > "$SSH_KEY.pub"; }
make_iso() { cp "$2/ca.pem" "$CUBE_HOME/seed-ca.pem"; }
make_run_seed`);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(readFileSync(join(home, "seed-ca.pem")), readFileSync(ca));

// Shell conditional callers suppress errexit throughout the call chain.
// Preserve the previous seed on disk, but never accept it as this boot's seed.
writeFileSync(join(home, "seed.iso"), "previous seed with revoked CA");
for (const failure of [
  'genisoimage() { return 9; }',
  'genisoimage() { printf new > "$3"; }; mv() { return 9; }',
]) {
  result = library(`${failure}; if make_iso "$RUN_SEED" "$CUBE_HOME"; then exit 0; else exit 9; fi`);
  assert.notEqual(result.status, 0, "ISO creation/rename errors must propagate even in conditional callers");
  assert.equal(readFileSync(join(home, "seed.iso"), "utf8"), "previous seed with revoked CA");
}
for (const failure of [
  'make_iso() { return 9; }',
  'make_iso() { return 0; }; cp() { if [ "$1" = "$CUSTOM_CA" ]; then return 9; else command cp "$@"; fi; }',
]) {
  result = library(`${failure}; if make_run_seed; then exit 0; else exit 9; fi`);
  assert.notEqual(result.status, 0, "seed errors must survive cleanup");
}
result = library(`settle_ports() { :; }
artifact_sha() { echo unused; }
make_run_seed() { return 9; }
ensure_overlay() { echo unsafe > "$CUBE_HOME/boot-continued"; return 1; }
if boot_vm v0.0.0; then exit 0; else exit 9; fi`);
assert.notEqual(result.status, 0);
assert.throws(() => readFileSync(join(home, "boot-continued")), "boot must stop before touching disks or starting QEMU");

// A running launcher-owned VM prevents profile changes.
writeFileSync(join(home, "live.qcow2"), "marker");
const fakeVm = spawn("tail", ["-f", join(home, "live.qcow2")]);
writeFileSync(join(home, "vm.pid"), `${fakeVm.pid}\n`);
result = run(["ca", "clear"]);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /cube down.*cube up/);
fakeVm.kill();
writeFileSync(join(home, "vm.pid"), "99999999\n");
assert.equal(run(["ca", "clear"]).status, 0);

// Doctor is offline-testable: fake curl outcomes and leave the VM down.
const bin = join(temp, "bin");
mkdirSync(bin);
const fakeCurl = join(bin, "curl");
writeFileSync(fakeCurl, "#!/bin/sh\nprintf 200\n");
chmodSync(fakeCurl, 0o755);
result = run(["doctor"], { PATH: `${bin}:${process.env.PATH}` });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /host HTTPS trust.*succeeded/);
assert.match(result.stdout, /skip: VM checks/);

writeFileSync(fakeCurl, "#!/bin/sh\nexit 60\n");
result = run(["doctor"], { PATH: `${bin}:${process.env.PATH}` });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /certificate verification failed \(curl 60\)/);

for (const [rc, code, expected] of [[6, "000", /DNS lookup failed/], [28, "000", /timeout/], [0, "407", /HTTP 407/], [0, "302", /HTTP 302/]] as const) {
  writeFileSync(fakeCurl, `#!/bin/sh\nprintf '${code}'\nexit ${rc}\n`);
  result = run(["doctor"], { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expected);
}

// Custom trust reaches download curl without dropping the host's public roots.
assert.equal(run(["ca", "set", ca]).status, 0);
writeFileSync(fakeCurl, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CUBE_HOME/curl-args"\nprintf 200\n');
result = library('cube_curl https://api.github.com', { PATH: `${bin}:${process.env.PATH}` });
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout, "200", result.stderr);
assert.match(readFileSync(join(home, "curl-args"), "utf8"), /--cacert\n/);
const combined = readFileSync(join(home, "host-ca-bundle.pem"), "utf8");
assert.ok(combined.endsWith(readFileSync(ca, "utf8")));
assert.ok(combined.length > readFileSync(ca).length * 2, "public trust is retained");

const vm = `vm_pid() { echo 42; }
doctor_ssh() {
  case "$*" in
    *'curl '*) printf 000; return 60 ;;
    *) return 0 ;;
  esac
}
cmd_doctor`;
result = library(vm, { PATH: `${bin}:${process.env.PATH}` });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /VM curl HTTPS certificate verification failed/);
assert.match(result.stdout, /VM Node HTTPS trust succeeded/);
assert.equal(run(["ca", "clear"]).status, 0);
result = library(`ensure_ssh_key() { :; }
make_iso() { test ! -e "$2/ca.pem"; }
make_run_seed`);
assert.equal(result.status, 0, "clear removes CA material from subsequent seeds");

// Real TLS, with the exact fixed doctor destination redirected locally.
// A user's insecure curlrc must not turn an untrusted issuer into success.
const exec = promisify(execFile);
async function libraryAsync(body: string, env: Record<string, string> = {}) {
  try {
    const output = await exec("bash", ["-c", libraryPrelude + body, "test", launcher], {
      cwd: root, env: { ...process.env, CUBE_HOME: home, CUBE_LIB_ONLY: "1", NO_COLOR: "1", ...env },
      timeout: 30_000, killSignal: "SIGKILL",
    });
    return { ...output, status: 0 };
  } catch (error) {
    const failed = error as Error & { code: number; killed?: boolean; stdout: string; stderr: string };
    assert.ok(!failed.killed, "doctor exceeded the test's outer deadline");
    return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
const realCurl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
const curlHome = join(temp, "curl-home");
mkdirSync(curlHome);
writeFileSync(join(curlHome, ".curlrc"), "insecure\n");
const tlsServer = https.createServer({ key: readFileSync(leafKey), cert: readFileSync(leaf) }, (_req, res) => res.end("local TLS"));
await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
try {
  const address = tlsServer.address();
  assert.ok(address && typeof address !== "string");
  const tlsEnv = { PATH: `${bin}:${process.env.PATH}`, CURL_HOME: curlHome };
  const insecure = await exec(realCurl, ["--noproxy", "*", "--max-time", "5", "-sS", `https://127.0.0.1:${address.port}`], {
    env: { ...process.env, CURL_HOME: curlHome },
  });
  assert.equal(insecure.stdout, "local TLS", "control: curlrc really does bypass verification without -q");
  writeFileSync(fakeCurl, `#!/bin/sh
printf '%s\\n' "$@" > "$CUBE_HOME/curl-args"
exec '${realCurl}' "$@" --noproxy '*' --connect-to 'api.github.com:443:127.0.0.1:${address.port}'
`);
  for (const custom of [false, true]) {
    assert.equal(run(custom ? ["ca", "set", ca] : ["ca", "clear"]).status, 0);
    const probe = await libraryAsync("doctor_https host host_doctor_curl", tlsEnv);
    assert.equal(probe.status, 1, "doctor must reject the untrusted issuer despite curlrc, with or without custom roots");
    assert.match(probe.stderr, /certificate verification failed/);
    assert.equal(readFileSync(join(home, "curl-args"), "utf8").split("\n")[0], "-q");
  }
  // Run the generated remote curl command locally, omitting only the VM's
  // profile bootstrap so this test keeps its own PATH and curl home.
  const remote = await libraryAsync(`doctor_ssh() { eval "\${1#. /etc/profile; }"; }
doctor_https 'VM curl' vm_doctor_curl`, tlsEnv);
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /certificate verification failed/);
  assert.equal(readFileSync(join(home, "curl-args"), "utf8").split("\n")[0], "-q");
} finally {
  tlsServer.closeAllConnections();
  await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  assert.equal(run(["ca", "clear"]).status, 0);
}

// A control-plane listener accepts requests but never sends a response.
// A separate fake ssh process connects but never finishes its command.
// Exercise both real deadlines concurrently without accessing any VM.
const requests: string[] = [];
const stalled = http.createServer((req) => requests.push(req.url ?? ""));
await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
const fakeSsh = join(bin, "ssh");
writeFileSync(fakeSsh, '#!/bin/sh\necho $$ > "$CUBE_HOME/ssh-pid"\nexec sleep 60\n', { mode: 0o755 });
writeFileSync(fakeCurl, `#!/bin/sh\nexec '${realCurl}' "$@"\n`);
try {
  const address = stalled.address();
  assert.ok(address && typeof address !== "string");
  const started = Date.now();
  const [control, ssh] = await Promise.all([
    libraryAsync(`vm_pid() { echo 42; }
host_doctor_curl() { printf 200; }
doctor_ssh() { case "$*" in *'curl '*) printf 200 ;; esac; return 0; }
cmd_doctor`, { PATH: `${bin}:${process.env.PATH}`, CUBE_PORT: String(address.port) }),
    libraryAsync("doctor_ssh true", { PATH: `${bin}:${process.env.PATH}` }),
  ]);
  assert.equal(control.status, 1, "stalled HTTP must be a failure, not a hang or success");
  assert.match(control.stderr, /control plane is not answering/);
  assert.match(control.stdout, /VM Node HTTPS trust succeeded/, "doctor continues after the control-plane timeout");
  assert.deepEqual(requests, ["/api/state"], "doctor must not touch /api/threads");
  assert.equal(ssh.status, 124, "a stuck remote command hits the local SSH deadline");
  assert.ok(Date.now() - started < 27_000, "20-second SSH deadline has bounded scheduling overhead");
  const pid = Number(readFileSync(join(home, "ssh-pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), "the timed-out ssh process was killed and reaped");
  for (const status of [0, 17]) {
    writeFileSync(fakeSsh, `#!/bin/sh\nexit ${status}\n`);
    const completed = await libraryAsync("doctor_ssh true", { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(completed.status, status, "completed SSH commands retain their exit status");
  }
} finally {
  stalled.closeAllConnections();
  await new Promise<void>((resolve) => stalled.close(() => resolve()));
  // Cleanup if a regression defeated the command's own deadline.
  try { process.kill(Number(readFileSync(join(home, "ssh-pid"), "utf8")), "SIGKILL"); } catch { /* already gone */ }
}

console.log("launcher network tests passed");
