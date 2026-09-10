import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lifecycle } from "../src/lifecycle.ts";
import type { Sandbox } from "@cube/sandbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-lifecycle-"));
try {
  const lifecycle = new Lifecycle(root);
  const limits: number[] = [];
  const sandbox: Sandbox = {
    name: "fixture",
    async exec(command, options) {
      assert.match(command, /must be executable/);
      assert.equal(options.cwd, "/workspace");
      limits.push(options.timeout!);
      options.onData(Buffer.alloc(2 * 1024 * 1024, "x"));
      options.onData(Buffer.from("decisive failure\n"));
      return { exitCode: 7 };
    },
  };
  assert.match((await lifecycle.run("test", sandbox, "setup"))!, /exit 7.*decisive failure/);
  assert.equal(lifecycle.read("test", "setup")!.state, "failed");
  assert.ok(lifecycle.read("test", "setup")!.durationMs! >= 0);
  assert.ok(Buffer.byteLength(lifecycle.log("test", "setup")) < 1024 * 1024 + 256);
  assert.match(lifecycle.log("test", "setup"), /output truncated/);
  assert.match(lifecycle.log("test", "setup"), /decisive failure/);
  await lifecycle.run("test", sandbox, "resume");
  assert.deepEqual(limits, [1200, 10]);
  const timeout: Sandbox = { name: "timeout", exec: async (_command, options) => {
    options.onData(Buffer.alloc(2 * 1024 * 1024, "y"));
    options.onData(Buffer.from("last timeout diagnostic"));
    throw new Error("timeout:10");
  } };
  assert.match((await lifecycle.run("test", timeout, "resume"))!, /timeout:10/);
  assert.match(lifecycle.read("test", "resume")!.error!, /last timeout diagnostic/);
  assert.match(lifecycle.log("test", "resume"), /last timeout diagnostic/);
  const restarted = new Lifecycle(root);
  assert.equal(restarted.read("test", "resume")!.state, "failed");
  assert.equal(fs.existsSync(path.join(root, "test", "resume.log.previous")), true);

  // Real output callbacks run on an event stack outside the exec promise.
  // A log write failure must abort execution, not escape that event callback.
  const brokenLog = path.join(root, "disk-error", "setup.log");
  let aborted = false;
  const asynchronous: Sandbox = { name: "async", exec: (_command, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => { aborted = true; reject(options.signal!.reason); }, { once: true });
    setImmediate(() => {
      try {
        fs.unlinkSync(brokenLog);
        fs.mkdirSync(brokenLog); // force EISDIR on append without affecting metadata
        assert.doesNotThrow(() => options.onData(Buffer.from("late output")));
        assert.equal(aborted, true);
      } catch (error) { reject(error); }
    });
  }) };
  assert.match((await lifecycle.run("disk-error", asynchronous, "setup"))!, /log write failed.*EISDIR/);
  assert.equal(aborted, true);
  assert.equal(lifecycle.read("disk-error", "setup")!.state, "failed");

  // The environment directory is host-composed and lands in a shell
  // command: the script path appears quoted and relative to /workspace
  // (so /repos resolves as ../repos in the guest and in the mock alike);
  // anything outside the validated alphabet is refused before any exec.
  const seen: string[] = [];
  const elsewhere: Sandbox = { name: "elsewhere", exec: async (command, options) => {
    seen.push(command);
    assert.equal(options.cwd, "/workspace");
    return { exitCode: 0 };
  } };
  assert.equal(await lifecycle.run("elsewhere", elsewhere, "setup", { directory: "../repos/envs/app/.cube" }), null);
  assert.match(seen[0]!, /\[ -e '\.\/\.\.\/repos\/envs\/app\/\.cube\/setup' \]/);
  assert.match(seen[0]!, /'\.\/\.\.\/repos\/envs\/app\/\.cube\/setup'; fi$/);
  assert.equal(await lifecycle.run("elsewhere", elsewhere, "resume"), null);
  assert.match(seen[1]!, /'\.\/\.cube\/resume'/);
  await assert.rejects(
    lifecycle.run("elsewhere", elsewhere, "setup", { directory: "../repos/x'; id; '/.cube" }),
    /invalid environment directory/,
  );
  assert.equal(seen.length, 2, "no exec for a refused directory");
  lifecycle.forget("test");
  assert.equal(restarted.read("test", "setup"), null);
  console.log("PASS: lifecycle durable bounded logs, failure evidence, rotation and timeout contracts");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
