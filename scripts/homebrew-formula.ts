// Generate the tap formula from the exact published launcher bytes.
// node scripts/homebrew-formula.ts vX.Y.Z /path/to/downloaded/cube > Formula/cube.rb
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [tag, asset] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !asset) {
  throw new Error("usage: homebrew-formula.ts vX.Y.Z /path/to/released/cube");
}
const launcher = readFileSync(asset);
if (!/^INSTALL_METHOD=standalone\b/m.test(launcher.toString())) {
  throw new Error("release launcher does not support Homebrew-managed updates");
}
const sha = createHash("sha256").update(launcher).digest("hex");
process.stdout.write(`class Cube < Formula
  desc "Self-hosted coding-agent sandboxes on a VM you own"
  homepage "https://github.com/cubeyard/cube"
  url "https://github.com/cubeyard/cube/releases/download/${tag}/cube"
  sha256 "${sha}"
  license "Apache-2.0"

  depends_on :macos
  depends_on "qemu"

  def install
    inreplace "cube", "INSTALL_METHOD=standalone", "INSTALL_METHOD=homebrew"
    bin.install "cube"
  end

  def caveats
    <<~EOS
      Run cube up to download and start the VM (~1.1 GB on first use).
      brew upgrade cube updates the launcher; cube upgrade updates the VM.
      VM data lives in ~/.cube and is kept when this formula is uninstalled.
      To delete it, explicitly run cube destroy --yes before uninstalling.
    EOS
  end

  test do
    ENV["CUBE_HOME"] = testpath/"state"
    ENV["CUBE_BIND"] = "127.0.0.1"
    assert_match "cube up", shell_output("#{bin}/cube help")
    assert_match "none installed", shell_output("#{bin}/cube version")
    assert_predicate testpath/"state", :directory?
  end
end
`);
