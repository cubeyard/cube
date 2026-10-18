/** Writes keel's signed release manifest and assets for one architecture
 * from a keel build's outputs (the keel-build action's directory): the
 * kernel, the base and the base's file listing, renamed for the release, and
 * keel-<arch>.json with its detached signature. Signed with the same Ed25519
 * key as cubed's updates; checked against the key's public half before it
 * is written out. */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";

const [release, arch, source, destination, baseUrl, privateKey] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(release ?? "") || !["x86_64", "arm64"].includes(arch ?? "") || !source || !destination || !baseUrl || !privateKey) {
  throw new Error("usage: node scripts/keel/build-release.ts vX.Y.Z x86_64|arm64 BUILD_DIRECTORY DESTINATION RELEASE_BASE_URL ED25519_PRIVATE_KEY_PEM");
}
const root = path.resolve(import.meta.dirname, "../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not determine release commit");
const kernelVersion = /^version=(\d+\.\d+\.\d+)$/m.exec(fs.readFileSync(path.join(root, "packages/keel/kernel/build.sh"), "utf8"))?.[1];
if (!kernelVersion) throw new Error("no kernel version in packages/keel/kernel/build.sh");
const keys = Object.fromEntries(fs.readFileSync(path.join(source, "keys.txt"), "utf8").trim().split("\n").map(line => line.split(" ")));
if (!/^[0-9a-f]{64}$/.test(keys.kernel ?? "") || !/^[0-9a-f]{64}$/.test(keys.base ?? "")) throw new Error("keys.txt needs a kernel and a base cache key");

const url = (name: string) => `${baseUrl.replace(/\/$/, "")}/${name}`;
fs.mkdirSync(destination, { recursive: true });
/** Copies a build output under its release name; the build's own .sha256 must agree. */
const asset = (from: string, suffix: string) => {
  const data = fs.readFileSync(path.join(source, from));
  const sha256 = createHash("sha256").update(data).digest("hex");
  const recorded = path.join(source, `${from}.sha256`);
  if (fs.existsSync(recorded) && fs.readFileSync(recorded, "utf8").trim() !== sha256) throw new Error(`${from} does not match ${from}.sha256`);
  const name = `keel-${release}-${arch}-${suffix}`;
  fs.writeFileSync(path.join(destination, name), data, { mode: 0o644 });
  return { sha256, bytes: data.length, url: url(name) };
};
const kernel = { version: kernelVersion, ...asset("vmlinuz", "vmlinuz") };
const base = { ...asset("base.erofs", "base.erofs"), listing: asset("base.txt", "base.txt") };
const manifest = Buffer.from(`${JSON.stringify({
  schema: 1, product: "keel", release, commit, arch, kernel, base, cacheKeys: { kernel: keys.kernel, base: keys.base },
})}\n`);
const manifestPath = path.resolve(destination, `keel-${arch}.json`);
const signature = sign(null, manifest, fs.readFileSync(privateKey));
if (!verify(null, manifest, createPublicKey(fs.readFileSync(privateKey)), signature)) throw new Error("the manifest does not verify with its own key");
fs.writeFileSync(manifestPath, manifest, { mode: 0o644 });
fs.writeFileSync(`${manifestPath}.sig`, `${signature.toString("base64")}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify({ manifest: manifestPath, kernel: kernel.sha256, base: base.sha256 })}\n`);
