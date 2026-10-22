/** Test only: the `machines:` and `image:` lines of `berth vm`'s banner,
 * read exactly as berth writes them (packages/berth/src/vm/mod.rs), so a
 * test asserts their values rather than a prefix. berth-banner-test.ts
 * holds both to berth's own format strings. */

export interface BannerMachines { machines: number; interrupted: number; suspended: number; atOnce: number }

const LINE = /^machines: (\d+) \((\d+) interrupted, (\d+) suspended; at most (\d+) at once, a suspended one holding none\)$/;

/** The counts of the banner's one `machines:` line; throws when there is no
 * such line, more than one, or one in another shape. */
export function bannerMachines(banner: string): BannerMachines {
  const lines = banner.split("\n").filter(line => line.startsWith("machines:"));
  if (lines.length !== 1) throw new Error(`the banner has ${lines.length} machines: lines: ${JSON.stringify(banner)}`);
  const match = LINE.exec(lines[0]!);
  if (!match) throw new Error(`the banner's machines: line is not berth's: ${JSON.stringify(lines[0])}`);
  const [machines, interrupted, suspended, atOnce] = match.slice(1).map(Number) as [number, number, number, number];
  return { machines, interrupted, suspended, atOnce };
}

/** The banner's one image summary line (packages/berth/src/vm/mod.rs, the
 * `image: {} ({}, {} layers, manifest {}){}` format): the reference, the
 * platform, the image's own layer count and manifest, and the Debian
 * preparation layer when berth serves cube's default image (`; prepared
 * for cube by layer <diff_id> (<packages>)`, debian.rs), else null. */
export interface BannerImage { reference: string; platform: string; layers: number; manifest: string; prepared: string | null }

/** What berth's preparation layer brings, as its suffix names it
 * (packages/berth/debian/trixie.json `requested`). */
export const PREPARED_PACKAGES = "sudo, git, gh, curl, ca-certificates";
const IMAGE = new RegExp("^image: (\\S+) \\((linux/(?:amd64|arm64)), (\\d+) layers, manifest (sha256:[0-9a-f]{64})\\)"
  + `(?:; prepared for cube by layer (sha256:[0-9a-f]{64}) \\(${PREPARED_PACKAGES}\\))?$`);

/** Throws when the banner has no such line, more than one, or one in
 * another shape (a manifest that is not a sha256, any other suffix). */
export function bannerImage(banner: string): BannerImage {
  // The summary, not berth's pull progress (`image: … is in …`, `…; pulling …`).
  const lines = banner.split("\n").filter(line => line.startsWith("image: ") && line.includes(" (linux/"));
  if (lines.length !== 1) throw new Error(`the banner has ${lines.length} image summary lines: ${JSON.stringify(banner)}`);
  const match = IMAGE.exec(lines[0]!);
  if (!match) throw new Error(`the banner's image line is not berth's: ${JSON.stringify(lines[0])}`);
  return { reference: match[1]!, platform: match[2]!, layers: Number(match[3]), manifest: match[4]!, prepared: match[5] ?? null };
}
