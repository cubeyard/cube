import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (spawnSync("sha256sum", ["--version"]).error) {
  console.log("cubed-release-checksum-test: skipped because sha256sum is unavailable on this platform");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-release-checksum-"));
try {
  const assets = path.join(root, "workflow-dist");
  const download = path.join(root, "flat-download");
  fs.mkdirSync(assets);
  fs.mkdirSync(download);
  fs.writeFileSync(path.join(assets, "cubed-linux-x64-gnu.json"), "manifest fixture\n");
  fs.writeFileSync(path.join(assets, "cubed-v9.8.7-linux-x64-gnu.tar.gz"), "archive fixture\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = spawnSync("bash", ["scripts/cubed/write-checksums.sh", assets], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
  }

  for (const entry of fs.readdirSync(assets)) {
    fs.copyFileSync(path.join(assets, entry), path.join(download, entry));
  }
  const checked = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: download, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout,
    "cubed-linux-x64-gnu.json: OK\ncubed-v9.8.7-linux-x64-gnu.tar.gz: OK\n");
  assert.equal(fs.readFileSync(path.join(download, "SHA256SUMS"), "utf8").split("\n").filter(Boolean).length, 2,
    "regeneration must not add SHA256SUMS to itself");
  console.log("cubed-release-checksum-test: standard sha256sum verified a regenerated flat release download");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
