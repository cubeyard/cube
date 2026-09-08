/**
 * Manual smoke test for IncusSandbox (REST websocket exec). Needs the cube
 * running and socket access: sg incus-admin -c "node packages/sandbox/test/exec-smoke.ts"
 */
import assert from "node:assert";

import { IncusSandbox } from "../src/index.ts";

const CUBE = process.env.CUBED_CUBE ?? "orb-spike01";
const sandbox = new IncusSandbox(CUBE);

function run(command: string, opts: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}) {
  let out = "";
  return sandbox
    .exec(command, {
      cwd: opts.cwd ?? "/workspace",
      onData: (chunk) => (out += chunk.toString("utf8")),
      signal: opts.signal,
      timeout: opts.timeout,
    })
    .then(({ exitCode }) => ({ exitCode, out }));
}

// Anchored full-cmdline match: catches the real workload process but not the
// supervisor wrapper / its 5s KILL-escalation subshell (whose forked cmdline
// contains the marker) or this checking shell itself.
async function orphans(marker: string): Promise<string> {
  const { out } = await run(`pgrep -a -f ${JSON.stringify(`^${marker}$`)} || true`);
  return out.trim();
}

// 1. basic output, identity, cwd mapping
{
  const { exitCode, out } = await run("hostname && id -un && pwd && groups");
  assert.equal(exitCode, 0);
  assert.match(out, /orb-spike01/);
  assert.match(out, /\bdev\b/);
  assert.match(out, /\/workspace/);
  assert.match(out, /docker/); // su - login shell → supplementary groups
  console.log("1 basic ok:", JSON.stringify(out.trim()));
}

// 2. exit code propagation
{
  const { exitCode } = await run("exit 7");
  assert.equal(exitCode, 7);
  console.log("2 exit code ok");
}

// 3. stderr is streamed too
{
  const { exitCode, out } = await run("echo to-stdout && echo to-stderr 1>&2");
  assert.equal(exitCode, 0);
  assert.match(out, /to-stdout/);
  assert.match(out, /to-stderr/);
  console.log("3 stderr ok");
}

// 4. timeout kills the WHOLE remote tree (the spike-2 orphan caveat)
{
  const marker = "sleep 12345";
  const started = Date.now();
  await assert.rejects(run(`echo before && ${marker}`, { timeout: 2 }), /timeout:2/);
  const elapsed = (Date.now() - started) / 1000;
  assert.ok(elapsed < 12, `took ${elapsed}s`);
  await new Promise((r) => setTimeout(r, 1000));
  const left = await orphans(marker);
  assert.equal(left, "", `orphaned processes:\n${left}`);
  console.log(`4 timeout ok (${elapsed.toFixed(1)}s), no orphans`);
}

// 5. abort kills the remote tree as well
{
  const marker = "sleep 23456";
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(run(marker, { signal: ac.signal }), /aborted/);
  await new Promise((r) => setTimeout(r, 1000));
  const left = await orphans(marker);
  assert.equal(left, "", `orphaned processes:\n${left}`);
  console.log("5 abort ok, no orphans");
}

// 6. a TERM-ignoring process still dies (KILL escalation in the supervisor)
{
  const marker = "sleep 34567";
  const started = Date.now();
  await assert.rejects(
    run(`trap '' TERM; ${marker}`, { timeout: 2 }),
    /timeout:2/,
  );
  const elapsed = (Date.now() - started) / 1000;
  await new Promise((r) => setTimeout(r, 1000));
  const left = await orphans(marker);
  assert.equal(left, "", `orphaned processes:\n${left}`);
  console.log(`6 KILL escalation ok (${elapsed.toFixed(1)}s), no orphans`);
}

// 7b. an already-aborted signal is honored (queued until the control
// channel opens), and still leaves no orphans
{
  const marker = "sleep 45678";
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  await assert.rejects(run(marker, { signal: ac.signal }), /aborted/);
  const elapsed = (Date.now() - started) / 1000;
  assert.ok(elapsed < 15, `took ${elapsed}s`);
  await new Promise((r) => setTimeout(r, 1000));
  const left = await orphans(marker);
  assert.equal(left, "", `orphaned processes:\n${left}`);
  console.log(`7b pre-aborted ok (${elapsed.toFixed(1)}s), no orphans`);
}

// 7. concurrent-safe: output of parallel execs does not interleave envelopes
{
  const [a, b] = await Promise.all([run("echo AAA && sleep 1 && echo AAA2"), run("echo BBB")]);
  assert.match(a.out, /AAA[\s\S]*AAA2/);
  assert.match(b.out, /BBB/);
  console.log("7 concurrency ok");
}

console.log("ALL SMOKE TESTS PASSED");
