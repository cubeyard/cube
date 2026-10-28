/** Generates the Homebrew tap formulas (cubeyard/homebrew-tap: Formula/cube.rb
 * and Formula/cube-berth.rb) from one published stable release's signed
 * manifests: cubed's and berth's for darwin-arm64 and keel's for arm64. The
 * manifests are verified with the committed release key before any byte of
 * them is trusted; the formulas pin the exact release URLs and sha256s the
 * signed manifests name, never a moving `latest`.
 *
 *   node scripts/homebrew/formula.ts vX.Y.Z --assets DIR --out DIR
 *
 * DIR holds cubed-darwin-arm64.json, berth-darwin-arm64.json and
 * keel-arm64.json, each with its .sig, downloaded from that release
 * (`gh release download vX.Y.Z -p 'cubed-darwin-arm64.json*' -p 'berth-darwin-arm64.json*' -p 'keel-arm64.json*'`). */
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { parseArgs } from "node:util";
import { publicKeyFingerprint } from "../cubed/verify-signing-key.ts";
import { CUBED_STATE_SCHEMA } from "../../packages/server/src/version.ts";

const REPOSITORY = "https://github.com/cubeyard/cube";
const PLATFORM = "darwin-arm64";
const ARCH = "arm64";
const TAP = "cubeyard/tap";

interface Asset { url: string; sha256: string; bytes: number }
interface CubedManifest {
  schema: 1; product: "cubed"; version: string; commit: string; platform: string; minimumSupervisor: number;
  stateSchema: { minimum: number; maximum: number; rollbackSafeFrom: number };
  artifact: Asset; includesRunner: false;
}
interface BerthManifest {
  schema: 1; product: "berth"; version: string; release: string; commit: string; platform: string; protocolVersion: 4; artifact: Asset;
}
interface KeelManifest {
  schema: 1; product: "keel"; release: string; commit: string; arch: string; kernel: Asset & { version: string }; base: Asset & { listing: Asset };
}

export interface FormulaInputs { tag: string; cubed: CubedManifest; berth: BerthManifest; keel: KeelManifest }

const download = (tag: string, name: string) => `${REPOSITORY}/releases/download/${tag}/${name}`;
/** An asset entry that is exactly the release's asset `name`, so nothing
 * but a hex digest and a version ever reaches the generated Ruby. */
const isAsset = (entry: unknown, tag: string, name: string): boolean => {
  const asset = entry as Record<string, unknown> | undefined;
  return asset?.url === download(tag, name) && /^[0-9a-f]{64}$/.test(String(asset.sha256))
    && Number.isSafeInteger(asset.bytes) && (asset.bytes as number) > 0;
};

/** Reads and verifies one signed manifest: the signature over the exact
 * bytes, then the fields the formulas depend on. */
export function readSignedManifest<T>(options: {
  manifestPath: string; signaturePath: string; publicKeyPem: Buffer; product: "cubed" | "berth" | "keel"; tag: string;
}): T {
  const { tag, product } = options;
  const bytes = fs.readFileSync(options.manifestPath);
  const signature = Buffer.from(fs.readFileSync(options.signaturePath, "utf8").trim(), "base64");
  const key = createPublicKey(options.publicKeyPem);
  const name = path.basename(options.manifestPath);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature)) {
    throw new Error(`${name}: manifest signature verification failed`);
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const where = product === "keel" ? ARCH : PLATFORM;
  const identity = manifest.schema === 1 && manifest.product === product && /^[0-9a-f]{40}$/.test(String(manifest.commit))
    && (product === "keel" ? manifest.arch === ARCH : manifest.platform === PLATFORM);
  const assets = product === "keel"
    ? isAsset(manifest.kernel, tag, `keel-${tag}-${ARCH}-vmlinuz`) && isAsset(manifest.base, tag, `keel-${tag}-${ARCH}-base.erofs`)
    : isAsset(manifest.artifact, tag, `${product}-${tag}-${PLATFORM}.tar.gz`);
  if (!identity || !assets) throw new Error(`${name}: not a ${product} ${where} manifest of ${tag}`);
  if (product === "cubed") {
    const state = manifest.stateSchema as Record<string, unknown> | undefined;
    if (manifest.version !== tag || manifest.includesRunner !== false || manifest.minimumSupervisor !== 1
      || state?.minimum !== CUBED_STATE_SCHEMA || state?.maximum !== CUBED_STATE_SCHEMA || state?.rollbackSafeFrom !== CUBED_STATE_SCHEMA) {
      throw new Error(`${name}: unexpected cubed release contract`);
    }
  } else if (product === "berth") {
    if (manifest.release !== tag || manifest.protocolVersion !== 4 || !/^\d+\.\d+\.\d+$/.test(String(manifest.version))) {
      throw new Error(`${name}: unexpected berth release contract`);
    }
  } else if (manifest.release !== tag) throw new Error(`${name}: unexpected keel release contract`);
  return manifest as unknown as T;
}

export function readFormulaInputs(tag: string, assets: string, publicKeyPem: Buffer, fingerprint: string): FormulaInputs {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("the release must be a stable tag vX.Y.Z");
  if (publicKeyFingerprint(publicKeyPem) !== fingerprint) throw new Error("the release public key does not match the committed fingerprint");
  const read = <T>(product: "cubed" | "berth" | "keel") => {
    const file = path.join(assets, `${product}-${product === "keel" ? ARCH : PLATFORM}.json`);
    return readSignedManifest<T>({ manifestPath: file, signaturePath: `${file}.sig`, publicKeyPem, product, tag });
  };
  const cubed = read<CubedManifest>("cubed");
  const berth = read<BerthManifest>("berth");
  const keel = read<KeelManifest>("keel");
  if (cubed.commit !== berth.commit || cubed.commit !== keel.commit) throw new Error("the cubed, berth and keel manifests come from different commits");
  return { tag, cubed, berth, keel };
}

/** The free disk (GiB) cube-berth's service has berth keep beside a
 * machine's memory file when it suspends it, unless berth.env sets
 * CUBE_BERTH_SUSPEND_DISK_MARGIN_GIB: the reserve berth keeps for every
 * image pull (FREE_RESERVE in packages/berth/src/image.rs). */
const SUSPEND_DISK_MARGIN_GIB = 2;

/** Formula/cube-berth.rb: the runner, `berth vm`, with keel's kernel and
 * base for arm64, QEMU and erofs-utils from Homebrew, and a user service
 * that starts it with what `cubed runners init-local` wrote. Its version is
 * the cube release's (the asset is per release). Uninstalling it keeps
 * every file of the runner's (~/.cube/berth*), so installing it again
 * finds the same runner, key and enrollment. */
export function berthFormula({ tag, berth, keel }: FormulaInputs): string {
  return `# Generated by scripts/homebrew/formula.ts in cubeyard/cube from the signed
# ${PLATFORM} berth and ${ARCH} keel manifests of release ${tag} (berth ${berth.version}). Do not edit by hand.
class CubeBerth < Formula
  desc "Cube's runner: one keel virtual machine per coding-agent thread"
  homepage "${REPOSITORY}"
  url "${berth.artifact.url}"
  sha256 "${berth.artifact.sha256}"
  license "Apache-2.0"

  depends_on arch: :arm64
  depends_on "erofs-utils"
  depends_on :macos
  depends_on "qemu"

  # keel: the guest kernel and base every machine boots, of the same release.
  resource "keel-vmlinuz" do
    url "${keel.kernel.url}"
    sha256 "${keel.kernel.sha256}"
  end

  resource "keel-base" do
    url "${keel.base.url}"
    sha256 "${keel.base.sha256}"
  end

  def install
    bin.install "bin/berth"
    resource("keel-vmlinuz").stage { (libexec/"keel").install "keel-${tag}-${ARCH}-vmlinuz" => "vmlinuz" }
    resource("keel-base").stage { (libexec/"keel").install "keel-${tag}-${ARCH}-base.erofs" => "base.erofs" }
    # The service's entry point: berth vm in ~/.cube/berth, as
    # \`cubed runners init-local\` set it up, with Homebrew's QEMU and
    # mkfs.erofs and this keel. Until it is set up (berth.json, the last file
    # init-local writes before it enrolls) it says so and waits, so launchd
    # does not restart it in a loop, and never holds a half-set-up directory.
    (libexec/"service.sh").write <<~SH
      #!/bin/sh
      set -eu
      home="$HOME/.cube"
      if [ ! -f "$home/berth.json" ] || [ ! -f "$home/berth.env" ] || [ ! -f "$home/berth/.berth/vm.json" ]; then
        echo "cube-berth: not set up yet: run cubed runners init-local" >&2
        sleep 60
        exit 78
      fi
      image=$(sed -n 's/^CUBE_BERTH_IMAGE=//p' "$home/berth.env")
      machines=$(sed -n 's/^CUBE_BERTH_MAX_MACHINES=//p' "$home/berth.env")
      listen=$(sed -n 's/^CUBE_BERTH_LISTEN=//p' "$home/berth.env")
      if [ -z "$image" ] || [ -z "$machines" ] || [ -z "$listen" ]; then
        echo "cube-berth: $home/berth.env lacks CUBE_BERTH_IMAGE, CUBE_BERTH_MAX_MACHINES or CUBE_BERTH_LISTEN" >&2
        sleep 60
        exit 78
      fi
      # Suspend is on unless berth.env says off; its margin is the free disk
      # berth keeps beside a machine's memory file when it saves it.
      margin=$(sed -n 's/^CUBE_BERTH_SUSPEND_DISK_MARGIN_GIB=//p' "$home/berth.env")
      case "\${margin:=${SUSPEND_DISK_MARGIN_GIB}}" in
        off) set -- ;;
        [1-9] | [1-9][0-9] | [1-9][0-9][0-9] | [1-9][0-9][0-9][0-9]) set -- --suspend-disk-margin-gib "$margin" ;;
        *)
          echo "cube-berth: $home/berth.env: CUBE_BERTH_SUSPEND_DISK_MARGIN_GIB is 1 to 9999 (GiB) or off" >&2
          sleep 60
          exit 78
          ;;
      esac
      exec "#{opt_bin}/berth" vm --dir "$home/berth" \\\\
        --qemu "#{formula_opt_bin("qemu")}/qemu-system-aarch64" --qemu-img "#{formula_opt_bin("qemu")}/qemu-img" \\\\
        --mkfs-erofs "#{formula_opt_bin("erofs-utils")}/mkfs.erofs" --keel "#{opt_libexec}/keel" \\\\
        --image "$image" --max-machines "$machines" --listen "$listen" "$@"
    SH
    chmod 0755, libexec/"service.sh"
  end

  # It runs as the user who starts the service: the thread machines are
  # sandboxes, QEMU itself is not. SIGTERM stops the machines' QEMUs
  # (their disks are kept) before berth exits.
  service do
    run [opt_libexec/"service.sh"]
    keep_alive true
    stop_timeout 120
    log_path var/"log/cube-berth.log"
    error_log_path var/"log/cube-berth.log"
    environment_variables PATH: std_service_path_env
  end

  def caveats
    <<~EOS
      Set it up from the cube formula, once (later runs change nothing):
        cubed runners init-local
        brew services restart cubeyard/tap/cube-berth
      Thread machines run cube's default image, official Debian trixie pinned
      by berth, which berth prepares for cube with pinned Debian packages
      (sudo, git, gh, curl, ca-certificates) before it first listens.
      Its state (key, disks, layer cache) is ~/.cube/berth, with berth.json,
      berth.control.key and berth.env beside it in ~/.cube; uninstalling keeps
      them, and installing again uses them as they are.
      QEMU runs as your user, without -sandbox on macOS: a thread's machine is
      the sandbox, this Mac is not.
    EOS
  end

  test do
    assert_match '"protocolVersion":4', shell_output("#{bin}/berth version")
    vmlinuz = Digest::SHA256.file(libexec/"keel/vmlinuz").hexdigest
    assert_equal "${keel.kernel.sha256}", vmlinuz
    base = Digest::SHA256.file(libexec/"keel/base.erofs").hexdigest
    assert_equal "${keel.base.sha256}", base
    assert_predicate libexec/"service.sh", :executable?
    # Not set up: it says so (its 60 s pause skipped) and exits 78.
    unset = "HOME=#{testpath} /bin/sh -c 'sleep() { :; }; . #{libexec}/service.sh' 2>&1"
    assert_match "not set up yet", shell_output(unset, 78)
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
  depends_on "${TAP}/cube-berth"
  depends_on "gh"
  depends_on :macos

  # The release bundle is used as signed; nothing in it needs Homebrew's
  # cleaning, which would otherwise walk all of its files.
  skip_clean "libexec"

  def install
    # The signed bundle as released: bin/node, bin/cube-gateway, app/,
    # release.json (cubed finds its gateway next to release.json).
    libexec.install Dir["*"]
    # A dependency (pi-tui) ships prebuilt native modules for every platform;
    # only this one's may stay in the keg (brew audit refuses the others).
    # They live under node_modules/.pnpm, so the glob must match dot directories.
    Dir.glob(libexec/"app/**/native/*/prebuilds/*", File::FNM_DOTMATCH).each do |dir|
      name = File.basename(dir)
      next if !File.directory?(dir) || (name.start_with?("darwin-") && name.include?("arm64"))

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
      # Threads' \`cube service\` URLs work in a browser on this Mac out of
      # the box: the portal on loopback, under *.localhost names browsers
      # resolve themselves (no DNS). Any CUBED_PORTAL_IP, _LISTEN or _DOMAIN
      # of the operator's is kept as it is; CUBED_PORTAL_IP= turns it off.
      if [ -z "\${CUBED_PORTAL_IP+set}\${CUBED_PORTAL_LISTEN+set}\${CUBED_PORTAL_DOMAIN+set}" ]; then
        export CUBED_PORTAL_IP=127.0.0.1 CUBED_PORTAL_DOMAIN=localhost
      fi
      # \`cubed runners init-local\` sets up berth vm with the same programs
      # and keel as cube-berth's service.
      export CUBE_BERTH="\${CUBE_BERTH:-#{HOMEBREW_PREFIX}/opt/cube-berth/bin/berth}"
      export CUBE_BERTH_KEEL="\${CUBE_BERTH_KEEL:-#{HOMEBREW_PREFIX}/opt/cube-berth/libexec/keel}"
      export CUBE_BERTH_QEMU="\${CUBE_BERTH_QEMU:-#{HOMEBREW_PREFIX}/opt/qemu/bin/qemu-system-aarch64}"
      export CUBE_BERTH_QEMU_IMG="\${CUBE_BERTH_QEMU_IMG:-#{HOMEBREW_PREFIX}/opt/qemu/bin/qemu-img}"
      export CUBE_BERTH_MKFS_EROFS="\${CUBE_BERTH_MKFS_EROFS:-#{HOMEBREW_PREFIX}/opt/erofs-utils/bin/mkfs.erofs}"
      export CUBED_VERSION="${tag}" CUBED_COMMIT="${cubed.commit}"
      exec "#{libexec}/bin/node" "#{libexec}/app/packages/server/src/index.ts" "$@"
    SH
    chmod 0755, bin/"cubed"
    # Homebrew prints nothing for its own steps without --verbose, and cuts
    # an ohai at the terminal width: keep this within 80 columns.
    ohai "cube: files in place; Homebrew checks them next (quiet without --verbose)"
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
      Set up on this Mac (Apple Silicon), the same commands for a first
      install, an upgrade and an install after brew uninstall; init-local
      changes nothing that is there. Thread machines run cube's default
      image, official Debian trixie, which berth prepares for cube itself
      (--image <registry/repository@sha256:...> names your own instead, for
      those who build one with sudo, git, gh, curl and a CA bundle):
        cubed runners init-local
        brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube
      ("restart" also starts them, and replaces a process brew uninstall left
      running.) Then open http://127.0.0.1:7777, connect a model under
      "models" and run "gh auth login" for GitHub. cubed listens on loopback
      only and has no user authentication; keep it there or behind an
      authenticated private network.
      Settings go in ~/.config/cubed/environment (CUBED_STATE, CUBED_HOST,
      CUBED_ALLOWED_HOSTS, CUBED_CLAUDE, ...). Web servers a thread runs with
      "cube service" get URLs like http://web-<label>.localhost:7780/ that
      open only in a browser on this Mac (loopback). CUBED_PORTAL_IP= turns
      them off; CUBED_PORTAL_IP=<this Mac's Tailscale IPv4> serves them to your
      tailnet instead (docs/services.md). State: ~/.cube-host and ~/.cube;
      uninstalling keeps both, and a later install uses them as they are.
      A cube-runner (protocol 3) from this tap is no longer updated: retire it
      (docs/macos.md), then brew services stop cube-runner and brew uninstall
      cube-runner; its ~/.cube/runner stays.
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
  fs.writeFileSync(path.join(values.out, "cube-berth.rb"), berthFormula(inputs));
  process.stdout.write(`${JSON.stringify({ tag, commit: inputs.cubed.commit, cubed: inputs.cubed.artifact.sha256,
    berth: inputs.berth.version, berthSha256: inputs.berth.artifact.sha256, keelKernel: inputs.keel.kernel.sha256, keelBase: inputs.keel.base.sha256,
    formulas: ["cube.rb", "cube-berth.rb"] })}\n`);
}
