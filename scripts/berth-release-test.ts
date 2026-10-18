/** berth's release tooling, offline: build-release.ts signs a manifest that
 * verifies with the key's public half and refuses a non-protocol-4 build;
 * verify-release.ts passes a good release and fails each tampering;
 * package.sh packs the bundle; install-berth.sh, against a stub berth, checks
 * before it writes, writes the expected start script and unit for both kinds,
 * refuses relative paths and every overwrite, and never calls systemctl,
 * launchctl or cubed. On macOS it runs under /bin/bash (3.2). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { publicKeyFingerprint } from "./cubed/verify-signing-key.ts";
import { verifyRelease } from "./berth/verify-release.ts";

const root = path.resolve(import.meta.dirname, "..");
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "berth-release-")));
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64-gnu"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : null;
const write = (file: string, data: string | Buffer, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode });
};
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyPath = path.join(dir, "key.pem");
  write(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, 0o600);
  const publicPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  // build-release.ts: the manifest, signed; a protocol-3 build and bad arguments refused.
  const pkg = path.join(dir, "package");
  write(path.join(pkg, "berth-v9.8.7-linux-x64-gnu.tar.gz"), "bundle bytes");
  write(path.join(pkg, "version.json"), '{"protocolVersion":4,"softwareVersion":"0.1.0"}\n');
  const release = path.join(dir, "release");
  execFileSync(process.execPath, ["scripts/berth/build-release.ts", "v9.8.7", "linux-x64-gnu", pkg, release, "https://example.test/dl/v9.8.7/", keyPath], { cwd: root });
  const manifest = fs.readFileSync(path.join(release, "berth-linux-x64-gnu.json"));
  const signature = Buffer.from(fs.readFileSync(path.join(release, "berth-linux-x64-gnu.json.sig"), "utf8").trim(), "base64");
  assert.ok(verify(null, manifest, publicKey, signature));
  assert.deepEqual(JSON.parse(manifest.toString()), {
    schema: 1, product: "berth", version: "0.1.0", release: "v9.8.7", commit, platform: "linux-x64-gnu", protocolVersion: 4,
    artifact: { url: "https://example.test/dl/v9.8.7/berth-v9.8.7-linux-x64-gnu.tar.gz", sha256: sha("bundle bytes"), bytes: 12 },
  });
  const flipped = new Uint8Array(manifest); flipped[12] ^= 1;
  assert.ok(!verify(null, flipped, publicKey, signature), "a changed manifest does not verify");
  write(path.join(dir, "p3", "version.json"), '{"protocolVersion":3,"softwareVersion":"0.8.4"}\n');
  write(path.join(dir, "p3", "berth-v9.8.7-linux-x64-gnu.tar.gz"), "x");
  for (const args of [["v9.8.7", "linux-x64-gnu", path.join(dir, "p3")], ["9.8.7", "linux-x64-gnu", pkg], ["v9.8.7", "linux-arm64-gnu", pkg]]) {
    const refused = spawnSync(process.execPath, ["scripts/berth/build-release.ts", ...args, path.join(dir, "x"), "https://example.test/", keyPath], { cwd: root });
    assert.notEqual(refused.status, 0, `refused: ${args.join(" ")}`);
  }

  // verify-release.ts over berth and keel manifests and SHA256SUMS.
  const keelBuild = path.join(dir, "keel-build");
  const listing = `keel base for x86_64\n${sha("agent")}  ./sbin/cube-agent\n${sha("init")}  ./sbin/cube-init\n`;
  for (const [file, data] of Object.entries({ vmlinuz: "kernel", "base.erofs": "base", "base.txt": listing,
    "keys.txt": `kernel ${"1".repeat(64)}\nbase ${"2".repeat(64)}\n` })) write(path.join(keelBuild, file), data);
  execFileSync(process.execPath, ["scripts/keel/build-release.ts", "v9.8.7", "x86_64", keelBuild, release, "https://example.test/dl/v9.8.7/", keyPath], { cwd: root });
  execFileSync("bash", ["scripts/cubed/write-checksums.sh", release], { cwd: root });
  const fingerprint = publicKeyFingerprint(publicPem);
  const good = verifyRelease(release, publicPem, fingerprint);
  assert.deepEqual(good, { ok: true, fingerprint,
    berth: [{ platform: "linux-x64-gnu", version: "0.1.0", release: "v9.8.7", commit, sha256: sha("bundle bytes") }],
    keel: [{ arch: "x86_64", release: "v9.8.7", commit, kernel: sha("kernel"), base: sha("base"), cubeAgent: sha("agent") }] });
  // The command line uses the repository's pinned key: this test key is not it.
  const cli = spawnSync(process.execPath, ["scripts/berth/verify-release.ts", release], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /"ok":false.*signature does not verify/);
  const tamper = (name: string, change: (dir: string) => void, error: RegExp) => {
    const copy = path.join(dir, `tampered-${name}`);
    fs.cpSync(release, copy, { recursive: true });
    change(copy);
    assert.throws(() => verifyRelease(copy, publicPem, fingerprint), error, name);
  };
  tamper("asset", d => fs.appendFileSync(path.join(d, "berth-v9.8.7-linux-x64-gnu.tar.gz"), "!"), /SHA256SUMS: berth-v9\.8\.7-linux-x64-gnu\.tar\.gz/);
  tamper("asset-and-sums", d => {
    fs.appendFileSync(path.join(d, "keel-v9.8.7-x86_64-base.erofs"), "!");
    execFileSync("bash", ["scripts/cubed/write-checksums.sh", d], { cwd: root });
  }, /keel-x86_64\.json base: keel-v9\.8\.7-x86_64-base\.erofs does not match/);
  tamper("manifest", d => {
    const file = path.join(d, "berth-linux-x64-gnu.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"0.1.0"', '"0.1.1"'));
    execFileSync("bash", ["scripts/cubed/write-checksums.sh", d], { cwd: root });
  }, /berth-linux-x64-gnu\.json: the signature does not verify/);
  tamper("unlisted", d => fs.writeFileSync(path.join(d, "SHA256SUMS"),
    fs.readFileSync(path.join(d, "SHA256SUMS"), "utf8").split("\n").filter(line => !line.endsWith(" keel-x86_64.json.sig")).join("\n")),
  /keel-x86_64\.json\.sig is not in SHA256SUMS/);
  assert.throws(() => verifyRelease(release, publicPem, `SHA256:${"0".repeat(64)}`), /committed fingerprint/);

  // package.sh with a stub binary, then install-berth.sh from that bundle.
  const stub = `#!/bin/bash
# A stand-in for berth: \`version\`, and \`vm\` up to its banner (until SIGTERM).
case "$1" in
version) echo '{"protocolVersion":4,"softwareVersion":"0.1.0"}'; exit 0 ;;
vm) shift ;;
*) exit 2 ;;
esac
echo "$*" >>"$STUB_LOG"
while [ $# -gt 0 ]; do case "$1" in --dir) d=$2 ;; --keel) k=$2 ;; --accel) a=$2 ;; esac; shift 2; done
# berth's rule (packages/berth/src/vm/mod.rs): <dir>/<16-hex id>/qmp.sock within 100 bytes.
real=$(cd "$d" && pwd -P)
echo "resolved $real" >>"$STUB_LOG"
if [ $((\${#real} + 26)) -gt 100 ]; then echo "Error: --dir $d is too long: a machine's sockets must fit 100 bytes" >&2; exit 1; fi
[ -d "$d/images" ] && echo "seeded $d" >>"$STUB_LOG"
h() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
echo "berth 0.1.0 vm (runner protocol 4)" >&2
if [ "\${STUB_FLOOR:-}" = low ]; then echo "qemu: 8.2.2 /q (below keel's floor)" >&2; else echo "qemu: 11.1.2 /q (meets keel's floor; new machines get pc-q35-11.1)" >&2; fi
echo "accelerator: $a, guest x86_64" >&2
echo "keel: $k (vmlinuz $(h "$k/vmlinuz"), base.erofs $(h "$k/base.erofs"))" >&2
echo "waiting for cubed; Ctrl-C stops the runner" >&2
trap 'exit 0' TERM
while :; do sleep 1; done
`;
  const target = path.join(dir, "target");
  write(path.join(target, "release", "berth"), stub, 0o755);
  let bundle: string;
  if (platform) {
    const out = path.join(dir, "out");
    execFileSync("bash", ["scripts/berth/package.sh", "test", platform, out], { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: "pipe" });
    assert.deepEqual(fs.readdirSync(out).sort(), [`berth-test-${platform}.tar.gz`, "provenance.txt", "version.json"]);
    assert.match(fs.readFileSync(path.join(out, "provenance.txt"), "utf8"), new RegExp(`^commit ${commit}\\nplatform ${platform} `));
    execFileSync("tar", ["-xzf", path.join(out, `berth-test-${platform}.tar.gz`), "-C", dir]);
    bundle = path.join(dir, `berth-test-${platform}`);
    const files = execFileSync("find", [".", "-type", "f"], { cwd: bundle, encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(files, ["./LICENSE", "./bin/berth", "./share/berth/README.md", "./share/berth/berth-vm.service.in",
      "./share/berth/dev.cube.berth-vm.plist.in", "./share/berth/install-berth.sh"]);
    assert.match(fs.readFileSync(path.join(bundle, "share/berth/README.md"), "utf8"), /^## Install from a release\n/);
    assert.doesNotMatch(fs.readFileSync(path.join(bundle, "share/berth/README.md"), "utf8"), /^## `berth image pull`/m);
  } else {
    bundle = path.join(dir, "bundle");
    write(path.join(bundle, "bin/berth"), stub, 0o755);
    for (const f of ["install-berth.sh", "berth-vm.service.in", "dev.cube.berth-vm.plist.in"]) {
      fs.cpSync(path.join(root, "scripts/berth", f), path.join(bundle, "share/berth", f));
    }
  }
  const tools = path.join(dir, "tools");
  for (const t of ["qemu-system-x86_64", "qemu-img", "mkfs.erofs"]) write(path.join(tools, t), "#!/bin/sh\nexit 0\n", 0o755);
  const keel = path.join(dir, "keel");
  write(path.join(keel, "vmlinuz"), "kernel");
  write(path.join(keel, "base.erofs"), "base");
  // systemctl, launchctl and cubed fail and leave a mark if anything calls them.
  const forbidden = path.join(dir, "forbidden");
  const called = path.join(dir, "called");
  for (const t of ["systemctl", "launchctl", "cubed"]) write(path.join(forbidden, t), `#!/bin/sh\necho ${t} >>'${called}'\nexit 97\n`, 0o755);
  const stubLog = path.join(dir, "stub.log");
  const peer = "a".repeat(64);
  const image = `docker.io/library/debian@sha256:${"b".repeat(64)}`;
  const prefix = path.join(dir, "prefix");
  const units = path.join(dir, "units");
  const args = (name: string, kind: string, extra: string[] = []) => ["--prefix", prefix, "--dir", path.join(dir, "state"), "--keel", keel,
    "--qemu", path.join(tools, "qemu-system-x86_64"), "--qemu-img", path.join(tools, "qemu-img"), "--mkfs-erofs", path.join(tools, "mkfs.erofs"),
    "--image", image, "--network", "loopback", "--listen", "127.0.0.1:7826", "--node-id", "node-b2-test", "--allow-peer", peer,
    "--max-machines", "1", "--unit-dir", units, "--unit-name", name, "--kind", kind, ...extra];
  const install = (a: string[], env: Record<string, string> = {}) => spawnSync(bash, [path.join(bundle, "share/berth/install-berth.sh"), ...a], {
    encoding: "utf8", env: { ...process.env, PATH: `${forbidden}:${process.env.PATH}`, STUB_LOG: stubLog, TMPDIR: dir, ...env },
  });
  const accel = process.platform === "darwin" ? "hvf" : "kvm";

  const relative = install(args("b2-rel", "systemd").map(a => a === keel ? "keel" : a));
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /--keel must be an absolute path: keel/);
  const low = install(args("b2-low", "systemd"), { STUB_FLOOR: "low" });
  assert.equal(low.status, 1, low.stderr);
  assert.match(low.stderr, /QEMU does not meet keel's floor/);
  assert.ok(!fs.existsSync(prefix) && !fs.existsSync(units), "nothing is written when the check fails");

  const first = install(args("b2-fix-berth", "systemd"));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /check passed/);
  assert.match(first.stdout, /the check pulls .* into a throwaway directory/);
  assert.match(first.stdout, /Nothing was started, loaded or enrolled/);
  const lastCheck = () => fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(line => line.startsWith("--dir ")).at(-1)!;
  const checkRun = lastCheck();
  // The check directory is under /tmp, not TMPDIR (which install() sets to the test's directory).
  assert.match(checkRun, new RegExp(`^--dir /tmp/install-berth\\.[A-Za-z0-9]+/dir .* --accel ${accel} --network loopback --listen 127\\.0\\.0\\.1:0 .* --node-id node-install-check --max-machines 1$`));
  assert.ok(!fs.existsSync(path.dirname(checkRun.split(" ")[1]!)), "the throwaway directory is removed");
  const berth = path.join(prefix, "libexec/berth-0.1.0/berth");
  assert.equal(fs.readFileSync(berth, "utf8"), stub);
  const start = path.join(prefix, "bin/start-b2-fix-berth.sh");
  assert.equal(fs.readFileSync(start, "utf8"), `#!/bin/sh
# berth 0.1.0 vm b2-fix-berth, written by install-berth.sh. Every path is absolute.
exec ${berth} vm --dir ${dir}/state \\
  --qemu ${tools}/qemu-system-x86_64 --qemu-img ${tools}/qemu-img \\
  --keel ${keel} --mkfs-erofs ${tools}/mkfs.erofs --accel ${accel} \\
  --image ${image} \\
  --network loopback --listen 127.0.0.1:7826 \\
  --allow-peer ${peer} \\
  --node-id node-b2-test --max-machines 1
`);
  assert.equal(fs.statSync(start).mode & 0o777, 0o755);
  const unit = fs.readFileSync(path.join(units, "b2-fix-berth.service"), "utf8");
  for (const line of [`ExecStart=${start}`, `WorkingDirectory=${prefix}`, "KillSignal=SIGINT", `StandardError=append:${prefix}/log/b2-fix-berth.log`, "WantedBy=default.target"]) {
    assert.ok(unit.split("\n").includes(line), `unit has ${line}`);
  }
  assert.doesNotMatch(unit, /@[A-Z]+@/);
  assert.ok(!fs.existsSync(path.join(dir, "state")), "the runner's --dir is not made by the installer");

  // Again with the same arguments: refused, nothing changed.
  const before = fs.readFileSync(start);
  const again = install(args("b2-fix-berth", "systemd"));
  assert.equal(again.status, 2);
  assert.match(again.stderr, /refusing to overwrite .*start-b2-fix-berth\.sh/);
  assert.deepEqual(fs.readFileSync(start), before);

  // launchd, with the image seeded from a berth directory that has it.
  const seed = path.join(dir, "seed");
  write(path.join(seed, "images", "sha256:x.json"), "{}");
  write(path.join(seed, "layers", "1", "x.erofs"), "layer");
  const agent = install(args("b2-mac", "launchd", ["--seed-from", seed]));
  assert.equal(agent.status, 0, agent.stdout + agent.stderr);
  assert.match(agent.stdout, /the check uses the image in .*seed/);
  assert.match(fs.readFileSync(stubLog, "utf8"), /^seeded .*install-berth\.[A-Za-z0-9]+\/dir$/m);
  const plist = fs.readFileSync(path.join(units, "dev.cube.b2-mac.plist"), "utf8");
  assert.match(plist, /<key>Label<\/key>\n {2}<string>dev\.cube\.b2-mac<\/string>/);
  assert.match(plist, new RegExp(`<array>\\n {4}<string>${prefix}/bin/start-b2-mac\\.sh</string>\\n {2}</array>`));
  assert.doesNotMatch(plist, /@[A-Z]+@/);
  if (process.platform === "darwin") execFileSync("plutil", ["-lint", path.join(units, "dev.cube.b2-mac.plist")]);
  const agentAgain = install(args("b2-mac2", "launchd", ["--seed-from", seed]).map(a => a === "b2-mac2" ? "b2-mac" : a));
  assert.equal(agentAgain.status, 2);

  // A different berth already at the version's path is never replaced.
  fs.chmodSync(berth, 0o755);
  fs.appendFileSync(berth, "# changed\n");
  const replace = install(args("b2-other", "systemd"));
  assert.equal(replace.status, 2);
  assert.match(replace.stderr, /refusing to replace .*berth-0\.1\.0\/berth/);

  for (const bad of [["--allow-peer", "abc"], ["--max-machines", "0"], ["--image", "debian:trixie"], ["--network", "wifi"], ["--unit-name", "Bad Name"]]) {
    const r = install(args("b2-bad", "systemd").map((a, i, all) => all[i - 1] === bad[0] ? bad[1]! : a));
    assert.equal(r.status, 1, `${bad.join(" ")}: ${r.stderr}`);
  }
  // R1: a long TMPDIR (macOS's per-user one is too long for berth's socket rule) does not reach berth.
  let longTmp = path.join(dir, "t");
  while (fs.realpathSync(dir).length + (longTmp.length - dir.length) < 125) longTmp = path.join(longTmp, "a-long-temporary-directory");
  fs.mkdirSync(longTmp, { recursive: true });
  assert.ok(fs.realpathSync(longTmp).length >= 120);
  const r1Root = path.join(dir, "r1");
  const r1 = install(args("b2-r1", "systemd").map(a => a === prefix ? path.join(r1Root, "prefix") : a === units ? path.join(r1Root, "units") : a), { TMPDIR: longTmp });
  assert.equal(r1.status, 0, `R1 with TMPDIR of ${fs.realpathSync(longTmp).length} bytes: ${r1.stderr}`);
  const r1Dir = lastCheck().split(" ")[1]!;
  const resolved = fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(line => line.startsWith("resolved ")).at(-1)!.slice("resolved ".length);
  assert.ok(r1Dir.startsWith("/tmp/install-berth.") && resolved.startsWith(`${fs.realpathSync("/tmp")}/install-berth.`), `${r1Dir} -> ${resolved}`);
  assert.ok(resolved.length + 26 <= 100, `${resolved} is ${resolved.length} bytes`);

  // R2: an operator --dir too long for berth's sockets: refused before any write.
  const r2Root = path.join(dir, "r2");
  let longDir = path.join(r2Root, "state");
  while (fs.realpathSync(dir).length + (longDir.length - dir.length) + 26 <= 100) longDir = path.join(longDir, "berth-state-directory");
  const r2 = install(args("b2-r2", "systemd").map(a => a === path.join(dir, "state") ? longDir : a === prefix ? path.join(r2Root, "prefix") : a === units ? path.join(r2Root, "units") : a));
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, /--dir .* is too long: berth needs <dir>\/<16-hex machine id>\/qmp\.sock within 100 bytes/);
  assert.ok(!fs.existsSync(r2Root), "R2 writes nothing (no prefix, unit directory, libexec or --dir)");

  // R3: the installer's numbers are berth's.
  const vmSource = fs.readFileSync(path.join(root, "packages/berth/src/vm/mod.rs"), "utf8");
  assert.match(vmSource, /const MAX_SOCKET_PATH: usize = 100;/);
  assert.match(vmSource, /options\.directory\.as_os_str\(\)\.len\(\) \+ 1 \+ 16 \+ 1 \+ qemu::QMP_SOCKET\.len\(\)\s*<= MAX_SOCKET_PATH/);
  assert.match(fs.readFileSync(path.join(root, "packages/berth/src/vm/qemu.rs"), "utf8"), /pub const QMP_SOCKET: &str = "qmp\.sock";/);
  const installer = fs.readFileSync(path.join(root, "scripts/berth/install-berth.sh"), "utf8");
  assert.match(installer, /^socket_max=100$/m);
  assert.match(installer, new RegExp(`^socket_tail=${1 + 16 + 1 + "qmp.sock".length} `, "m"));

  assert.ok(!fs.existsSync(called), `systemctl, launchctl or cubed was called: ${fs.existsSync(called) ? fs.readFileSync(called, "utf8") : ""}`);
  console.log(`berth-release-test: signed manifest, protocol-3 build refused; verify-release passes and fails each tampering; ${platform ? "package.sh bundle; " : ""}install-berth.sh (${bash}) checks before writing, writes start script, unit and plist, refuses relative paths, overwrites and a replaced binary, never calls systemctl, launchctl or cubed; the check directory stays under /tmp with a long TMPDIR (R1), a --dir too long for berth's sockets is refused before any write (R2), and the 100-byte rule is berth's (R3)`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
