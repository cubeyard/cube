#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 4 ] || { echo 'usage: install.sh RELEASE.tar.gz MANIFEST.json MANIFEST.sig PUBLIC_KEY.pem' >&2; exit 1; }
archive="$1"; manifest="$2"; signature="$3"; public_key="$4"
root="${CUBED_INSTALL_ROOT:-$HOME/.local/share/cubed}"
bin="${CUBED_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$root/releases" "$bin"
chmod 0700 "$root" "$root/releases"
node - "$archive" "$manifest" "$signature" "$public_key" "$root" "$bin" <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const [archive, manifestPath, signaturePath, keyPath, rootInput, binInput] = process.argv.slice(2);
const root = path.resolve(rootInput), bin = path.resolve(binInput);
const bytes = fs.readFileSync(manifestPath), manifest = JSON.parse(bytes);
const platform = process.platform === "linux" ? `linux-${process.arch}-gnu` : `${process.platform}-${process.arch}`;
if (manifest.schema !== 1 || manifest.product !== "cubed" || manifest.includesRunner !== false ||
    !/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{40}$/.test(manifest.commit) || manifest.platform !== platform ||
    !Number.isSafeInteger(manifest.minimumSupervisor) || manifest.minimumSupervisor > 1 || manifest.stateSchema?.minimum !== 100 ||
    manifest.stateSchema?.maximum !== 100 || manifest.stateSchema?.rollbackSafeFrom !== 100 ||
    !Number.isSafeInteger(manifest.artifact?.bytes) || manifest.artifact.bytes <= 0 || !/^[0-9a-f]{64}$/.test(manifest.artifact?.sha256)) {
  throw Error("incompatible cubed manifest");
}
if (!crypto.verify(null, bytes, fs.readFileSync(keyPath), Buffer.from(fs.readFileSync(signaturePath, "utf8").trim(), "base64"))) throw Error("manifest signature verification failed");
const artifact = fs.readFileSync(archive);
if (artifact.length !== manifest.artifact.bytes || crypto.createHash("sha256").update(artifact).digest("hex") !== manifest.artifact.sha256) throw Error("artifact checksum verification failed");
const temporary = fs.mkdtempSync(path.join(root, "releases/.install-"));
const atomicFile = (source, destination, mode) => {
  const next = `${destination}.new.${process.pid}`;
  fs.copyFileSync(source, next); fs.chmodSync(next, mode); fs.renameSync(next, destination);
};
const atomicLink = (target, destination) => {
  const next = `${destination}.new.${process.pid}`;
  fs.rmSync(next, { force: true }); fs.symlinkSync(target, next); fs.renameSync(next, destination);
};
const validateTree = directory => {
  const prefix = `${fs.realpathSync(directory)}${path.sep}`;
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(filename)) || !fs.realpathSync(filename).startsWith(prefix)) throw Error("release archive contains an unsafe symlink");
      } else if (!entry.isFile()) throw Error("release archive contains a special filesystem entry");
    }
  };
  visit(directory);
};
try {
  const names = cp.execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split("\n").filter(Boolean);
  if (!names.length || names.length > 100000 || names.some(name => !name.startsWith("cubed/") || name.startsWith("/") || name.split("/").includes(".."))) throw Error("unsafe release archive");
  cp.execFileSync("tar", ["-xzf", archive, "--no-same-owner", "-C", temporary]);
  const unpacked = path.join(temporary, "cubed"); validateTree(unpacked);
  const record = JSON.parse(fs.readFileSync(path.join(unpacked, "release.json"), "utf8"));
  if (record.version !== manifest.version || record.commit !== manifest.commit || record.stateSchema !== 100 || record.entry !== "app/packages/server/src/index.ts") throw Error("release metadata does not match its signed manifest");
  const selfCheck = JSON.parse(cp.execFileSync(path.join(unpacked, "bin/node"), [path.join(unpacked, record.entry), "--self-check"], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, CUBED_VERSION: manifest.version, CUBED_COMMIT: manifest.commit,
      CUBED_SUPERVISOR_SOCKET: "", CUBED_UPDATE_TOKEN: "" },
  }).trim());
  if (selfCheck.version !== manifest.version || selfCheck.commit !== manifest.commit || selfCheck.stateSchema !== 100) throw Error("candidate self-check reported different build metadata");
  const release = path.join(root, "releases", manifest.version);
  if (!fs.existsSync(release)) fs.renameSync(unpacked, release);
  else if (JSON.parse(fs.readFileSync(path.join(release, "release.json"), "utf8")).commit !== manifest.commit) throw Error("release directory contains different bytes");
  atomicFile(keyPath, path.join(root, "update-public-key.pem"), 0o600);
  atomicFile(path.join(release, "supervisor.ts"), path.join(root, "supervisor.ts"), 0o600);
  atomicFile(path.join(release, "bin/cubed"), path.join(bin, "cubed"), 0o755);
  const current = path.join(root, "current");
  if (fs.existsSync(current)) atomicLink(fs.realpathSync(current), path.join(root, "previous"));
  atomicLink(release, current);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
NODE
printf 'installed %s\nrun in the foreground: CUBED_GUI_UPDATES=1 CUBED_UPDATE_FEED_URL=<signed-manifest-url> %s/cubed\n' "$(basename "$(readlink "$root/current")")" "$bin"
