/**
 * Offline test for `serve`'s signal lifecycle (serveUntilStopped). The child
 * imports cubed, so the libraries cubed loads install their own signal
 * listeners as they do in `cubed serve` (signal-exit, through
 * proper-lockfile, re-raises a signal it sees alone).
 *
 * A second SIGINT or SIGTERM sent during the stop never kills cubed. The
 * child raises it as the close reports "stopped", so libuv dispatches it
 * after serveUntilStopped's own continuation, which is when a back-to-back
 * pair from a terminal lands in 13 of 100 real cubed stops on a Linux VM.
 * One file read after it stands in for the I/O cubed still finishes then,
 * so the loop polls once more and reads the pending signal.
 *
 * A signal sent after "stopped" still ends a cubed whose close left a
 * handle open, the way out when it does not exit by itself.
 *
 *   node packages/server/test/serve-signals-test.ts
 */
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import path from "node:path";

const index = path.resolve(import.meta.dirname, "../src/index.ts");
const child = `
import fs from "node:fs";
import http from "node:http";
import { serveUntilStopped } from ${JSON.stringify(index)};
const [signal, mode] = process.argv.slice(1);
const server = http.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = () => new Promise(resolve => server.close(() => {
  if (mode === "leak") setInterval(() => {}, 1000);
  resolve();
}));
const say = line => {
  console.log(line);
  if (line === "stopped" && mode === "pending") process.kill(process.pid, signal);
};
const served = serveUntilStopped({ server, close }, say);
if (mode === "pending") process.kill(process.pid, signal);
else console.log("serving");
await served;
await fs.promises.stat(${JSON.stringify(index)});
`;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", child, signal, "pending"], { encoding: "utf8", timeout: 20000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.signal, null, `${signal} twice must not kill cubed:\n${output}`);
  assert.equal(run.status, 0, output);
  assert.match(run.stdout, new RegExp(`stopping: ${signal}; waiting`));
  assert.match(run.stdout, /^stopped$/m);
  assert.match(run.stdout, new RegExp(`${signal} received`), `the second ${signal} is reported:\n${output}`);
  console.log(`ok: a second ${signal} during the stop is reported and cubed exits 0`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const leaked = spawn(process.execPath, ["--input-type=module", "-e", child, signal, "leak"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(leaked, "close");
  let output = "", first = false;
  leaked.stderr.on("data", chunk => { output += String(chunk); });
  for await (const [chunk] of on(leaked.stdout, "data", { signal: AbortSignal.timeout(15000) })) {
    output += String(chunk);
    if (output.includes("serving") && !first) first = leaked.kill(signal);
    if (/^stopped$/m.test(output)) break;
  }
  leaked.stdout.on("data", chunk => { output += String(chunk); });
  assert.equal(leaked.exitCode, null, `the close left a handle open, so cubed is still running:\n${output}`);
  leaked.kill(signal);
  const ended = await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 10000, "running"))]);
  if (ended === "running") leaked.kill("SIGKILL");
  assert.notEqual(ended, "running", `a ${signal} after "stopped" must end a cubed that did not exit:\n${output}`);
  const [code, killed] = ended as [number | null, NodeJS.Signals | null];
  assert.equal(killed, null, output);
  assert.equal(code, 0, output);
  assert.match(output, new RegExp(`${signal} received`), `the later ${signal} is reported:\n${output}`);
  console.log(`ok: a ${signal} after the stop ends a cubed whose close left a handle open`);
}
