// Measures keel's layer conversion on real public images (U5 in the
// masterplan): `mkfs.erofs --tar=f` against `--tar=i`, time and disk use,
// through keel-layers' own code path (packages/keel/layers/examples/layers.rs).
//
//   cargo build --release -p keel-layers --example layers
//   node scripts/keel-layer-bench.ts --mkfs /usr/bin/mkfs.erofs \
//     --layers target/release/examples/layers --out /var/tmp/keel-bench \
//     [--arch amd64|arm64] [--runs 3] docker.io/library/debian:trixie ...
//
// Public images only, fetched anonymously and checked against their digests;
// blobs stay in OUT/blobs between runs. Every run converts into an empty
// cache. Prints a Markdown table and writes OUT/results.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mkfs: { type: "string" },
    layers: { type: "string" },
    out: { type: "string" },
    arch: { type: "string", default: process.arch === "arm64" ? "arm64" : "amd64" },
    runs: { type: "string", default: "3" },
  },
});
if (!values.mkfs || !values.layers || !values.out || positionals.length === 0) {
  console.error("usage: keel-layer-bench.ts --mkfs PATH --layers PATH --out DIR [--arch A] [--runs N] IMAGE...");
  process.exit(2);
}
const runs = Number(values.runs);
const { mkfs, layers: layersTool, out } = values;
mkdirSync(join(out, "blobs"), { recursive: true });

const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const MANIFEST_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];

type Descriptor = { mediaType: string; digest: string; size: number; platform?: { os: string; architecture: string } };

function parseReference(reference: string) {
  const match = /^([^/]+)\/(.+?)(?::([^:@/]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(reference);
  if (!match) throw new Error(`not an image reference: ${reference}`);
  const host = match[1] === "docker.io" ? "registry-1.docker.io" : match[1];
  return { host, repository: match[2], reference: match[4] ?? match[3] ?? "latest" };
}

const tokens = new Map<string, string>();

async function registryFetch(host: string, repository: string, path: string, accept: string[]): Promise<Response> {
  const url = `https://${host}/v2/${repository}/${path}`;
  const headers: Record<string, string> = { accept: accept.join(", ") };
  const token = tokens.get(`${host}/${repository}`);
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (response.status === 401 && !token) {
    // Anonymous bearer token, as public registries hand out.
    const challenge = response.headers.get("www-authenticate") ?? "";
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];
    const realm = field("realm");
    if (!realm) throw new Error(`${url}: 401 without a bearer challenge`);
    const query = new URLSearchParams({ scope: `repository:${repository}:pull` });
    const service = field("service");
    if (service) query.set("service", service);
    const answer = (await (await fetch(`${realm}?${query}`)).json()) as { token?: string; access_token?: string };
    tokens.set(`${host}/${repository}`, answer.token ?? answer.access_token ?? "");
    return registryFetch(host, repository, path, accept);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function json(host: string, repository: string, path: string, accept: string[]) {
  const response = await registryFetch(host, repository, path, accept);
  const body = Buffer.from(await response.arrayBuffer());
  return { body: JSON.parse(body.toString("utf8")), digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}

async function blob(host: string, repository: string, descriptor: Descriptor): Promise<string> {
  const path = join(out, "blobs", descriptor.digest);
  if (existsSync(path)) return path;
  const response = await registryFetch(host, repository, `blobs/${descriptor.digest}`, ["*/*"]);
  const hash = createHash("sha256");
  const partial = `${path}.partial`;
  await pipeline(
    Readable.fromWeb(response.body as never),
    new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    createWriteStream(partial),
  );
  const digest = `sha256:${hash.digest("hex")}`;
  if (digest !== descriptor.digest) throw new Error(`${descriptor.digest}: downloaded ${digest}`);
  renameSync(partial, path);
  return path;
}

type Converted = { diffId: string; tarBytes: number; imageBytes: number; seconds: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(1);
const results = [];
const mkfsVersion = execFileSync(mkfs, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];

for (const image of positionals) {
  const { host, repository, reference } = parseReference(image);
  let manifest = await json(host, repository, `manifests/${reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
  const indexDigest = manifest.digest;
  if (INDEX_TYPES.includes(manifest.body.mediaType) || manifest.body.manifests) {
    const chosen = (manifest.body.manifests as Descriptor[]).find(
      (m) => m.platform?.os === "linux" && m.platform.architecture === values.arch,
    );
    if (!chosen) throw new Error(`${image}: no linux/${values.arch} manifest`);
    manifest = await json(host, repository, `manifests/${chosen.digest}`, MANIFEST_TYPES);
    if (manifest.digest !== chosen.digest) throw new Error(`${image}: manifest digest mismatch`);
  }
  const config = JSON.parse(readFileSync(await blob(host, repository, manifest.body.config), "utf8"));
  const layers = manifest.body.layers as Descriptor[];
  const diffIds = config.rootfs.diff_ids as string[];
  if (layers.length !== diffIds.length) throw new Error(`${image}: ${layers.length} layers, ${diffIds.length} diff_ids`);
  const blobs: string[] = [];
  for (const layer of layers) blobs.push(await blob(host, repository, layer));

  const modes: Record<string, Converted[][]> = { f: [], i: [] };
  for (let run = 0; run < runs; run++) {
    // Interleave the modes so drift on the machine hits both.
    for (const mode of run % 2 === 0 ? ["f", "i"] : ["i", "f"]) {
      const cache = join(out, "cache", mode);
      rmSync(cache, { recursive: true, force: true });
      const converted = layers.map((layer, i) => {
        const line = execFileSync(
          layersTool,
          ["convert", mkfs, mode, layer.mediaType, diffIds[i], blobs[i], cache],
          { encoding: "utf8" },
        );
        return JSON.parse(line) as Converted;
      });
      modes[mode].push(converted);
    }
  }
  const total = (run: Converted[], key: "seconds" | "imageBytes" | "tarBytes") => run.reduce((s, c) => s + c[key], 0);
  const summary = Object.fromEntries(
    Object.entries(modes).map(([mode, runList]) => {
      const seconds = runList.map((r) => total(r, "seconds"));
      return [mode, { seconds, median: median(seconds), imageBytes: total(runList[0], "imageBytes") }];
    }),
  );
  const result = {
    image,
    index: indexDigest,
    manifest: manifest.digest,
    arch: values.arch,
    layers: layers.length,
    mediaTypes: [...new Set(layers.map((l) => l.mediaType))],
    compressedBytes: layers.reduce((s, l) => s + l.size, 0),
    tarBytes: total(modes.f[0], "tarBytes"),
    summary,
    runs: modes,
  };
  results.push(result);
  console.error(`${image}: done`);
}

writeFileSync(join(out, "results.json"), JSON.stringify({ mkfs, mkfsVersion, runs, results }, null, 2));
console.log(`mkfs: ${mkfs} (${mkfsVersion}); ${runs} runs per mode, interleaved; times are medians (min–max)\n`);
console.log("| image (manifest) | layers | compressed MiB | tar MiB | `--tar=f` s | `--tar=f` MiB | `--tar=i` s | `--tar=i` MiB |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const cell = (mode: string) => {
    const s = r.summary[mode];
    return `${s.median.toFixed(2)} (${Math.min(...s.seconds).toFixed(2)}–${Math.max(...s.seconds).toFixed(2)}) | ${mib(s.imageBytes)}`;
  };
  console.log(
    `| ${r.image} (\`${r.manifest.slice(0, 19)}…\`) | ${r.layers} | ${mib(r.compressedBytes)} | ${mib(r.tarBytes)} | ${cell("f")} | ${cell("i")} |`,
  );
}
