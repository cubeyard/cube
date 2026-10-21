/** Test only: the `machines:` line of `berth vm`'s banner, read exactly as
 * berth writes it (packages/berth/src/vm/mod.rs, the banner's `machines:`
 * format), so a test asserts the counts themselves rather than a prefix.
 * berth-banner-test.ts holds this to berth's own format string. */

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
