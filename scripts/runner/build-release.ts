/** Builds the signed cube-runner bundle and manifest for this platform, for
 * runner self-update (scripts/runner/update.sh). Signed with the same Ed25519
 * key as cubed's updates. */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";

const [release, destination, baseUrl, privateKey] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(release ?? "") || !destination || !baseUrl || !privateKey) {
  throw new Error("usage: node scripts/runner/build-release.ts vX.Y.Z DESTINATION RELEASE_BASE_URL ED25519_PRIVATE_KEY_PEM");
}
const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64-gnu"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : null;
if (!platform) throw new Error(`no cube-runner release for ${process.platform}-${process.arch}`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.mkdirSync(destination, { recursive: true });
const artifactName = `cube-runner-${release}-${platform}.tar.gz`;
const artifact = path.resolve(destination, artifactName);
fs.rmSync(artifact, { force: true });
execFileSync("bash", ["scripts/runner/package.sh", artifact], { stdio: "inherit" });
fs.rmSync(`${artifact}.sha256`, { force: true });
const binary = path.join(process.env.CARGO_TARGET_DIR ?? "target", "release", "cube-runner");
const version = JSON.parse(execFileSync(binary, ["version"], { encoding: "utf8" })).softwareVersion as string;
const bytes = fs.statSync(artifact).size;
const sha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
const manifest = Buffer.from(`${JSON.stringify({
  schema: 1, product: "cube-runner", version, release, commit, platform, protocolVersion: 3,
  artifact: { url: `${baseUrl.replace(/\/$/, "")}/${artifactName}`, sha256, bytes },
})}\n`);
const manifestPath = path.resolve(destination, `cube-runner-${platform}.json`);
fs.writeFileSync(manifestPath, manifest, { mode: 0o644 });
fs.writeFileSync(`${manifestPath}.sig`, `${sign(null, manifest, fs.readFileSync(privateKey)).toString("base64")}\n`, { mode: 0o644 });
// The runner verifies exactly this format; check it with the binary just built.
const publicKey = path.resolve(destination, ".cube-runner-check.pem");
fs.writeFileSync(publicKey, createPublicKey(fs.readFileSync(privateKey)).export({ type: "spki", format: "pem" }));
try {
  const checked = JSON.parse(execFileSync(binary, ["verify-release", "--key", publicKey, "--manifest", manifestPath,
    "--signature", `${manifestPath}.sig`], { encoding: "utf8" }));
  if (checked.version !== version || checked.sha256 !== sha256) throw new Error("the built runner does not accept its own manifest");
} finally { fs.rmSync(publicKey, { force: true }); }
process.stdout.write(`${JSON.stringify({ artifact, manifest: manifestPath, version, bytes, sha256 })}\n`);
