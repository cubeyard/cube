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
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fetchImage } from "./keel-oci.ts";

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

type Converted = { diffId: string; tarBytes: number; imageBytes: number; seconds: number };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mib = (bytes: number) => (bytes / 2 ** 20).toFixed(1);
const results = [];
const mkfsVersion = execFileSync(mkfs, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];

for (const image of positionals) {
  const fetched = await fetchImage(image, values.arch, join(out, "blobs"));
  const layers = fetched.layers.map((l) => l.descriptor);
  const diffIds = fetched.layers.map((l) => l.diffId);
  const blobs = fetched.layers.map((l) => l.path);
  const indexDigest = fetched.index;
  const manifest = { digest: fetched.manifest };

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
