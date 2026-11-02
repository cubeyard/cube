/**
 * Offline test for `serve`'s signal lifecycle (serveUntilStopped): a second
 * SIGINT or SIGTERM that cubed receives while it stops never kills it. The
 * child imports cubed, so the libraries cubed loads install their own signal
 * listeners as they do in `cubed serve` (signal-exit, through
 * proper-lockfile, re-raises a signal it sees alone). The second signal is
 * raised as the close reports "stopped", so libuv dispatches it after
 * serveUntilStopped's own continuation, which is when a back-to-back pair
 * from a terminal or supervisor lands in about one run in five. One
 * file read after it stands in for the I/O cubed still finishes then, so
 * the loop polls once more and reads the pending signal.
 *
 *   node packages/server/test/serve-signals-test.ts
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";

const index = path.resolve(import.meta.dirname, "../src/index.ts");
const child = `
import fs from "node:fs";
import http from "node:http";
import { serveUntilStopped } from ${JSON.stringify(index)};
const signal = process.argv[1];
const server = http.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = () => new Promise(resolve => server.close(() => resolve()));
const say = line => {
  console.log(line);
  if (line === "stopped") process.kill(process.pid, signal);
};
const served = serveUntilStopped({ server, close }, say);
process.kill(process.pid, signal);
await served;
await fs.promises.stat(${JSON.stringify(index)});
`;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", child, signal], { encoding: "utf8", timeout: 20000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.signal, null, `${signal} twice must not kill cubed:\n${output}`);
  assert.equal(run.status, 0, output);
  assert.match(run.stdout, new RegExp(`stopping: ${signal}; waiting`));
  assert.match(run.stdout, /^stopped$/m);
  assert.match(run.stdout, new RegExp(`stopping: ${signal} received while shutdown is already in progress`));
  console.log(`ok: a second ${signal} during the stop is reported and cubed exits 0 by itself`);
}
