/** Writes berth's signed release manifest for one platform from a
 * package.sh directory: the bundle under its release name and
 * berth-<platform>.json with its detached signature, signed with the same
 * Ed25519 key as cubed's updates and checked against the key's public half
 * before it is written out. */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";

const [release, platform, source, destination, baseUrl, privateKey] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(release ?? "") || !["linux-x64-gnu", "darwin-arm64"].includes(platform ?? "") || !source || !destination || !baseUrl || !privateKey) {
  throw new Error("usage: node scripts/berth/build-release.ts vX.Y.Z linux-x64-gnu|darwin-arm64 PACKAGE_DIRECTORY DESTINATION RELEASE_BASE_URL ED25519_PRIVATE_KEY_PEM");
}
const root = path.resolve(import.meta.dirname, "../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not determine release commit");
const built = JSON.parse(fs.readFileSync(path.join(source, "version.json"), "utf8")) as { softwareVersion?: unknown; protocolVersion?: unknown };
if (typeof built.softwareVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(built.softwareVersion) || built.protocolVersion !== 4) {
  throw new Error(`version.json is not a protocol-4 berth: ${JSON.stringify(built)}`);
}
const name = `berth-${release}-${platform}.tar.gz`;
const data = fs.readFileSync(path.join(source, name));
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, name), data, { mode: 0o644 });
const manifest = Buffer.from(`${JSON.stringify({
  schema: 1, product: "berth", version: built.softwareVersion, release, commit, platform, protocolVersion: 4,
  artifact: { url: `${baseUrl.replace(/\/$/, "")}/${name}`, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length },
})}\n`);
const signature = sign(null, manifest, fs.readFileSync(privateKey));
if (!verify(null, manifest, createPublicKey(fs.readFileSync(privateKey)), signature)) throw new Error("the manifest does not verify with its own key");
const manifestPath = path.resolve(destination, `berth-${platform}.json`);
fs.writeFileSync(manifestPath, manifest, { mode: 0o644 });
fs.writeFileSync(`${manifestPath}.sig`, `${signature.toString("base64")}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify({ manifest: manifestPath, version: built.softwareVersion, bytes: data.length })}\n`);
