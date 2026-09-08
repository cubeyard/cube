/**
 * Host↔guest path mapping for the cube extension (same semantics as pi's
 * gondolin example): paths inside the host workspace map onto the guest
 * workspace; every other absolute path resolves inside the cube's own
 * filesystem — never on the host.
 */
import path from "node:path";

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  // `..` alone or `../x` is outside; `..env` is a file inside.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Map a tool-supplied path to a guest path. `hostWorkspace` is where pi
 * runs (the workspace's host directory), `guestWorkspace` is its mount
 * point inside the cube. Relative paths resolve against the guest
 * workspace; absolute host-workspace paths are re-rooted onto it; any
 * other absolute path is taken as a guest path verbatim.
 */
export function toGuestPath(hostWorkspace: string, guestWorkspace: string, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return guestWorkspace;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(hostWorkspace, trimmed)) {
      const rel = path.relative(hostWorkspace, trimmed);
      return rel ? path.posix.join(guestWorkspace, toPosix(rel)) : guestWorkspace;
    }
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(guestWorkspace, toPosix(trimmed));
}
