/**
 * Offline test for lifecycle events: the registry's event table (record,
 * filter, prune), the span helper, the text rendering, and — through the
 * mock backend — that a thread's whole life (project check, provision with
 * phases, sleep, wake, destroy) lands as events with durations and the
 * thread id attached.
 *
 *   node packages/server/test/events-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend } from "@cube/sandbox";

import { Span, formatEventLine, recordPoint } from "../src/events.ts";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor } from "../src/supervisor.ts";

// --- registry: record, list (newest first, filters), prune

const mem = new Registry(":memory:");
recordPoint(mem, { kind: "boot", detail: "hello" });
mem.recordEvent({ kind: "wake", cube: "t-aaaaaaaa", thread: "thread-a", ok: false, ms: 1200, detail: "eth0 never came up" });
mem.recordEvent({ kind: "wake", phase: "network", op: "op1", cube: "t-bbbbbbbb", ok: true, ms: 30 });
mem.recordEvent({ kind: "egress", phase: "deny", cube: "t-bbbbbbbb", ok: false, detail: "connect evil.example ×3" });

const all = mem.listEvents();
assert.equal(all.length, 4);
assert.equal(all[0]!.kind, "egress", "newest first");
assert.equal(all[3]!.kind, "boot");
assert.ok(all.every((e) => typeof e.version === "string" && e.version.length > 0), "every event carries a version");
assert.equal(mem.listEvents({ cube: "t-bbbbbbbb" }).length, 2);
assert.equal(mem.listEvents({ thread: "thread-a" }).length, 1);
assert.equal(mem.listEvents({ kind: "wake" }).length, 2);
assert.equal(mem.listEvents({ failed: true }).length, 2);
assert.equal(mem.listEvents({ limit: 1 }).length, 1);
assert.equal(mem.listEvents({ since: Date.now() + 60_000 }).length, 0);
assert.equal(mem.pruneEvents(-60_000), 4, "prune with a future cutoff drops everything");
assert.equal(mem.listEvents().length, 0);
console.log("1 ok: registry records, filters, orders and prunes events");

// --- span: phases carry the delta since the previous mark, end carries the total

const span = new Span(mem, { kind: "provision", cube: "t-cccccccc", thread: "thread-c" });
await new Promise((r) => setTimeout(r, 15));
span.phase("seed", "1 repository");
await new Promise((r) => setTimeout(r, 15));
span.phase("setup", ".cube/setup failed (exit 1)", false);
span.end(true, "ready with setup complaint");
span.end(false, "second end is ignored");
const rows = mem.listEvents({ cube: "t-cccccccc" }).reverse();
assert.deepEqual(rows.map((r) => r.phase), ["seed", "setup", null]);
assert.ok(rows.every((r) => r.op === span.op), "one op id groups the span");
assert.ok(rows[0]!.ms! >= 10 && rows[1]!.ms! >= 10, "phase durations are deltas");
assert.ok(rows[2]!.ms! >= rows[0]!.ms! + rows[1]!.ms! - 2, "the total covers the phases");
assert.equal(rows[1]!.ok, false);
assert.equal(rows[2]!.ok, true);
assert.equal(rows[2]!.detail, "ready with setup complaint");
const line = formatEventLine(rows[2]!);
assert.match(line, /ok {2}provision {10,}thread=thread-c/);
assert.match(formatEventLine(rows[1]!), /ERR provision\.setup/);
console.log("2 ok: spans group phases under one op with delta and total durations");

// --- through the supervisor (mock backend): a thread's life is fully recorded

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-events-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];
const bare = path.join(tmp, "primary.git");
git(tmp, "init", "--bare", "-b", "main", bare);
const seed = path.join(tmp, "seed");
git(tmp, "clone", bare, seed);
fs.writeFileSync(path.join(seed, "README.md"), "events\n");
git(seed, ...author, "add", "-A");
git(seed, ...author, "commit", "-m", "initial");
git(seed, "push", "origin", "main");

const registry = new Registry(path.join(tmp, "cubed.db"));
const supervisor = new CubeSupervisor(registry, new MockBackend(), {
  cubesRoot: path.join(tmp, "cubes"),
  reposRoot: path.join(tmp, "mirrors"),
  pool: "mock",
  image: "mock",
  rootSize: "1GiB",
  dockerVolumeSize: "1GiB",
  egressAllow: [],
  idleMs: 0,
  portalBase: "cube.localhost",
  publicPort: 7777,
});
await supervisor.boot();
assert.equal(registry.listEvents({ kind: "boot" }).length, 1, "boot is recorded");

const project = supervisor.createProject({ name: "events", repositories: [{ url: bare }] });
for (const deadline = Date.now() + 10_000; supervisor.getProject(project.id).status === "checking"; ) {
  if (Date.now() > deadline) throw new Error("project check timed out");
  await new Promise((r) => setTimeout(r, 20));
}
const check = registry.listEvents({ kind: "project-check" });
assert.equal(check.length, 1);
assert.equal(check[0]!.ok, true);
assert.match(check[0]!.detail ?? "", /^events: 1 repository ready$/);
console.log("3 ok: a project check is one event with the outcome");

const { id: threadId } = await supervisor.createUserThread(project.id);
const cubeName = supervisor.resolveUserThread(threadId).cubeName;
for (const deadline = Date.now() + 10_000; registry.getCube(cubeName)!.status !== "ready"; ) {
  const cube = registry.getCube(cubeName)!;
  if (cube.status === "error") throw new Error(`provision failed: ${cube.error}`);
  if (Date.now() > deadline) throw new Error("provision timed out");
  await new Promise((r) => setTimeout(r, 20));
}
const provision = registry.listEvents({ kind: "provision", cube: cubeName }).reverse();
assert.deepEqual(provision.map((e) => e.phase), ["seed", "instance", "proxy", "setup", null]);
assert.ok(provision.every((e) => e.thread === threadId), "provision events name the thread");
assert.ok(provision.every((e) => e.ok), "a clean provision is all ok");
assert.equal(provision[4]!.detail, "ready");
assert.ok(new Set(provision.map((e) => e.op)).size === 1, "one op id for the whole provision");
console.log("4 ok: provisioning is a span with seed/instance/proxy/setup phases");

await supervisor.sleepCube(cubeName, "idle");
await supervisor.wakeCube(cubeName);
const sleeps = registry.listEvents({ kind: "sleep", cube: cubeName });
assert.equal(sleeps.length, 1);
assert.match(sleeps[0]!.detail ?? "", /^idle: /);
const wake = registry.listEvents({ kind: "wake", cube: cubeName }).reverse();
assert.deepEqual(wake.map((e) => e.phase), ["start", "network", "resume", "hooks", null]);
assert.equal(wake[4]!.detail, "ready");
console.log("5 ok: sleep records its reason; wake records start/network/resume/hooks");

await supervisor.removeUserThread(threadId);
const destroy = registry.listEvents({ kind: "destroy", cube: cubeName });
assert.equal(destroy.length, 1);
assert.equal(destroy[0]!.ok, true);
assert.equal(destroy[0]!.thread, threadId, "history keeps the thread id after deletion");
assert.ok(registry.listEvents({ thread: threadId }).length >= 12, "the deleted thread's history survives");
console.log("6 ok: destroy is recorded and a deleted thread's history survives");

await supervisor.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL PASS: events");
