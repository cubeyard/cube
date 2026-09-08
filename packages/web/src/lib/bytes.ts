/** Decimal units, like a disk-usage readout: "512 B", "4.2 kB", "1.2 MB".
 * One decimal below 10, whole numbers above — terse next to a path. */
export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let v = n;
  for (const unit of ["kB", "MB", "GB", "TB"]) {
    v /= 1000;
    if (v < 1000) return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
  }
  return `${Math.round(v)} PB`;
}
