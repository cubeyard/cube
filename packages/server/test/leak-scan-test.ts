/** leak-scan.ts, the host side of runner-vm-test's token scan: a directory
 * like a running machine's (a listening unix socket, a FIFO, a symlink)
 * is scanned without reading them and without failing; the secret is found
 * in a nested file, at every offset across a chunk boundary and at the end
 * of a file; an unreadable file or directory fails the scan. The macOS gate
 * of #167 failed because BSD grep exits 2 on such a socket. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanForSecret } from "./leak-scan.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "leak-scan-")));
const secret = "ghs_leakscan0123456789abcdef";
const server = net.createServer();
try {
  const machine = path.join(root, "m", "0123456789abcdef");
  fs.mkdirSync(path.join(machine, "deep"), { recursive: true });
  fs.writeFileSync(path.join(machine, "machine.json"), "{}\n");
  fs.writeFileSync(path.join(machine, "deep", "events.log"), "nothing here\n");
  await new Promise<void>(resolve => server.listen(path.join(machine, "qmp.sock"), resolve));
  assert.equal(spawnSync("mkfifo", [path.join(machine, "pipe")]).status, 0);
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, `the secret ${secret} outside the roots\n`);
  fs.symlinkSync(outside, path.join(machine, "link"));
  const grep = spawnSync("grep", ["-rlsF", "-e", secret, path.join(root, "m")], { encoding: "utf8" });

  // Absent: no match; the socket, FIFO and symlink are listed, not read (a FIFO read would block).
  const clean = scanForSecret([path.join(root, "m")], secret);
  assert.deepEqual(clean.matches, []);
  assert.equal(clean.files, 2);
  assert.deepEqual(clean.skipped.map(s => [path.basename(s.path), s.kind]), [["link", "symlink"], ["pipe", "fifo"], ["qmp.sock", "socket"]]);

  // Present in a nested file, among the special entries.
  fs.writeFileSync(path.join(machine, "deep", "leaked.log"), `x\nAuthorization: Bearer ${secret}\n`);
  assert.deepEqual(scanForSecret([path.join(root, "m")], secret).matches, [path.join(machine, "deep", "leaked.log")]);
  fs.rmSync(path.join(machine, "deep", "leaked.log"));
  // Across every chunk boundary (32-byte chunks), at the very end, and in a 3 MiB file.
  const split = path.join(root, "split");
  fs.mkdirSync(split);
  for (let offset = 0; offset < 40; offset++) {
    fs.writeFileSync(path.join(split, "f"), Buffer.concat([Buffer.alloc(offset, "y"), Buffer.from(secret)]));
    assert.equal(scanForSecret([split], secret, 32).matches.length, 1, `offset ${offset}`);
    fs.writeFileSync(path.join(split, "f"), Buffer.concat([Buffer.alloc(offset, "y"), Buffer.from(secret.slice(0, -1))]));
    assert.equal(scanForSecret([split], secret, 32).matches.length, 0, `a prefix at offset ${offset} is no match`);
  }
  fs.writeFileSync(path.join(split, "f"), Buffer.concat([Buffer.alloc((3 << 20) - 5, 0), Buffer.from(secret)]));
  const big = scanForSecret([split], secret);
  assert.equal(big.matches.length, 1);
  assert.equal(big.bytes, (3 << 20) - 5 + secret.length);

  // An unreadable file or directory fails the scan (root reads anything, so only as a user).
  if (process.getuid?.() !== 0) {
    const locked = path.join(machine, "locked.log");
    fs.writeFileSync(locked, "x");
    fs.chmodSync(locked, 0);
    assert.throws(() => scanForSecret([path.join(root, "m")], secret), /EACCES/);
    fs.rmSync(locked);
    fs.chmodSync(path.join(machine, "deep"), 0);
    assert.throws(() => scanForSecret([path.join(root, "m")], secret), /EACCES/);
    fs.chmodSync(path.join(machine, "deep"), 0o700);
  }
  assert.throws(() => scanForSecret([path.join(root, "missing")], secret), /ENOENT/, "a missing root is an error");
  console.log(`ok: leak scan: socket, FIFO and symlink listed and not read (this host's grep -rlsF on the same directory: status ${grep.status}), the secret found nested, across chunk boundaries and in 3 MiB, unreadable entries fail`);
} finally {
  server.close();
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
}
