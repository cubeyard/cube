// Anonymous fetching of public OCI images for keel's scripts
// (keel-layer-bench.ts, keel-boot-check.ts). Not the runner's fetcher (B-7):
// public registries only, blobs checked against their digests and kept in
// a directory between runs.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const MANIFEST_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];

export type Descriptor = { mediaType: string; digest: string; size: number; platform?: { os: string; architecture: string } };

export type Image = {
  image: string;
  /** The digest of what the reference names (an index or a manifest). */
  index: string;
  manifest: string;
  config: { rootfs: { diff_ids: string[] }; config?: { Env?: string[] } };
  /** Bottom layer first, as in the manifest. */
  layers: { descriptor: Descriptor; diffId: string; path: string }[];
};

function parseReference(reference: string) {
  const match = /^([^/]+)\/(.+?)(?::([^:@/]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(reference);
  if (!match) throw new Error(`not an image reference: ${reference}`);
  const host = match[1] === "docker.io" ? "registry-1.docker.io" : match[1];
  return { host, repository: match[2], reference: match[4] ?? match[3] ?? "latest", pinned: match[4] };
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

async function blob(host: string, repository: string, descriptor: Descriptor, blobs: string): Promise<string> {
  const path = join(blobs, descriptor.digest);
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

/** Fetches IMAGE's manifest for linux/ARCH (amd64 or arm64), its config and
 * its layer blobs into BLOBS. A reference with @sha256: must match. */
export async function fetchImage(image: string, arch: string, blobs: string): Promise<Image> {
  mkdirSync(blobs, { recursive: true });
  const { host, repository, reference, pinned } = parseReference(image);
  let manifest = await json(host, repository, `manifests/${reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
  const index = manifest.digest;
  if (pinned && index !== pinned) throw new Error(`${image}: registry answered ${index}`);
  if (INDEX_TYPES.includes(manifest.body.mediaType) || manifest.body.manifests) {
    const chosen = (manifest.body.manifests as Descriptor[]).find(
      (m) => m.platform?.os === "linux" && m.platform.architecture === arch,
    );
    if (!chosen) throw new Error(`${image}: no linux/${arch} manifest`);
    manifest = await json(host, repository, `manifests/${chosen.digest}`, MANIFEST_TYPES);
    if (manifest.digest !== chosen.digest) throw new Error(`${image}: manifest digest mismatch`);
  }
  const config = JSON.parse(readFileSync(await blob(host, repository, manifest.body.config, blobs), "utf8"));
  const descriptors = manifest.body.layers as Descriptor[];
  const diffIds = config.rootfs.diff_ids as string[];
  if (descriptors.length !== diffIds.length) throw new Error(`${image}: ${descriptors.length} layers, ${diffIds.length} diff_ids`);
  const layers = [];
  for (const [i, descriptor] of descriptors.entries()) {
    layers.push({ descriptor, diffId: diffIds[i], path: await blob(host, repository, descriptor, blobs) });
  }
  return { image, index, manifest: manifest.digest, config, layers };
}
