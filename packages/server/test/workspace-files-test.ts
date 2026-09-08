/**
 * Offline unit test for workspace file listing/serving: suppression of
 * tooling dirs, byte accounting, caps, newest-first order, and the
 * containment guards (../ and symlink escapes).
 *
 *   node packages/server/test/workspace-files-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listWorkspaceFiles, openWorkspaceFile } from "../src/workspace-files.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cube-wsf-"));
const root = path.join(base, "workspace");
const outside = path.join(base, "outside.txt");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
fs.writeFileSync(outside, "host secret");
fs.writeFileSync(path.join(root, "readme.md"), "hello");             // 5 B
fs.writeFileSync(path.join(root, "src", "main.ts"), "x".repeat(10)); // 10 B
fs.writeFileSync(path.join(root, ".git", "objects", "aa"), "y".repeat(20));
fs.writeFileSync(path.join(root, "node_modules", "pkg", "i.js"), "z".repeat(40));
fs.symlinkSync(outside, path.join(root, "leak.txt"));
fs.symlinkSync(path.dirname(outside), path.join(root, "leakdir"));
// distinct mtimes for the order check
fs.utimesSync(path.join(root, "readme.md"), new Date(1000_000), new Date(1000_000));
fs.utimesSync(path.join(root, "src", "main.ts"), new Date(2000_000), new Date(2000_000));

// --- listing: suppressed dirs counted but not listed; symlinks ignored
const listing = listWorkspaceFiles(root);
assert.deepEqual(listing.files.map((f) => f.path), ["src/main.ts", "readme.md"]);
assert.equal(listing.totalBytes, 5 + 10 + 20 + 40); // symlink target NOT counted
assert.equal(listing.truncated, false);
assert.equal(listing.files[0]!.size, 10);
console.log("1 ok: listing suppresses tooling dirs, skips symlinks, newest first");

// --- caps mark truncation; the listed cap keeps the NEWEST files
const capped = listWorkspaceFiles(root, { maxListed: 1, maxVisited: 50_000 });
assert.deepEqual(capped.files.map((f) => f.path), ["src/main.ts"]);
assert.equal(capped.truncated, true);
const visitCapped = listWorkspaceFiles(root, { maxListed: 2000, maxVisited: 2 });
assert.equal(visitCapped.truncated, true);
console.log("2 ok: caps mark the listing truncated, newest files win the cap");

// --- missing root: empty listing, no throw
assert.deepEqual(listWorkspaceFiles(path.join(base, "nope")), { files: [], totalBytes: 0, truncated: false });
console.log("3 ok: missing workspace lists empty");

// --- serving: plain file opens (and the fd reads); escapes and non-files do not
const opened = openWorkspaceFile(root, "src/main.ts");
assert.equal(opened!.size, 10);
assert.equal(fs.readFileSync(opened!.fd, "utf8"), "x".repeat(10));
fs.closeSync(opened!.fd);
const dotted = openWorkspaceFile(root, "./readme.md");
assert.equal(dotted!.size, 5);
fs.closeSync(dotted!.fd);
assert.equal(openWorkspaceFile(root, "../outside.txt"), null);
assert.equal(openWorkspaceFile(root, "/etc/passwd"), null); // absolute path escapes the root
assert.equal(openWorkspaceFile(root, "leak.txt"), null);    // symlink out (O_NOFOLLOW)
assert.equal(openWorkspaceFile(root, "leakdir/outside.txt"), null); // symlinked dir out (fd realpath)
assert.equal(openWorkspaceFile(root, "src"), null);         // directory
assert.equal(openWorkspaceFile(root, "missing.txt"), null);
assert.equal(openWorkspaceFile(root, "a\0b"), null);
// symlink INSIDE the workspace: still refused (serving never follows links)
fs.symlinkSync(path.join(root, "readme.md"), path.join(root, "inlink.md"));
assert.equal(openWorkspaceFile(root, "inlink.md"), null);
console.log("4 ok: containment — ../, symlink file/dir escapes, dirs, missing all rejected");

fs.rmSync(base, { recursive: true, force: true });
console.log("workspace-files-test: all ok");
