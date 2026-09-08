/**
 * Host-side workspace file access for the thread-first API. A thread's
 * workspace lives on the host (bind-mounted into the sandbox), so listing
 * and serving files needs no running instance — a sleeping thread's images
 * still render and its files stay browsable.
 *
 * The workspace is agent-writable and therefore hostile, including
 * CONCURRENTLY hostile (the agent can swap paths mid-request):
 *
 * - Serving is descriptor-based: open with O_NOFOLLOW, then verify the
 *   OPENED file's real path (via /proc/self/fd — cubed is Linux-only,
 *   incus is the sandbox) sits inside the workspace, then stream from
 *   that same descriptor. There is no checked-path/used-path gap.
 * - The walk iterates with opendir (bounded memory even for a
 *   maliciously wide directory) and re-checks every entry with lstat —
 *   never following symlinks. A directory swapped for a symlink between
 *   lstat and its opendir can, at worst, leak metadata (names/sizes) of
 *   a host tree for one request, never contents; the visit cap bounds
 *   the walk either way.
 */
import fs from "node:fs";
import path from "node:path";

export interface WorkspaceFile {
  /** Workspace-relative path, "/"-separated. */
  path: string;
  size: number;
  mtime: number;
}

export interface WorkspaceListing {
  /** Newest first. Contents of `.git` and `node_modules` are counted in
   * `totalBytes` but not listed — they are machinery, not the thread's work. */
  files: WorkspaceFile[];
  totalBytes: number;
  /** True when a cap was hit — the listing (or the byte total) is partial. */
  truncated: boolean;
}

/** Directories whose contents count as disk usage but not as "what this
 * thread changed" (universal tooling noise). */
const SUPPRESSED_DIRS = new Set([".git", "node_modules"]);

export interface WalkCaps {
  /** Max entries in `files` (the NEWEST ones — sorting happens before
   * this cap, so an old bulk directory cannot crowd out fresh work). */
  maxListed: number;
  /** Max directory entries visited in total (CPU/latency/memory bound). */
  maxVisited: number;
}

const DEFAULT_CAPS: WalkCaps = { maxListed: 2000, maxVisited: 50_000 };

export function listWorkspaceFiles(root: string, caps: WalkCaps = DEFAULT_CAPS): WorkspaceListing {
  const rootAbs = path.resolve(root);
  const listing: WorkspaceListing = { files: [], totalBytes: 0, truncated: false };
  if (!fs.existsSync(rootAbs)) return listing; // pre-provision: no dir yet
  let visited = 0;

  const walk = (dirPath: string, rel: string, listed: boolean): void => {
    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(dirPath);
    } catch {
      return; // unreadable (or just-swapped) directory — skip, not fail
    }
    try {
      let entry: fs.Dirent | null;
      while ((entry = dir.readSync()) !== null) {
        if (++visited > caps.maxVisited) {
          listing.truncated = true;
          return;
        }
        const abs = path.join(dirPath, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        // lstat (never follows symlinks) is the authority, not the dirent:
        // the entry may have been swapped since readdir batched it.
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(abs, childRel, listed && !SUPPRESSED_DIRS.has(entry.name));
        } else if (stat.isFile()) {
          listing.totalBytes += stat.size;
          if (listed) {
            listing.files.push({ path: childRel, size: stat.size, mtime: Math.round(stat.mtimeMs) });
          }
        }
        // symlinks and other node types: never followed, never listed
      }
    } finally {
      dir.closeSync();
    }
  };

  walk(rootAbs, "", true);
  listing.files.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
  if (listing.files.length > caps.maxListed) {
    listing.files.length = caps.maxListed;
    listing.truncated = true;
  }
  return listing;
}

export interface OpenWorkspaceFile {
  /** Open read-only descriptor — the caller streams from and closes it. */
  fd: number;
  size: number;
  mtime: Date;
}

/**
 * Open a workspace-relative path for serving, or return null (missing, a
 * directory, or escaping the workspace via ../ or symlink). The containment
 * check runs on the descriptor actually opened — a path swapped to a
 * symlink after the check cannot redirect what gets streamed.
 */
export function openWorkspaceFile(root: string, rel: string): OpenWorkspaceFile | null {
  if (rel.includes("\0")) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink as the final component fails the open outright.
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    // An intermediate symlinked directory still follows on open — resolve
    // what this DESCRIPTOR points at and require it inside the workspace.
    const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
    const realRoot = fs.realpathSync(rootAbs);
    if (
      !stat.isFile() ||
      (real !== realRoot && !real.startsWith(realRoot + path.sep))
    ) {
      fs.closeSync(fd);
      return null;
    }
    return { fd, size: stat.size, mtime: stat.mtime };
  } catch {
    fs.closeSync(fd);
    return null;
  }
}
