import fs from "node:fs";
import path from "node:path";

/** Remove an exclusively owned, quiescent guest tree. Call only after the
 * instance is stopped/destroyed: no guest may rename entries during traversal.
 * Repair directory permissions, never follow symlinks or chmod file hardlinks.
 * Foreign-owned directories can still fail; callers must retain a cleanup
 * marker rather than making the whole daemon unavailable. */
export function removeStoppedTree(root: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isDirectory()) {
    // This is safe only under the explicit quiescence contract above.
    fs.chmodSync(root, (stat.mode & 0o777) | 0o700);
    for (const entry of fs.readdirSync(root)) removeStoppedTree(path.join(root, entry));
    fs.rmdirSync(root);
  } else {
    fs.unlinkSync(root);
  }
}
