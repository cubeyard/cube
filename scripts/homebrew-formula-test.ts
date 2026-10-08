/** The Homebrew formula generator: formulas come only from manifests the
 * release key signed, of one stable tag, pinned to that tag's assets. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cubeFormula, readFormulaInputs, runnerFormula } from "./homebrew/formula.ts";
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
  const runner = (patch: Record<string, unknown> = {}) => ({ schema: 1, product: "cube-runner", version: "1.2.3", release: "v9.8.7", commit,
    platform: "darwin-arm64", protocolVersion: 3, artifact: { url: `${base}/cube-runner-v9.8.7-darwin-arm64.tar.gz`, sha256: "b".repeat(64), bytes: 99 }, ...patch });
  let n = 0;
  const assets = (cubedManifest: Record<string, unknown>, runnerManifest: Record<string, unknown>, signer = privateKey, breakRunnerSignature = false) => {
    const directory = path.join(root, `assets-${n++}`);
    fs.mkdirSync(directory);
    for (const [name, manifest, broken] of [["cubed-darwin-arm64.json", cubedManifest, false], ["cube-runner-darwin-arm64.json", runnerManifest, breakRunnerSignature]] as const) {
      const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      fs.writeFileSync(path.join(directory, name), bytes);
      const signature = sign(null, bytes, signer).toString("base64");
      fs.writeFileSync(path.join(directory, `${name}.sig`), `${broken ? signature.replace(/^./, c => c === "A" ? "B" : "A") : signature}\n`);
    }
    return directory;
  };

  const inputs = readFormulaInputs("v9.8.7", assets(cubed(), runner()), publicPem, fingerprint);
  const cube = cubeFormula(inputs);
  const cubeRunner = runnerFormula(inputs);
  assert.match(cube, /^class Cube < Formula$/m);
  assert.match(cube, new RegExp(`url "${base}/cubed-v9.8.7-darwin-arm64.tar.gz"`));
  assert.match(cube, /sha256 "a{64}"/);
  assert.match(cube, /depends_on arch: :arm64/);
  assert.match(cube, /CUBED_VERSION="v9\.8\.7" CUBED_COMMIT="0123456789abcdef0123456789abcdef01234567"/);
  assert.match(cube, /depends_on "cubeyard\/tap\/cube-runner"/);
  assert.match(cube, /shell_output\("#\{bin\}\/cubed --self-check"\)/, "the self-check runs through the launcher, which sets the version");
  assert.match(cubeRunner, /^class CubeRunner < Formula$/m);
  assert.match(cubeRunner, /cube-runner 1\.2\.3/, "the runner's own version is named");
  for (const text of [cube, cubeRunner]) {
    assert.doesNotMatch(text, /^\s*version "/m, "both formulas take the release tag from their URL, so every release upgrades both");
    assert.match(text, /stop_timeout 60/);
    assert.doesNotMatch(text, /restart_delay/);
  }
  assert.match(cubeRunner, /sha256 "b{64}"/);
  assert.match(cubeRunner, /depends_on "qemu"/);
  assert.match(cubeRunner, /run \[opt_libexec\/"service.sh"\]/);
  assert.match(cubeRunner, /cube-runner" run --home "\$\{CUBE_RUNNER_HOME:-\$HOME\/.cube\/runner\}"/, "the home is the starting user's, resolved at start");
  for (const text of [cube, cubeRunner]) {
    assert.doesNotMatch(text, /latest\//, "never a moving URL");
    assert.doesNotMatch(text, /#\$|#@/, "no accidental Ruby interpolation in the generated text");
  }

  const refused = (name: string, directory: string, pattern: RegExp, tag = "v9.8.7") =>
    assert.throws(() => readFormulaInputs(tag, directory, publicPem, fingerprint), pattern, name);
  refused("another key", assets(cubed(), runner(), other), /signature verification failed/);
  refused("a bit flipped in one signature", assets(cubed(), runner(), privateKey, true), /signature verification failed/);
  refused("another tag's manifests", assets(cubed(), runner()), /not a cubed darwin-arm64 manifest of v9.8.8/, "v9.8.8");
  refused("a prerelease tag", assets(cubed(), runner()), /stable tag/, "v9.8.7-rc1");
  refused("a moving artifact URL", assets(cubed({ artifact: { url: "https://github.com/cubeyard/cube/releases/latest/download/cubed-darwin-arm64.tar.gz", sha256: "a".repeat(64), bytes: 1 } }), runner()), /not a cubed/);
  refused("an asset URL with anything but the release's asset name", assets(cubed({ artifact: { url: `${base}/cubed-v9.8.7-darwin-arm64.tar.gz"#{x}`, sha256: "a".repeat(64), bytes: 1 } }), runner()), /not a cubed/);
  refused("a Linux manifest", assets(cubed({ platform: "linux-x64-gnu" }), runner()), /not a cubed darwin-arm64/);
  refused("a bundle that claims to include the runner", assets(cubed({ includesRunner: true }), runner()), /release contract/);
  refused("another state schema", assets(cubed({ stateSchema: { minimum: 103, maximum: 103, rollbackSafeFrom: 103 } }), runner()), /release contract/);
  refused("a protocol-2 runner", assets(cubed(), runner({ protocolVersion: 2 })), /release contract/);
  refused("manifests of different commits", assets(cubed(), runner({ commit: "f".repeat(40) })), /different commits/);
  assert.throws(() => readFormulaInputs("v9.8.7", assets(cubed(), runner()), publicPem, "SHA256:" + "0".repeat(64)), /committed fingerprint/);

  // The CLI, with the committed key: these manifests are not signed by it.
  const cli = spawnSync(process.execPath, ["scripts/homebrew/formula.ts", "v9.8.7", "--assets", assets(cubed(), runner()), "--out", path.join(root, "out")], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /signature verification failed/);
  assert.ok(!fs.existsSync(path.join(root, "out/cube.rb")), "nothing is written for refused inputs");
  console.log("ok: homebrew formulas are generated only from signed manifests of one stable release, pinned to its assets");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
