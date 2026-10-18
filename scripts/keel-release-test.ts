/** keel's release tooling, offline: build-release.ts writes the assets and a
 * manifest that verifies with the signing key's public half, and refuses a
 * build whose recorded digest is wrong; compare-builds.sh passes two equal
 * builds and fails on any difference. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-release-"));
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyPath = path.join(dir, "key.pem");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const build = (name: string, kernel = "kernel image") => {
    const out = path.join(dir, name);
    fs.mkdirSync(out);
    const files: Record<string, string> = {
      vmlinuz: kernel, config: "CONFIG_X=y\n", "base.erofs": "base image", "base-standin.erofs": "standin",
      "base.txt": "keel base for x86_64\n", "keys.txt": `kernel ${"1".repeat(64)}\nbase ${"2".repeat(64)}\n`,
    };
    for (const [file, data] of Object.entries(files)) fs.writeFileSync(path.join(out, file), data);
    for (const file of ["vmlinuz", "base.erofs", "base-standin.erofs"]) fs.writeFileSync(path.join(out, `${file}.sha256`), `${sha(files[file]!)}\n`);
    return out;
  };
  const a = build("a"), b = build("b"), c = build("c", "another kernel");

  // The manifest: assets renamed, digests and sizes, cache keys, the commit; signed.
  const dist = path.join(dir, "dist");
  execFileSync(process.execPath, ["scripts/keel/build-release.ts", "v9.8.7", "x86_64", a, dist, "https://example.test/download/v9.8.7/", keyPath], { cwd: root });
  const manifest = fs.readFileSync(path.join(dist, "keel-x86_64.json"));
  const signature = Buffer.from(fs.readFileSync(path.join(dist, "keel-x86_64.json.sig"), "utf8").trim(), "base64");
  assert.ok(verify(null, manifest, publicKey, signature), "the manifest verifies with the key's public half");
  const parsed = JSON.parse(manifest.toString());
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const kernelVersion = /^version=(\S+)$/m.exec(fs.readFileSync(path.join(root, "packages/keel/kernel/build.sh"), "utf8"))![1];
  assert.deepEqual(parsed, {
    schema: 1, product: "keel", release: "v9.8.7", commit, arch: "x86_64",
    kernel: { version: kernelVersion, sha256: sha("kernel image"), bytes: 12, url: "https://example.test/download/v9.8.7/keel-v9.8.7-x86_64-vmlinuz" },
    base: { sha256: sha("base image"), bytes: 10, url: "https://example.test/download/v9.8.7/keel-v9.8.7-x86_64-base.erofs",
      listing: { sha256: sha("keel base for x86_64\n"), bytes: 21, url: "https://example.test/download/v9.8.7/keel-v9.8.7-x86_64-base.txt" } },
    cacheKeys: { kernel: "1".repeat(64), base: "2".repeat(64) },
  });
  assert.deepEqual(fs.readdirSync(dist).sort(), ["keel-v9.8.7-x86_64-base.erofs", "keel-v9.8.7-x86_64-base.txt", "keel-v9.8.7-x86_64-vmlinuz", "keel-x86_64.json", "keel-x86_64.json.sig"]);
  assert.equal(fs.readFileSync(path.join(dist, "keel-v9.8.7-x86_64-vmlinuz"), "utf8"), "kernel image");
  const tampered = new Uint8Array(manifest); tampered[10] ^= 1;
  assert.ok(!verify(null, tampered, publicKey, signature), "a changed manifest does not verify");

  // A build whose .sha256 does not match its file, and bad arguments, are refused.
  fs.writeFileSync(path.join(c, "vmlinuz.sha256"), `${sha("kernel image")}\n`);
  for (const args of [["v9.8.7", "x86_64", c], ["9.8.7", "x86_64", a], ["v9.8.7", "riscv64", a]]) {
    const refused = spawnSync(process.execPath, ["scripts/keel/build-release.ts", ...args, path.join(dir, "x"), "https://example.test/", keyPath], { cwd: root, encoding: "utf8" });
    assert.notEqual(refused.status, 0, `refused: ${args.join(" ")}`);
  }

  // Two builds: the same passes; one different output fails and names it.
  const compare = (x: string, y: string) => spawnSync("bash", ["scripts/keel/compare-builds.sh", x, y], { cwd: root, encoding: "utf8" });
  const same = compare(a, b);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.equal(same.stdout.split("\n").filter(line => line.startsWith("same ")).length, 6);
  const differ = compare(a, c);
  assert.equal(differ.status, 1);
  assert.match(differ.stdout, /^DIFFERENT vmlinuz /m);
  fs.rmSync(path.join(b, "keys.txt"));
  assert.equal(compare(a, b).status, 1, "a missing output is a difference");
  console.log("keel-release-test: signed manifest with digests, sizes, cache keys and commit; wrong digest and bad arguments refused; two builds compared byte for byte");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
