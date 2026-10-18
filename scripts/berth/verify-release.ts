/** Verifies a downloaded cube release directory before berth and keel are
 * installed from it: SHA256SUMS, each berth-*.json and keel-*.json against
 * this checkout's pinned update key (whose fingerprint must be the committed
 * one), each asset's digest and size against its manifest, and the
 * cube-agent in keel's base listing. Prints one JSON line; exits 1 on any
 * failure. Run it from a checkout of the release tag, never from inside a
 * bundle it is checking.
 * Usage: node scripts/berth/verify-release.ts RELEASE_DIRECTORY */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { publicKeyFingerprint } from "../cubed/verify-signing-key.ts";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export function verifyRelease(directory: string, keyPem = fs.readFileSync(path.join(root, "scripts/cubed/update-public-key.pem")),
  fingerprint = fs.readFileSync(path.join(root, "scripts/cubed/update-public-key.fingerprint"), "utf8").trim()) {
  if (publicKeyFingerprint(keyPem) !== fingerprint) throw new Error("the update key does not have the committed fingerprint");
  const key = createPublicKey(keyPem);
  const read = (name: string) => {
    if (name !== path.basename(name)) throw new Error(`not a file name: ${name}`);
    return fs.readFileSync(path.join(directory, name));
  };
  // Every listed file matches; every manifest and its signature are listed.
  const sums = new Map<string, string>();
  for (const line of read("SHA256SUMS").toString().split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS: bad line ${JSON.stringify(line)}`);
    sums.set(match[2]!, match[1]!);
  }
  for (const [name, digest] of sums) if (sha256(read(name)) !== digest) throw new Error(`SHA256SUMS: ${name} does not match`);
  const manifests = fs.readdirSync(directory).filter(name => /^(berth|keel)-[a-z0-9_-]+\.json$/.test(name)).sort();
  if (!manifests.some(name => name.startsWith("berth-")) && !manifests.some(name => name.startsWith("keel-"))) throw new Error("no berth or keel manifest");
  const signed = (name: string) => {
    for (const file of [name, `${name}.sig`]) if (!sums.has(file)) throw new Error(`${file} is not in SHA256SUMS`);
    const manifest = read(name);
    if (!verify(null, manifest, key, Buffer.from(read(`${name}.sig`).toString().trim(), "base64"))) throw new Error(`${name}: the signature does not verify`);
    return JSON.parse(manifest.toString());
  };
  const asset = (owner: string, entry: { url?: unknown; sha256?: unknown; bytes?: unknown }) => {
    if (typeof entry?.url !== "string") throw new Error(`${owner}: no asset url`);
    const name = entry.url.slice(entry.url.lastIndexOf("/") + 1);
    const data = read(name);
    if (sha256(data) !== entry.sha256 || data.length !== entry.bytes) throw new Error(`${owner}: ${name} does not match its manifest`);
    return data;
  };
  const berth: unknown[] = [];
  const keel: unknown[] = [];
  for (const name of manifests) {
    const m = signed(name);
    if (m.schema !== 1) throw new Error(`${name}: schema ${m.schema}`);
    if (name.startsWith("berth-")) {
      if (m.product !== "berth" || m.protocolVersion !== 4 || name !== `berth-${m.platform}.json`) throw new Error(`${name}: not a protocol-4 berth manifest for its platform`);
      asset(name, m.artifact);
      berth.push({ platform: m.platform, version: m.version, release: m.release, commit: m.commit, sha256: m.artifact.sha256 });
    } else {
      if (m.product !== "keel" || name !== `keel-${m.arch}.json`) throw new Error(`${name}: not a keel manifest for its architecture`);
      asset(`${name} kernel`, m.kernel);
      asset(`${name} base`, m.base);
      const listing = asset(`${name} base listing`, m.base?.listing).toString();
      const agent = /^([0-9a-f]{64}) {2}\.\/sbin\/cube-agent$/m.exec(listing)?.[1];
      if (!agent) throw new Error(`${name}: the base listing names no sbin/cube-agent`);
      keel.push({ arch: m.arch, release: m.release, commit: m.commit, kernel: m.kernel.sha256, base: m.base.sha256, cubeAgent: agent });
    }
  }
  return { ok: true, fingerprint, berth, keel };
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("usage: node scripts/berth/verify-release.ts RELEASE_DIRECTORY");
  try {
    process.stdout.write(`${JSON.stringify(verifyRelease(path.resolve(directory)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
