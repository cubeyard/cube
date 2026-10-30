/** verify-cube's safety: what cleanup may stop and delete (with stand-ins
 * for /proc and ps, so the macOS path is checked on any host), launches
 * that fail part way leaving nothing behind, never touching a scratch
 * directory it did not create, and evidence never overwritten. Drives the
 * real helper; needs a built UI (pnpm build), not a browser. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { freshDirectory, isServeOf, OWNER_FILE, parsePort, planCleanup, PS_ARGS, readCommand, type System } from "./verify-cube-lib.ts";

const HELPER = path.join(import.meta.dirname, "verify-cube.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cube-test-"));

// Whose process a pid is: /proc first, then ps, else unknown.
assert.equal(readCommand(1, [() => null, () => "node verify-cube.ts serve --run /r"]), "node verify-cube.ts serve --run /r", "no /proc (macOS): ps answers");
assert.equal(readCommand(1, [() => null, () => null]), null, "neither answers: unknown");
assert.match(readCommand(process.pid) ?? "", /verify-cube-test\.ts/, "this host reads its own command");
assert.ok(isServeOf("/usr/bin/node /w/verify-cube.ts serve --run /tmp/r --port 7790", "/tmp/r"));
assert.ok(!isServeOf("/usr/bin/node /w/verify-cube.ts run --run /tmp/r", "/tmp/r"), "a run is not a served instance");
assert.ok(!isServeOf("/usr/bin/node /w/verify-cube.ts serve --run /tmp/other", "/tmp/r"), "another run's serve is not this one");
assert.ok(!isServeOf("/usr/bin/node /w/verify-cube.ts serve --run /tmp/r2 --port 7790", "/tmp/r"), "/tmp/r2 is not /tmp/r");
assert.ok(!isServeOf("/usr/bin/node /w/verify-cube.ts serve --run /tmp/r/sub", "/tmp/r"), "/tmp/r/sub is not /tmp/r");
assert.ok(isServeOf("/usr/bin/node /w/verify-cube.ts serve --port 7790 --run /tmp/r", "/tmp/r"), "--run last");
assert.ok(isServeOf("node verify-cube.ts serve --run /tmp/a+b(1) --port 1", "/tmp/a+b(1)"), "a path with regex characters");
assert.deepEqual([...PS_ARGS], ["-ww", "-o", "command=", "-p"], "ps prints the whole command line (macOS cuts it to the terminal width otherwise)");
const longRun = `/tmp/verify-cube/${"a-long-run-directory-name/".repeat(8)}run`;
const longServe = `/opt/homebrew/bin/node /Users/someone/src/cube/packages/web/test/browser/verify-cube.ts serve --run ${longRun} --port 7790 --host 0.0.0.0`;
assert.ok(longServe.length > 300 && isServeOf(longServe, longRun), "a long serve command is recognized whole");
console.log("ok: process identity reads /proc, else ps -ww, else nothing; long command lines match");

const sys = (alive: boolean, command: string | null): System => ({ alive: () => alive, command: () => command });
const instance = { pid: 42, runArg: "/tmp/r", owner: "t1" };
const serving = "node verify-cube.ts serve --run /tmp/r --port 7790";
let plan = planCleanup({ instance, scratchOwner: "t1", scratchExists: true }, sys(true, null));
assert.deepEqual([plan.stop, plan.removeScratch, plan.removeInstance, plan.ok], [false, false, false, false], "alive and unreadable: nothing stopped or deleted");
plan = planCleanup({ instance, scratchOwner: "t1", scratchExists: true }, sys(true, serving));
assert.deepEqual([plan.stop, plan.removeScratch, plan.removeInstance, plan.ok], [true, true, true, true], "our live serve: stopped and removed");
plan = planCleanup({ instance, scratchOwner: "t1", scratchExists: true }, sys(true, "vim notes.txt"));
assert.deepEqual([plan.stop, plan.removeScratch, plan.ok], [false, true, true], "a reused pid is never stopped; our scratch still goes");
const truncated = { pid: 42, runArg: longRun, owner: "t1" };
plan = planCleanup({ instance: truncated, scratchOwner: "t1", scratchExists: true }, sys(true, longServe.slice(0, 120)));
assert.deepEqual([plan.stop, plan.removeScratch, plan.removeInstance, plan.ok], [false, false, false, false], "a truncated verify-cube command: nothing stopped or deleted");
plan = planCleanup({ instance: truncated, scratchOwner: "t1", scratchExists: true }, sys(true, longServe));
assert.deepEqual([plan.stop, plan.removeScratch, plan.removeInstance, plan.ok], [true, true, true, true], "the whole long command: stopped and removed");
plan = planCleanup({ instance, scratchOwner: "t1", scratchExists: true }, sys(true, "node /w/verify-cube.ts serve --run /tmp/r2 --port 7791"));
assert.deepEqual([plan.stop, plan.removeScratch, plan.ok], [false, false, false], "another run's verify-cube on the pid: fail closed");
plan = planCleanup({ instance, scratchOwner: "t2", scratchExists: true }, sys(false, null));
assert.deepEqual([plan.stop, plan.removeScratch, plan.ok], [false, false, false], "another launch's scratch stays");
plan = planCleanup({ instance: null, scratchOwner: null, scratchExists: true }, sys(false, null));
assert.deepEqual([plan.removeScratch, plan.removeInstance, plan.ok], [false, false, false], "no owner file: left alone");
plan = planCleanup({ instance: null, scratchOwner: "t9", scratchExists: true }, sys(false, null));
assert.equal(plan.removeScratch, true, "a launch's leftover scratch (owner file, no instance) goes");
console.log("ok: cleanup stops only our serve, deletes only owned scratch, and nothing while an unknown process may use it");

const evidence = path.join(root, "fresh");
assert.deepEqual([freshDirectory(evidence, "cli"), freshDirectory(evidence, "cli"), freshDirectory(evidence, "cli")].map(d => path.basename(d)), ["cli", "cli-2", "cli-3"]);
assert.equal(parsePort("7790", 1), 7790);
for (const [raw, min] of [["nope", 0], ["0", 1], ["70000", 0], ["79.5", 0], ["-1", 0], ["", 0], ["0x1f", 0]] as const) assert.throws(() => parsePort(raw, min), /--port must be/, raw);
console.log("ok: evidence directories are never reused; ports are strict");

const helper = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [HELPER, ...args],
  { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", env: { ...process.env, CUBED_LOG_LEVEL: "error", ...env } });
/** The helper without blocking this process, so it can reap a child the helper stops. */
const helperAsync = async (args: string[]) => {
  const child = spawn(process.execPath, [HELPER, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CUBED_LOG_LEVEL: "error" } });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  const [status] = await once(child, "exit") as [number | null];
  return { status, stdout };
};
const freePort = async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
};
const left = (run: string) => ["scratch", "instance.json"].filter(name => fs.existsSync(path.join(run, name)));

try {
  // The reviewer's case: an existing scratch is refused by run and left by cleanup.
  const foreign = path.join(root, "foreign");
  fs.mkdirSync(path.join(foreign, "scratch"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "scratch", "keep.txt"), "mine\n");
  let result = helper(["run", "--run", foreign, "cli"]);
  assert.notEqual(result.status, 0, "run refuses an existing scratch");
  assert.match(result.stderr, /already exists: verify-cube uses only a scratch directory it creates/);
  result = helper(["cleanup", "--run", foreign]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /no verify-cube owner file: left alone/);
  assert.equal(fs.readFileSync(path.join(foreign, "scratch", "keep.txt"), "utf8"), "mine\n", "keep.txt survives run and cleanup");
  console.log("ok: a scratch directory verify-cube did not create survives run and cleanup");

  // A launch that fails part way leaves no scratch and no instance file.
  for (const stage of ["project", "instance"]) {
    const run = path.join(root, `fail-${stage}`);
    result = helper(["run", "--run", run, "cli"], { CUBE_VERIFY_FAIL: stage });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`injected failure ${stage === "project" ? "before seeding" : "after writing"}`));
    assert.deepEqual(left(run), [], `nothing left after a failure at ${stage}`);
  }
  const busy = net.createServer().listen(0, "127.0.0.1");
  await once(busy, "listening");
  const taken = path.join(root, "taken");
  result = helper(["serve", "--run", taken, "--port", String((busy.address() as net.AddressInfo).port)]);
  busy.close();
  assert.notEqual(result.status, 0, "a taken port fails the launch");
  assert.match(result.stderr, /EADDRINUSE/);
  assert.deepEqual(left(taken), [], "nothing left after a failed listen");
  for (const raw of ["nope", "0", "70000"]) {
    result = helper(["serve", "--run", path.join(root, "bad-port"), "--port", raw]);
    assert.notEqual(result.status, 0, `serve --port ${raw} is refused`);
  }
  assert.ok(!fs.existsSync(path.join(root, "bad-port")), "a refused port creates nothing");
  console.log("ok: failures while seeding, after instance.json, at listen and on a bad port leave nothing behind");

  // A served instance: doctor, cleanup stops it and keeps the evidence; a killed one is cleaned up after.
  for (const how of ["cleanup", "SIGKILL"]) {
    const run = path.join(root, `served-${how}`);
    const child = spawn(process.execPath, [HELPER, "serve", "--run", run, "--port", String(await freePort())],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CUBED_LOG_LEVEL: "error" } });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); });
    const exited = once(child, "exit");
    for (const deadline = Date.now() + 60_000; !out.includes("ready "); await new Promise(resolve => setTimeout(resolve, 100))) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `serve became ready: ${out}`);
    }
    result = helper(["doctor", "--run", run]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /ok: scratch holds this launch's owner file/);
    if (how === "SIGKILL") { child.kill("SIGKILL"); await exited; }
    const cleaned = await helperAsync(["cleanup", "--run", run]);
    assert.equal(cleaned.status, 0, cleaned.stdout);
    if (how === "cleanup") { assert.match(cleaned.stdout, /stopped pid \d+/); await exited; }
    assert.deepEqual(left(run), [], `nothing left after ${how}`);
    assert.ok(fs.existsSync(path.join(run, "evidence")), "the evidence directory stays");
  }
  console.log("ok: a served instance is stopped by cleanup, a killed one cleaned up after, and the evidence stays");

  // Cleanup with a pid that is now someone else's: never stopped; another launch's scratch stays.
  const reused = path.join(root, "reused");
  fs.mkdirSync(path.join(reused, "scratch"), { recursive: true });
  fs.writeFileSync(path.join(reused, "scratch", OWNER_FILE), "other\n");
  fs.writeFileSync(path.join(reused, "instance.json"), JSON.stringify({ pid: process.pid, runArg: reused, owner: "mine" }));
  result = helper(["cleanup", "--run", reused]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /is now another process .*: left alone/);
  assert.match(result.stdout, /belongs to another verify-cube launch: left alone/);
  assert.ok(fs.existsSync(path.join(reused, "scratch", OWNER_FILE)), "the other launch's scratch stays");
  console.log("ok: cleanup never stops a reused pid and leaves another launch's scratch");

  // The documented default: run without --run, in $TMPDIR/verify-cube/<time>.
  const tmp = path.join(root, "tmpdir");
  fs.mkdirSync(tmp);
  result = helper(["run", "cli"], { TMPDIR: tmp });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ok: pid \d+ is this verify-cube run on /);
  const [made] = fs.readdirSync(path.join(tmp, "verify-cube"));
  assert.match(fs.readFileSync(path.join(tmp, "verify-cube", made!, "evidence", "cli", "steps.log"), "utf8"), /PASS/);
  assert.deepEqual(left(path.join(tmp, "verify-cube", made!)), [], "nothing left but evidence");
  console.log("ok: run without --run passes doctor and keeps its evidence under $TMPDIR/verify-cube");

  // Doctor and drive before an instance exists: a bounded wait, then a clear failure.
  for (const command of [["doctor"], ["drive", "cli"]]) {
    const started = Date.now();
    result = helper([...command, "--run", path.join(root, "none"), "--wait", "1"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL: no .*instance\.json after 1 s: no instance of this run is launched/);
    assert.ok(Date.now() - started < 30_000, `${command[0]} gave up within its wait`);
  }
  console.log("ok: doctor and drive wait boundedly for an instance, then fail clearly");

  // Two drives in one run directory keep both evidence sets.
  const twice = path.join(root, "twice");
  for (let n = 0; n < 2; n++) assert.equal(helper(["run", "--run", twice, "cli"]).status, 0);
  for (const name of ["cli", "cli-2"]) assert.match(fs.readFileSync(path.join(twice, "evidence", name, "steps.log"), "utf8"), /PASS/, name);
  console.log("ok: a second drive writes evidence/cli-2 and keeps evidence/cli");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
