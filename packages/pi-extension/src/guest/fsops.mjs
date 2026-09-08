// Guest-side filesystem helper for the cube pi-extension. Pushed into the
// cube (node 24 is in the cube image) and invoked once per tool operation:
//
//   node fsops.mjs <base64(json request)>
//
// The response is a single JSON object wrapped in sentinels so the host can
// extract it from exec output that may carry login-shell noise. Op-level
// failures come back as { error } with exit 0 — a non-zero exit or missing
// sentinel means the helper itself is broken/missing (host re-pushes it).
// This file must stay dependency-free plain ESM: it runs verbatim in the
// cube, outside the workspace, as the dev user.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SENTINEL_START = "<<<CUBE-FSOPS>>>";
export const SENTINEL_END = "<<<CUBE-FSOPS-END>>>";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const GREP_MAX_LINE_LENGTH = 500; // mirrors pi's grep line cap
const DEFAULT_GREP_LIMIT = 100;

function truncateLine(line) {
  if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, wasTruncated: true };
}

function matchesToolGlob(relativePath, pattern) {
  if (pattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, pattern) ||
      path.posix.matchesGlob(relativePath, `**/${pattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), pattern);
}

/**
 * Depth-first walk under root; visit(file, relativePath) → false stops.
 * Symlinks are NOT followed (fd/rg default): a symlinked entry is listed as
 * a leaf but never recursed into, so a workspace link to `/` cannot make a
 * search traverse the whole cube or loop.
 */
async function walkFiles(root, visit) {
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) return visit(root, path.posix.basename(root));

  async function walkDirectory(dir, relativeDir) {
    const entries = (await fs.readdir(dir)).sort();
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.posix.join(dir, entry);
      const rel = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch {
        continue; // vanished mid-walk — skip
      }
      if (stat.isSymbolicLink()) {
        if (!(await visit(full, rel))) return false; // leaf, no recursion
      } else if (stat.isDirectory()) {
        if (!(await walkDirectory(full, rel))) return false;
      } else if (stat.isFile()) {
        if (!(await visit(full, rel))) return false;
      }
    }
    return true;
  }
  return walkDirectory(root, "");
}

function createLineMatcher(pattern, literal, ignoreCase) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line) => regex.test(line);
}

function looksBinary(content) {
  return content.slice(0, 8192).includes("\u0000");
}

const ops = {
  async stat({ path: p }) {
    try {
      const stat = await fs.stat(p);
      return { exists: true, isDir: stat.isDirectory() };
    } catch {
      return { exists: false, isDir: false };
    }
  },

  async access({ path: p, write }) {
    await fs.access(p, fs.constants.R_OK | (write ? fs.constants.W_OK : 0));
    return {};
  },

  async readdir({ path: p }) {
    const names = (await fs.readdir(p)).sort();
    const entries = [];
    for (const name of names) {
      let isDir = false;
      try {
        isDir = (await fs.stat(path.posix.join(p, name))).isDirectory();
      } catch {
        // dangling symlink: list it, treat as a file
      }
      entries.push({ name, isDir });
    }
    return { entries };
  },

  async mkdir({ path: p }) {
    await fs.mkdir(p, { recursive: true });
    return {};
  },

  /**
   * Canonicalize a path inside THIS filesystem (symlinks dereference here,
   * never on the host). For a not-yet-existing tail (a file about to be
   * written), the longest existing prefix is resolved and the remainder
   * re-joined. `mode` is the resolved file's octal permissions when it
   * already exists (so a write preserves an executable bit instead of
   * flattening every file to 0644), null otherwise.
   */
  async resolve({ path: p }) {
    let target = path.posix.resolve(p);
    let rest = "";
    for (;;) {
      try {
        const real = await fs.realpath(target);
        const full = rest ? path.posix.join(real, rest) : real;
        let mode = null;
        try {
          mode = ((await fs.stat(full)).mode & 0o777).toString(8).padStart(4, "0");
        } catch {
          // tail does not exist yet — a fresh write
        }
        return { path: full, mode };
      } catch {
        const dir = path.posix.dirname(target);
        if (dir === target) return { path: rest ? path.posix.join(target, rest) : target, mode: null };
        rest = rest ? path.posix.join(path.posix.basename(target), rest) : path.posix.basename(target);
        target = dir;
      }
    }
  },

  async glob({ pattern, cwd, limit }) {
    const max = Math.max(1, limit ?? 1000);
    const paths = [];
    await walkFiles(cwd, (full, rel) => {
      if (matchesToolGlob(rel, pattern)) paths.push(full);
      return paths.length < max;
    });
    return { paths, limitReached: paths.length >= max };
  },

  /**
   * pi-grep semantics (ported from pi's gondolin example): line-based match
   * with optional context, per-line truncation, and a global match limit.
   * Output lines are pre-formatted `path:line: text` blocks; the host wraps
   * them into the tool result.
   */
  async grep({ pattern, path: p, glob, ignoreCase, literal, context, limit }) {
    const root = p;
    const rootStat = await fs.stat(root);
    const rootIsDirectory = rootStat.isDirectory();
    const matcher = createLineMatcher(pattern, literal, ignoreCase);
    const contextLines = context && context > 0 ? context : 0;
    const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
    const outputLines = [];
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;

    await walkFiles(root, async (full, rel) => {
      if (matchCount >= effectiveLimit) return false;
      if (glob && !matchesToolGlob(rel, glob)) return true;
      let content;
      try {
        content = await fs.readFile(full, "utf8");
      } catch {
        return true;
      }
      if (looksBinary(content)) return true;
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? rel : path.posix.basename(full);
      for (let index = 0; index < lines.length; index++) {
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        const start = contextLines > 0 ? Math.max(0, index - contextLines) : index;
        const end = contextLines > 0 ? Math.min(lines.length - 1, index + contextLines) : index;
        for (let i = start; i <= end; i++) {
          const { text, wasTruncated } = truncateLine((lines[i] ?? "").replace(/\r/g, ""));
          if (wasTruncated) linesTruncated = true;
          const separator = i === index ? ":" : "-";
          outputLines.push(`${displayPath}${separator}${i + 1}${separator} ${text}`);
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    });

    return { lines: outputLines, matchCount, matchLimitReached, linesTruncated, limit: effectiveLimit };
  },
};

async function main() {
  let response;
  try {
    const request = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"));
    const op = ops[request.op];
    if (!op) throw new Error(`unknown op: ${request.op}`);
    response = await op(request);
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${SENTINEL_START}${JSON.stringify(response)}${SENTINEL_END}\n`);
}

// Only run as a CLI — the host-side test suite imports this module for its
// sentinel constants without triggering an op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
