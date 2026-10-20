/** The Homebrew formula generator: formulas come only from manifests the
 * release key signed (cubed, berth and keel), of one stable tag and one
 * commit, pinned to that tag's assets. The launchers they write run here
 * with their Ruby interpolations filled in. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { berthFormula, cubeFormula, readFormulaInputs } from "./homebrew/formula.ts";
import { portalSettings } from "../packages/server/src/portal.ts";
import { readBerthSettings } from "../packages/server/src/runner-enroll.ts";
import { publicKeyFingerprint } from "./cubed/verify-signing-key.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-homebrew-"));
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string);
  const fingerprint = publicKeyFingerprint(publicPem);
  const other = generateKeyPairSync("ed25519").privateKey;
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const base = "https://github.com/cubeyard/cube/releases/download/v9.8.7";
  const cubed = (patch: Record<string, unknown> = {}) => ({ schema: 1, product: "cubed", version: "v9.8.7", commit, platform: "darwin-arm64",
    minimumSupervisor: 1, stateSchema: { minimum: 102, maximum: 102, rollbackSafeFrom: 102 },
    artifact: { url: `${base}/cubed-v9.8.7-darwin-arm64.tar.gz`, sha256: "a".repeat(64), bytes: 1234 }, publishedAt: "2026-10-08T00:00:00Z",
    notesUrl: "https://github.com/cubeyard/cube/releases/tag/v9.8.7", includesRunner: false, ...patch });
  const berth = (patch: Record<string, unknown> = {}) => ({ schema: 1, product: "berth", version: "0.1.0", release: "v9.8.7", commit,
    platform: "darwin-arm64", protocolVersion: 4, artifact: { url: `${base}/berth-v9.8.7-darwin-arm64.tar.gz`, sha256: "b".repeat(64), bytes: 99 }, ...patch });
  const keel = (patch: Record<string, unknown> = {}) => ({ schema: 1, product: "keel", release: "v9.8.7", commit, arch: "arm64",
    kernel: { version: "7.2.9", url: `${base}/keel-v9.8.7-arm64-vmlinuz`, sha256: "d".repeat(64), bytes: 10 },
    base: { url: `${base}/keel-v9.8.7-arm64-base.erofs`, sha256: "e".repeat(64), bytes: 20,
      listing: { url: `${base}/keel-v9.8.7-arm64-base.txt`, sha256: "f".repeat(64), bytes: 30 } },
    cacheKeys: { kernel: "1".repeat(64), base: "2".repeat(64) }, ...patch });
  let n = 0;
  /** A release directory: each manifest signed by `signer`; `broken` names
   * the one whose signature has a flipped character. */
  const assets = (manifests: { cubed?: object; berth?: object; keel?: object } = {}, signer = privateKey, broken?: "cubed" | "berth" | "keel") => {
    const directory = path.join(root, `assets-${n++}`);
    fs.mkdirSync(directory);
    for (const [product, name, manifest] of [["cubed", "cubed-darwin-arm64.json", manifests.cubed ?? cubed()],
      ["berth", "berth-darwin-arm64.json", manifests.berth ?? berth()], ["keel", "keel-arm64.json", manifests.keel ?? keel()]] as const) {
      const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      fs.writeFileSync(path.join(directory, name), bytes);
      const signature = sign(null, bytes, signer).toString("base64");
      fs.writeFileSync(path.join(directory, `${name}.sig`), `${broken === product ? signature.replace(/^./, c => c === "A" ? "B" : "A") : signature}\n`);
    }
    return directory;
  };

  const inputs = readFormulaInputs("v9.8.7", assets(), publicPem, fingerprint);
  const cube = cubeFormula(inputs);
  const cubeBerth = berthFormula(inputs);
  assert.match(cube, /^class Cube < Formula$/m);
  assert.match(cube, new RegExp(`url "${base}/cubed-v9.8.7-darwin-arm64.tar.gz"`));
  assert.match(cube, /sha256 "a{64}"/);
  assert.match(cube, /depends_on arch: :arm64/);
  assert.match(cube, /CUBED_VERSION="v9\.8\.7" CUBED_COMMIT="0123456789abcdef0123456789abcdef01234567"/);
  assert.match(cube, /depends_on "cubeyard\/tap\/cube-berth"/);
  assert.doesNotMatch(cube, /cube-runner"|CUBE_RUNNER/, "nothing of the protocol-3 runner is installed or set");
  assert.match(cube, /cubed runners init-local --image <registry\/repository@sha256:\.\.\.>\n\s+brew services restart cubeyard\/tap\/cube-berth cubeyard\/tap\/cube\n/,
    "one sequence for a first install, an upgrade and a reinstall; restart also replaces a process brew uninstall left running");
  assert.match(cube, /Dir\.glob\(libexec\/"app\/\*\*\/native\/\*\/prebuilds\/\*", File::FNM_DOTMATCH\)/, "other platforms' prebuilt native modules are pruned, under node_modules/.pnpm too");
  assert.match(cube, /name\.start_with\?\("darwin-"\) && name\.include\?\("arm64"\)/, "every darwin arm64 build stays");
  assert.match(cube, /^  skip_clean "libexec"$/m, "Homebrew's cleaner does not walk the bundle's files");
  assert.match(cube, /^    ohai "cube: files in place; Homebrew checks them next \(quiet without --verbose\)"\n  end\n\n  service do$/m,
    "the last step of install says what the silent part after it is");
  assert.ok(/ohai "([^"]*)"/.exec(cube)![1]!.length <= 76, "the line fits an 80-column terminal after ==>, so Homebrew does not cut it");
  assert.match(cube, /shell_output\("#\{bin\}\/cubed --self-check"\)/, "the self-check runs through the launcher, which sets the version");
  assert.match(cube, /stop_timeout 60/);
  assert.match(cubeBerth, /^class CubeBerth < Formula$/m);
  assert.match(cubeBerth, /\(berth 0\.1\.0\)/, "berth's own version is named");
  for (const text of [cube, cubeBerth]) {
    assert.doesNotMatch(text, /^\s*version "/m, "both formulas take the release tag from their URL, so every release upgrades both");
    assert.doesNotMatch(text, /restart_delay/);
    assert.doesNotMatch(text, /latest\//, "never a moving URL");
    assert.doesNotMatch(text, /#\$|#@/, "no accidental Ruby interpolation in the generated text");
    for (const line of /<<~EOS\n([^]*?)\n {4}EOS/.exec(text)![1]!.split("\n")) assert.ok(line.length <= 6 + 76, `caveats fit 80 columns: ${line}`);
  }
  assert.match(cubeBerth, new RegExp(`url "${base}/berth-v9.8.7-darwin-arm64.tar.gz"\n  sha256 "b{64}"`));
  assert.match(cubeBerth, new RegExp(`resource "keel-vmlinuz" do\n    url "${base}/keel-v9.8.7-arm64-vmlinuz"\n    sha256 "d{64}"`));
  assert.match(cubeBerth, new RegExp(`resource "keel-base" do\n    url "${base}/keel-v9.8.7-arm64-base.erofs"\n    sha256 "e{64}"`));
  assert.match(cubeBerth, /install "keel-v9\.8\.7-arm64-vmlinuz" => "vmlinuz"/);
  assert.match(cubeBerth, /install "keel-v9\.8\.7-arm64-base\.erofs" => "base\.erofs"/);
  assert.match(cubeBerth, /vmlinuz = Digest::SHA256\.file\(libexec\/"keel\/vmlinuz"\)\.hexdigest\n\s+assert_equal "d{64}", vmlinuz/, "brew test checks the installed keel");
  assert.match(cubeBerth, /base = Digest::SHA256\.file\(libexec\/"keel\/base\.erofs"\)\.hexdigest\n\s+assert_equal "e{64}", base/);
  for (const text of [cube, cubeBerth]) for (const line of text.split("\n")) assert.ok(line.length <= 118, `within Homebrew's line length: ${line}`);
  for (const dependency of ["qemu", "erofs-utils"]) assert.match(cubeBerth, new RegExp(`depends_on "${dependency}"`));
  assert.match(cubeBerth, /depends_on arch: :arm64/);
  assert.match(cubeBerth, /run \[opt_libexec\/"service\.sh"\]/);
  assert.match(cubeBerth, /stop_timeout 120/, "berth stops its machines' QEMUs on SIGTERM before it exits");
  // cubed's launcher names the programs and keel the service uses.
  for (const [variable, file] of [["CUBE_BERTH", "opt/cube-berth/bin/berth"], ["CUBE_BERTH_KEEL", "opt/cube-berth/libexec/keel"],
    ["CUBE_BERTH_QEMU", "opt/qemu/bin/qemu-system-aarch64"], ["CUBE_BERTH_QEMU_IMG", "opt/qemu/bin/qemu-img"],
    ["CUBE_BERTH_MKFS_EROFS", "opt/erofs-utils/bin/mkfs.erofs"]] as const) {
    assert.ok(cube.includes(`export ${variable}="\${${variable}:-#{HOMEBREW_PREFIX}/${file}}"`), variable);
  }

  // The service script, run as launchd would (Ruby's interpolations filled
  // in, berth replaced by printing its arguments): not set up, it says so
  // and exits 78 after its pause; set up, it starts berth vm with berth.env's
  // image, slots and listen address and the same files as cubed's launcher.
  const service = /\(libexec\/"service\.sh"\)\.write <<~SH\n([^]*?)\n {4}SH\n/.exec(cubeBerth)![1]!.replace(/^ {6}/gm, "")
    .replaceAll('"#{opt_bin}/berth"', "echo berth").replaceAll('#{formula_opt_bin("qemu")}', `${root}/opt/qemu/bin`)
    .replaceAll('#{formula_opt_bin("erofs-utils")}', `${root}/opt/erofs-utils/bin`).replaceAll("#{opt_libexec}", `${root}/opt/cube-berth/libexec`)
    .replaceAll("\\\\", "\\");
  assert.doesNotMatch(service, /#\{/, "every interpolation is filled in");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const serve = () => spawnSync("/bin/sh", ["-c", `sleep() { :; }\n${service}`], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  const unset = serve();
  assert.equal(unset.status, 78, unset.stderr);
  assert.match(unset.stderr, /cube-berth: not set up yet: run cubed runners init-local --image/);
  fs.mkdirSync(path.join(home, ".cube/berth/.berth"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cube/berth/.berth/vm.json"), "{}");
  const image = `docker.io/library/debian@sha256:${"c".repeat(64)}`;
  const settings = `# Written once by \`cubed runners init-local\`\nCUBE_BERTH_IMAGE=${image}\nCUBE_BERTH_MAX_MACHINES=2\nCUBE_BERTH_LISTEN=127.0.0.1:7781\n`;
  fs.writeFileSync(path.join(home, ".cube/berth.env"), settings);
  // A first init-local that has not got berth listening wrote no berth.json:
  // the service must not take the directory from the next run.
  const half = serve();
  assert.equal(half.status, 78, half.stderr);
  assert.match(half.stderr, /cube-berth: not set up yet/);
  assert.equal(half.stdout, "", "berth is not started without berth.json");
  fs.writeFileSync(path.join(home, ".cube/berth.json"), "{}");
  // A berth.env without the address berth listened on: never a start on
  // vm.json's, which may be one an earlier failed run tried.
  fs.writeFileSync(path.join(home, ".cube/berth.env"), settings.replace(/^CUBE_BERTH_LISTEN=.*\n/m, ""));
  const partial = serve();
  assert.equal(partial.status, 78, partial.stderr);
  assert.match(partial.stderr, /berth\.env lacks CUBE_BERTH_IMAGE, CUBE_BERTH_MAX_MACHINES or CUBE_BERTH_LISTEN/);
  assert.equal(partial.stdout, "", "berth is not started without its address");
  fs.writeFileSync(path.join(home, ".cube/berth.env"), settings);
  const started = serve();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout.trim(), `berth vm --dir ${home}/.cube/berth --qemu ${root}/opt/qemu/bin/qemu-system-aarch64 --qemu-img ${root}/opt/qemu/bin/qemu-img`
    + ` --mkfs-erofs ${root}/opt/erofs-utils/bin/mkfs.erofs --keel ${root}/opt/cube-berth/libexec/keel --image ${image} --max-machines 2 --listen 127.0.0.1:7781`);
  assert.deepEqual(readBerthSettings(settings), { image, maxMachines: 2, listen: "127.0.0.1:7781" }, "what the service reads is what cubed reads");

  // cubed's launcher, run as the service would (cubed replaced by printing
  // its environment): the portal is on loopback under *.localhost unless the
  // operator's environment file says otherwise.
  const launcher = /\(bin\/"cubed"\)\.write <<~SH\n([^]*?)\n {4}SH\n/.exec(cube)![1]!.replace(/^ {6}/gm, "")
    .replaceAll("#{HOMEBREW_PREFIX}", root).replace(/^exec "#\{libexec\}\/bin\/node" .*$/m, "exec env");
  const launched = (environment: string | null) => {
    const config = path.join(root, `environment-${n++}`);
    if (environment !== null) fs.writeFileSync(config, environment);
    const run = spawnSync("/bin/sh", ["-c", launcher], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", CUBED_CONFIG_FILE: config } });
    assert.equal(run.status, 0, run.stderr);
    return Object.fromEntries(run.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  };
  const portal = (environment: string | null) => {
    const env = launched(environment);
    return { env: Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("CUBED_PORTAL_"))), settings: portalSettings(env) };
  };
  assert.deepEqual(portal(null), { env: { CUBED_PORTAL_IP: "127.0.0.1", CUBED_PORTAL_DOMAIN: "localhost" },
    settings: { ip: "127.0.0.1", port: 7780, listen: "127.0.0.1", domain: "localhost", suffix: "localhost" } }, "no environment file: a loopback portal");
  assert.deepEqual(portal("CUBED_HOST=127.0.0.1\nCUBED_PORTAL_PORT=7790\n").settings,
    { ip: "127.0.0.1", port: 7790, listen: "127.0.0.1", domain: "localhost", suffix: "localhost" }, "other settings keep the default, a port of the operator's too");
  assert.deepEqual(portal("CUBED_PORTAL_IP=100.101.102.103\n"), { env: { CUBED_PORTAL_IP: "100.101.102.103" },
    settings: { ip: "100.101.102.103", port: 7780, listen: "100.101.102.103", domain: "sslip.io", suffix: "100-101-102-103.sslip.io" } }, "a Tailscale IP is kept as it is");
  assert.deepEqual(portal("CUBED_PORTAL_IP=\n"), { env: { CUBED_PORTAL_IP: "" }, settings: null }, "an empty CUBED_PORTAL_IP turns the portal off");
  assert.deepEqual(portal("CUBED_PORTAL_DOMAIN=cube.example.ts.net\n"), { env: { CUBED_PORTAL_DOMAIN: "cube.example.ts.net" }, settings: null },
    "a partial portal configuration of the operator's is not completed with defaults");
  const env = launched(null);
  assert.equal(env.CUBED_VERSION, "v9.8.7");
  assert.equal(env.CUBE_BERTH, `${root}/opt/cube-berth/bin/berth`);
  assert.equal(env.CUBE_BERTH_KEEL, `${root}/opt/cube-berth/libexec/keel`);
  assert.equal(launched("CUBE_BERTH_KEEL=/elsewhere/keel\n").CUBE_BERTH_KEEL, "/elsewhere/keel", "the operator's paths win");

  const refused = (name: string, directory: string, pattern: RegExp, tag = "v9.8.7") =>
    assert.throws(() => readFormulaInputs(tag, directory, publicPem, fingerprint), pattern, name);
  refused("another key", assets({}, other), /signature verification failed/);
  for (const product of ["cubed", "berth", "keel"] as const) refused(`a changed signature of ${product}'s`, assets({}, privateKey, product), /signature verification failed/);
  refused("another tag's manifests", assets(), /not a cubed darwin-arm64 manifest of v9.8.8/, "v9.8.8");
  refused("a prerelease tag", assets(), /stable tag/, "v9.8.7-rc1");
  refused("a moving artifact URL", assets({ cubed: cubed({ artifact: { url: "https://github.com/cubeyard/cube/releases/latest/download/cubed-darwin-arm64.tar.gz", sha256: "a".repeat(64), bytes: 1 } }) }), /not a cubed/);
  refused("an asset URL with anything but the release's asset name", assets({ cubed: cubed({ artifact: { url: `${base}/cubed-v9.8.7-darwin-arm64.tar.gz"#{x}`, sha256: "a".repeat(64), bytes: 1 } }) }), /not a cubed/);
  refused("a Linux manifest", assets({ cubed: cubed({ platform: "linux-x64-gnu" }) }), /not a cubed darwin-arm64/);
  refused("a bundle that claims to include the runner", assets({ cubed: cubed({ includesRunner: true }) }), /release contract/);
  refused("another state schema", assets({ cubed: cubed({ stateSchema: { minimum: 103, maximum: 103, rollbackSafeFrom: 103 } }) }), /release contract/);
  refused("a Linux berth", assets({ berth: berth({ platform: "linux-x64-gnu", artifact: { url: `${base}/berth-v9.8.7-linux-x64-gnu.tar.gz`, sha256: "b".repeat(64), bytes: 9 } }) }), /not a berth darwin-arm64/);
  refused("a berth that is not protocol 4", assets({ berth: berth({ protocolVersion: 3 }) }), /berth release contract/);
  refused("a berth of another release", assets({ berth: berth({ release: "v9.8.6" }) }), /berth release contract/);
  refused("an x86_64 keel", assets({ keel: keel({ arch: "x86_64" }) }), /not a keel arm64/);
  refused("a keel base from elsewhere", assets({ keel: keel({ base: { url: "https://example.com/base.erofs", sha256: "e".repeat(64), bytes: 1 } }) }), /not a keel arm64/);
  refused("a keel kernel without a digest", assets({ keel: keel({ kernel: { url: `${base}/keel-v9.8.7-arm64-vmlinuz`, sha256: "x", bytes: 1 } }) }), /not a keel arm64/);
  refused("a keel of another release", assets({ keel: keel({ release: "v9.8.6" }) }), /keel release contract/);
  refused("berth of another commit", assets({ berth: berth({ commit: "f".repeat(40) }) }), /different commits/);
  refused("keel of another commit", assets({ keel: keel({ commit: "f".repeat(40) }) }), /different commits/);
  assert.throws(() => readFormulaInputs("v9.8.7", assets(), publicPem, "SHA256:" + "0".repeat(64)), /committed fingerprint/);

  // The CLI, with the committed key: these manifests are not signed by it.
  const cli = spawnSync(process.execPath, ["scripts/homebrew/formula.ts", "v9.8.7", "--assets", assets(), "--out", path.join(root, "out")], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /signature verification failed/);
  assert.ok(!fs.existsSync(path.join(root, "out/cube.rb")), "nothing is written for refused inputs");
  console.log("ok: homebrew formulas (cube, cube-berth with keel) are generated only from signed manifests of one stable release, pinned to its assets");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
