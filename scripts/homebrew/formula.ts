/** Generates the Homebrew tap formulas (cubeyard/homebrew-tap: Formula/cube.rb
 * and Formula/cube-runner.rb) from one published stable release's signed
 * darwin-arm64 manifests. The manifests are verified with the committed
 * release key before any byte of them is trusted; the formulas pin the exact
 * release URL and sha256 the signed manifest names, never a moving `latest`.
 *
 *   node scripts/homebrew/formula.ts vX.Y.Z --assets DIR --out DIR
 *
 * DIR holds cubed-darwin-arm64.json(.sig) and cube-runner-darwin-arm64.json(.sig)
 * downloaded from that release (`gh release download vX.Y.Z -p '*darwin-arm64.json*'`). */
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { parseArgs } from "node:util";
import { publicKeyFingerprint } from "../cubed/verify-signing-key.ts";
import { CUBED_STATE_SCHEMA } from "../../packages/server/src/version.ts";

const REPOSITORY = "https://github.com/cubeyard/cube";
const PLATFORM = "darwin-arm64";
const TAP = "cubeyard/tap";

interface CubedManifest {
  schema: 1; product: "cubed"; version: string; commit: string; platform: string; minimumSupervisor: number;
  stateSchema: { minimum: number; maximum: number; rollbackSafeFrom: number };
  artifact: { url: string; sha256: string; bytes: number }; includesRunner: false;
}
interface RunnerManifest {
  schema: 1; product: "cube-runner"; version: string; release: string; commit: string; platform: string; protocolVersion: number;
  artifact: { url: string; sha256: string; bytes: number };
}

export interface FormulaInputs { tag: string; cubed: CubedManifest; runner: RunnerManifest }

/** Reads and verifies one signed manifest: the signature over the exact
 * bytes, then the fields the formula depends on. The artifact URL must be
 * exactly the release's asset, so nothing but a hex digest and a version
 * ever reaches the generated Ruby. */
export function readSignedManifest<T extends { product: string }>(options: {
  manifestPath: string; signaturePath: string; publicKeyPem: Buffer; product: T["product"]; tag: string;
}): T {
  const bytes = fs.readFileSync(options.manifestPath);
  const signature = Buffer.from(fs.readFileSync(options.signaturePath, "utf8").trim(), "base64");
  const key = createPublicKey(options.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature)) {
    throw new Error(`${path.basename(options.manifestPath)}: manifest signature verification failed`);
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const artifact = manifest.artifact as Record<string, unknown> | undefined;
  const expectedUrl = `${REPOSITORY}/releases/download/${options.tag}/${options.product}-${options.tag}-${PLATFORM}.tar.gz`;
  if (manifest.schema !== 1 || manifest.product !== options.product || manifest.platform !== PLATFORM
    || !/^[0-9a-f]{40}$/.test(String(manifest.commit))
    || artifact?.url !== expectedUrl
    || !/^[0-9a-f]{64}$/.test(String(artifact.sha256)) || !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) <= 0) {
    throw new Error(`${path.basename(options.manifestPath)}: not a ${options.product} ${PLATFORM} manifest of ${options.tag}`);
  }
  if (options.product === "cubed") {
    const state = manifest.stateSchema as Record<string, unknown> | undefined;
    if (manifest.version !== options.tag || manifest.includesRunner !== false || manifest.minimumSupervisor !== 1
      || state?.minimum !== CUBED_STATE_SCHEMA || state?.maximum !== CUBED_STATE_SCHEMA || state?.rollbackSafeFrom !== CUBED_STATE_SCHEMA) {
      throw new Error(`${path.basename(options.manifestPath)}: unexpected cubed release contract`);
    }
  } else if (manifest.release !== options.tag || manifest.protocolVersion !== 3
    || !/^\d+\.\d+\.\d+$/.test(String(manifest.version))) {
    throw new Error(`${path.basename(options.manifestPath)}: unexpected cube-runner release contract`);
  }
  return manifest as unknown as T;
}

export function readFormulaInputs(tag: string, assets: string, publicKeyPem: Buffer, fingerprint: string): FormulaInputs {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("the release must be a stable tag vX.Y.Z");
  if (publicKeyFingerprint(publicKeyPem) !== fingerprint) throw new Error("the release public key does not match the committed fingerprint");
  const cubed = readSignedManifest<CubedManifest>({ manifestPath: path.join(assets, `cubed-${PLATFORM}.json`),
    signaturePath: path.join(assets, `cubed-${PLATFORM}.json.sig`), publicKeyPem, product: "cubed", tag });
  const runner = readSignedManifest<RunnerManifest>({ manifestPath: path.join(assets, `cube-runner-${PLATFORM}.json`),
    signaturePath: path.join(assets, `cube-runner-${PLATFORM}.json.sig`), publicKeyPem, product: "cube-runner", tag });
  if (cubed.commit !== runner.commit) throw new Error("the cubed and cube-runner manifests come from different commits");
  return { tag, cubed, runner };
}

/** Formula/cube-runner.rb: the runner binary, QEMU from Homebrew, a user
 * service running the local runner. Its version is the cube release's (the
 * asset is per release), so every release upgrades it even when the runner's
 * own version did not change. No self-updater: brew upgrade is the update
 * path, and the runner's own updater would fight it. */
export function runnerFormula({ tag, runner }: FormulaInputs): string {
  return `# Generated by scripts/homebrew/formula.ts in cubeyard/cube from the signed
# ${PLATFORM} manifest of release ${tag} (cube-runner ${runner.version}). Do not edit by hand.
class CubeRunner < Formula
  desc "Cube's VM runner: one QEMU machine per coding-agent thread"
  homepage "${REPOSITORY}"
  url "${runner.artifact.url}"
  sha256 "${runner.artifact.sha256}"
  license "Apache-2.0"

  depends_on arch: :arm64
  depends_on :macos
  depends_on "qemu"

  def install
    bin.install "bin/cube-runner"
    # The operator scripts and the pinned release key, for reference; the
    # self-updater they implement is not installed: brew upgrade updates
    # this runner.
    libexec.install "scripts", "update-public-key.pem", "MANIFEST"
    # The service's entry point: the home is resolved when the service
    # starts, for the user who starts it.
    (libexec/"service.sh").write <<~SH
      #!/bin/sh
      set -eu
      exec "#{opt_bin}/cube-runner" run --home "\${CUBE_RUNNER_HOME:-$HOME/.cube/runner}" "$@"
    SH
    chmod 0755, libexec/"service.sh"
  end

  # The local runner that \`cubed runners init-local\` sets up under
  # ~/.cube/runner (its default --home). It runs as the user who starts the
  # service: the thread machines are sandboxes, QEMU itself is not. SIGTERM
  # powers the machines down (up to 30 s each) before the runner exits.
  service do
    run [opt_libexec/"service.sh"]
    keep_alive true
    stop_timeout 60
    log_path var/"log/cube-runner.log"
    error_log_path var/"log/cube-runner.log"
    environment_variables PATH: std_service_path_env
  end

  def caveats
    <<~EOS
      The runner needs Hypervisor.framework and a Debian 13 genericcloud arm64 image.
      Set it up from the cube formula with:
        cubed runners init-local --image /path/to/debian-13-genericcloud-arm64.qcow2
      then: brew services start cube-runner
      After brew upgrade: brew services restart cube-runner (a running service is not restarted).
      Its state (key, base image, machine disks) is ~/.cube; uninstalling keeps it.
      QEMU runs as your user; a thread's machine is the sandbox, this Mac is not.
    EOS
  end

  test do
    assert_match '"protocolVersion":3', shell_output("#{bin}/cube-runner version")
    assert_match "cube-runner init", shell_output("#{bin}/cube-runner --help")
    assert_predicate libexec/"service.sh", :executable?
  end
end
`;
}

/** Formula/cube.rb: the cubed release bundle (its own Node, cube-gateway,
 * the web UI) under libexec, a launcher that reads the operator's
 * environment file and runs cubed directly (no update supervisor: brew
 * upgrade is the update path), and a user service. */
export function cubeFormula({ tag, cubed }: FormulaInputs): string {
  return `# Generated by scripts/homebrew/formula.ts in cubeyard/cube from the signed
# ${PLATFORM} manifest of release ${tag}. Do not edit by hand.
class Cube < Formula
  desc "Self-hosted durable coding-agent threads, each in its own virtual machine"
  homepage "${REPOSITORY}"
  url "${cubed.artifact.url}"
  sha256 "${cubed.artifact.sha256}"
  license "Apache-2.0"

  depends_on arch: :arm64
  depends_on "${TAP}/cube-runner"
  depends_on "gh"
  depends_on :macos

  def install
    # The signed bundle as released: bin/node, bin/cube-gateway, app/,
    # release.json (cubed finds its gateway next to release.json).
    libexec.install Dir["*"]
    # A dependency (pi-tui) ships prebuilt native modules for every platform;
    # only this one's may stay in the keg (brew audit refuses the others).
    # They live under node_modules/.pnpm, so the glob must match dot directories.
    Dir.glob(libexec/"app/**/native/*/prebuilds/*", File::FNM_DOTMATCH).each do |dir|
      next if !File.directory?(dir) || File.basename(dir) == "darwin-arm64" || File.basename(dir).start_with?(".")

      rm_r(dir)
    end
    # The bundle's bin/cubed starts the self-update supervisor; under
    # Homebrew, cubed runs directly and brew upgrade updates it.
    (bin/"cubed").write <<~SH
      #!/bin/sh
      set -eu
      config="\${CUBED_CONFIG_FILE:-$HOME/.config/cubed/environment}"
      if [ -f "$config" ]; then
        set -a
        # shellcheck source=/dev/null
        . "$config"
        set +a
      fi
      export CUBE_RUNNER="\${CUBE_RUNNER:-#{HOMEBREW_PREFIX}/opt/cube-runner/bin/cube-runner}"
      export CUBED_VERSION="${tag}" CUBED_COMMIT="${cubed.commit}"
      exec "#{libexec}/bin/node" "#{libexec}/app/packages/server/src/index.ts" "$@"
    SH
    chmod 0755, bin/"cubed"
  end

  service do
    run [opt_bin/"cubed"]
    keep_alive true
    stop_timeout 60
    log_path var/"log/cubed.log"
    error_log_path var/"log/cubed.log"
    environment_variables PATH: std_service_path_env
  end

  def caveats
    <<~EOS
      One-time setup on this Mac (Apple Silicon), with a Debian 13 genericcloud arm64 image:
        cubed runners init-local --image /path/to/debian-13-genericcloud-arm64.qcow2
        brew services start cube-runner
        brew services start cube
      Then open http://127.0.0.1:7777, connect a model under "models" and run
      "gh auth login" for GitHub. cubed listens on loopback only and has no user
      authentication; keep it there or behind an authenticated private network.
      Settings go in ~/.config/cubed/environment (CUBED_STATE, CUBED_HOST,
      CUBED_ALLOWED_HOSTS, CUBED_CLAUDE, ...). State: ~/.cube-host and ~/.cube;
      uninstalling keeps both. After brew upgrade, restart the services:
        brew services restart cube-runner cube
    EOS
  end

  test do
    assert_match "cubed", shell_output("#{bin}/cubed --version")
    assert_match "runners status", shell_output("#{bin}/cubed --help")
    check = JSON.parse(shell_output("#{bin}/cubed --self-check"))
    assert_equal "${tag}", check["version"]
    assert_match(/^cube-gateway /, check["gateway"])
  end
end
`;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    assets: { type: "string" }, out: { type: "string" },
  } });
  const [tag] = positionals;
  if (!tag || !values.assets || !values.out || positionals.length !== 1) {
    throw new Error("usage: node scripts/homebrew/formula.ts vX.Y.Z --assets DIR --out DIR");
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const inputs = readFormulaInputs(tag, values.assets, fs.readFileSync(path.join(here, "../cubed/update-public-key.pem")),
    fs.readFileSync(path.join(here, "../cubed/update-public-key.fingerprint"), "utf8").trim());
  fs.mkdirSync(values.out, { recursive: true });
  fs.writeFileSync(path.join(values.out, "cube.rb"), cubeFormula(inputs));
  fs.writeFileSync(path.join(values.out, "cube-runner.rb"), runnerFormula(inputs));
  process.stdout.write(`${JSON.stringify({ tag, commit: inputs.cubed.commit, cubed: inputs.cubed.artifact.sha256,
    runner: inputs.runner.version, runnerSha256: inputs.runner.artifact.sha256, formulas: ["cube.rb", "cube-runner.rb"] })}\n`);
}
