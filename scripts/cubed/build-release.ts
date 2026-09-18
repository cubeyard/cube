import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, sign } from "node:crypto";
import { execFileSync } from "node:child_process";

const [version, destination, baseUrl, privateKey] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(version ?? "") || !destination || !baseUrl || !privateKey) {
  throw new Error("usage: node scripts/cubed/build-release.ts vX.Y.Z DESTINATION RELEASE_BASE_URL ED25519_PRIVATE_KEY_PEM");
}
if (!fs.existsSync("packages/web/dist") || !fs.statSync("packages/web/dist").isDirectory()) throw new Error("run pnpm build before packaging cubed");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not determine release commit");
const platform = process.platform === "linux" ? `linux-${process.arch}-gnu` : `${process.platform}-${process.arch}`;
if (!["linux-x64-gnu", "linux-arm64-gnu", "darwin-arm64"].includes(platform)) throw new Error(`unsupported cubed release platform ${platform}`);
fs.mkdirSync(destination, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-release-"));
try {
  const root = path.join(temporary, "cubed");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "app/packages/web"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, "bin/node"));
  fs.chmodSync(path.join(root, "bin/node"), 0o755);
  execFileSync("pnpm", ["--filter", "@cube/server", "deploy", "--prod", "--legacy", path.join(root, "app/packages/server")], { stdio: "inherit" });
  fs.rmSync(path.join(root, "app/packages/server/test"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "app/packages/server/node_modules/.pnpm/node_modules/@cube/server"), { force: true });
  fs.rmSync(path.join(root, "app/packages/server/node_modules/@cube/git"), { force: true });
  fs.mkdirSync(path.join(root, "app/packages/git/node_modules"), { recursive: true });
  fs.cpSync("packages/git/src", path.join(root, "app/packages/git/src"), { recursive: true });
  fs.copyFileSync("packages/git/package.json", path.join(root, "app/packages/git/package.json"));
  fs.symlinkSync("../../../git", path.join(root, "app/packages/server/node_modules/@cube/git"));
  fs.symlinkSync("../../server/node_modules/effect", path.join(root, "app/packages/git/node_modules/effect"));
  fs.cpSync("packages/web/dist", path.join(root, "app/packages/web/dist"), { recursive: true });
  fs.copyFileSync("scripts/cubed-supervisor.ts", path.join(root, "supervisor.ts"));
  fs.copyFileSync("scripts/cubed/cubed", path.join(root, "bin/cubed"));
  fs.chmodSync(path.join(root, "bin/cubed"), 0o755);
  fs.writeFileSync(path.join(root, "release.json"), `${JSON.stringify({
    version, commit, stateSchema: 100, entry: "app/packages/server/src/index.ts",
  })}\n`, { mode: 0o644 });

  const artifactName = `cubed-${version}-${platform}.tar.gz`;
  const artifact = path.resolve(destination, artifactName);
  execFileSync("tar", ["-czf", artifact, "-C", temporary, "cubed"]);
  const bytes = fs.statSync(artifact).size;
  const sha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const manifest = Buffer.from(`${JSON.stringify({
    schema: 1, product: "cubed", version, commit, platform, minimumSupervisor: 1,
    stateSchema: { minimum: 100, maximum: 100, rollbackSafeFrom: 100 },
    artifact: { url: `${baseUrl.replace(/\/$/, "")}/${artifactName}`, sha256, bytes },
    publishedAt: new Date().toISOString(), notesUrl: `https://github.com/cubeyard/cube/releases/tag/${version}`,
    includesRunner: false,
  })}\n`);
  const manifestPath = path.resolve(destination, `cubed-${platform}.json`);
  fs.writeFileSync(manifestPath, manifest, { mode: 0o644 });
  fs.writeFileSync(`${manifestPath}.sig`, `${sign(null, manifest, fs.readFileSync(privateKey)).toString("base64")}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ artifact, manifest: manifestPath, bytes, sha256 })}\n`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
