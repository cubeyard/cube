/** The host side of a token leak scan, without grep: grep differs between
 * hosts (GNU grep skips sockets, FIFOs and devices under -r; macOS's BSD
 * grep tries to read a unix socket and exits 2, so its "no match" says
 * nothing). This walks the roots with lstat and never follows a symlink.
 * Every regular file is read in full, in chunks that overlap by the
 * secret's length less one byte, so a match across a chunk boundary is
 * found. Anything else that is not a directory is not read and is listed
 * in `skipped`, for the caller to judge. Any error listing a directory,
 * reading an entry's type or reading a file throws: no part of a root goes
 * unscanned without a failure. */
import fs from "node:fs";
import path from "node:path";

export interface LeakScan {
  /** Regular files that hold the secret. */
  matches: string[];
  files: number;
  bytes: number;
  /** Entries neither a regular file nor a directory, by kind. */
  skipped: Array<{ path: string; kind: "socket" | "fifo" | "symlink" | "device" | "other" }>;
}

const CHUNK = 1 << 20;

export function scanForSecret(roots: readonly string[], secret: string, chunkBytes = CHUNK): LeakScan {
  const needle = Buffer.from(secret);
  if (!needle.length) throw new Error("an empty secret matches everything");
  if (chunkBytes < needle.length) throw new Error("a chunk must hold the secret");
  const scan: LeakScan = { matches: [], files: 0, bytes: 0, skipped: [] };
  const buffer = Buffer.alloc(chunkBytes + needle.length - 1);
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
      return;
    }
    if (!stat.isFile()) {
      const kind = stat.isSocket() ? "socket" : stat.isFIFO() ? "fifo" : stat.isSymbolicLink() ? "symlink"
        : stat.isBlockDevice() || stat.isCharacterDevice() ? "device" : "other";
      scan.skipped.push({ path: entry, kind });
      return;
    }
    scan.files++;
    const fd = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      let kept = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, kept, chunkBytes, null);
        if (read === 0) break;
        scan.bytes += read;
        const filled = kept + read;
        if (buffer.subarray(0, filled).includes(needle)) { scan.matches.push(entry); return; }
        // The tail that could start a match continuing in the next chunk.
        kept = Math.min(needle.length - 1, filled);
        buffer.copy(buffer, 0, filled - kept, filled);
      }
    } finally { fs.closeSync(fd); }
  };
  for (const root of roots) visit(root);
  return scan;
}
