/**
 * Offline units for the sol-review hardening around the pty bridge:
 * same-origin gating of terminal upgrades (anti-CSWSH), pi session-file
 * resolution when the TUI's own /new switches files, and auto-title
 * behavior over pi's session JSONL (truncation, image-only, give-up).
 *
 * These exercise the exported helpers directly — no daemon, no Incus.
 *
 *   node packages/server/test/terminal-guards-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Registry } from "../src/registry.ts";
import { sameOriginUpgrade } from "../src/portal-proxy.ts";
import { CubeSupervisor } from "../src/supervisor.ts";

// ------------------------------------------------- 1. same-origin upgrades
{
  assert.equal(sameOriginUpgrade("http://cube.local:7777", "cube.local:7777"), true, "same origin attaches");
  assert.equal(sameOriginUpgrade(undefined, "cube.local:7777"), true, "non-browser client (no Origin) attaches");
  assert.equal(sameOriginUpgrade("https://evil.example", "cube.local:7777"), false, "cross-site attach refused");
  assert.equal(sameOriginUpgrade("http://cube.local:8080", "cube.local:7777"), false, "port mismatch refused");
  assert.equal(sameOriginUpgrade("null", "cube.local:7777"), false, "opaque/unparseable Origin refused");
  console.log("1 ok: terminal upgrades are same-origin only");
}

// ------------------------------------------- fixtures for the supervisor
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cube-term-"));
const registry = new Registry(path.join(base, "cubed.db"));
const PROJECT_ID = "project-terminal-tests";
const project = registry.createProject({
  id: PROJECT_ID,
  name: "terminal tests",
  repositories: [
    {
      id: "project-terminal-repo",
      url: "https://github.com/cubeyard/cube.git",
      base: "main",
      checkoutName: "workspace",
    },
  ],
});
registry.setProjectRepositoryCheck("project-terminal-repo", {
  status: "ready",
  resolvedBase: "main",
  baseOid: "deadbeef",
  checkedAt: 1,
});
registry.finishProjectCheck(PROJECT_ID, project.revision, "ready", null, 1);
const supervisor = new CubeSupervisor(registry, { kind: "mock" } as never, {
  cubesRoot: path.join(base, "cubes"),
  reposRoot: path.join(base, "repos"),
  pool: "cube",
  image: "cube-node",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  egressAllow: [],
  idleMs: 0,
  portalBase: "cube.internal",
  publicPort: 7777,
});

/** A registry cube + one thread, with its sessions dir on disk. */
function makeThread(name: string): { cubeId: number; threadId: string; sessionDir: string; sessionPath: string } {
  const workspacePath = path.join(base, "cubes", name, "workspace");
  const sessionDir = path.join(base, "cubes", name, "sessions");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const cube = registry.createCube({ name, image: "cube-node", workspacePath });
  registry.setCubeStatus(name, "ready");
  const threadId = `${name}-thread`;
  const sessionPath = path.join(sessionDir, `${threadId}.jsonl`);
  registry.addThread({ id: threadId, cubeId: cube.id, projectId: PROJECT_ID, piSessionPath: sessionPath });
  return { cubeId: cube.id, threadId, sessionDir, sessionPath };
}

const sessionLine = (role: string, content: unknown) =>
  `${JSON.stringify({ type: "message", message: { role, content } })}\n`;
const header = `${JSON.stringify({ type: "session", version: 1, id: "s1" })}\n`;

const titleOf = (threadId: string) =>
  supervisor.listUserThreads().find((t) => t.id === threadId)!.title;

// ------------------------------------------------------ 2. auto-title
{
  const t = makeThread("t-title01");
  assert.equal(titleOf(t.threadId), null, "no session file yet -> untitled");

  fs.writeFileSync(t.sessionPath, header); // flushed, but no user message
  assert.equal(titleOf(t.threadId), null, "header only -> still untitled");

  fs.appendFileSync(t.sessionPath, sessionLine("user", "Fix   the\nflaky login test"));
  assert.equal(titleOf(t.threadId), "Fix the flaky login test", "first user message titles the thread");
  // Persisted, so it survives without re-reading the file.
  assert.equal(registry.getThread(t.threadId)!.title, "Fix the flaky login test");

  // Later messages never re-title.
  fs.appendFileSync(t.sessionPath, sessionLine("user", "and also this"));
  assert.equal(titleOf(t.threadId), "Fix the flaky login test", "manual/first title sticks");
  console.log("2 ok: auto-title from the first user message of pi's JSONL");
}

// --------------------------- 3. auto-title: partial lines and giving up
{
  const t = makeThread("t-title02");
  // A half-written append (pi flushing) must not be parsed as content.
  fs.writeFileSync(t.sessionPath, `${header}{"type":"message","message":{"role":"user","content":"half-writ`);
  assert.equal(titleOf(t.threadId), null, "incomplete trailing line is not content");
  // Completing it works on the next poll.
  fs.writeFileSync(t.sessionPath, header + sessionLine("user", [{ type: "text", text: "structured parts" }]));
  assert.equal(titleOf(t.threadId), "structured parts", "content parts array titles too");

  // Image-only first message: nothing to title with, and it never changes —
  // the scan must give up instead of re-reading on every poll.
  const img = makeThread("t-title03");
  fs.writeFileSync(img.sessionPath, header + sessionLine("user", [{ type: "image", data: "AAAA" }]));
  assert.equal(titleOf(img.threadId), null, "image-only first message -> untitled");
  fs.rmSync(img.sessionPath); // a re-read would now throw/return null anyway
  assert.equal(titleOf(img.threadId), null, "gave up scanning (no repeat read)");

  // A head that fills the scan cap without a complete user entry can never
  // yield one (append-only) — same give-up path.
  const big = makeThread("t-title04");
  fs.writeFileSync(big.sessionPath, `${header}${JSON.stringify({ type: "junk", pad: "x".repeat(300 * 1024) })}`);
  assert.equal(titleOf(big.threadId), null, "oversized head -> untitled");
  console.log("3 ok: partial lines, structured parts, and permanent give-up");
}

// ------------------------- 4. session resolution follows pi's own /new
{
  const t = makeThread("t-session01");
  const plan = (id: string) => supervisor.terminalPlan(id, () => {});
  const sessionArg = async (id: string) => {
    const p = await plan(id);
    return p.argv[p.argv.indexOf("--session") + 1];
  };

  // Nothing on disk: the registry path is what pi creates.
  assert.equal(await sessionArg(t.threadId), t.sessionPath, "registry path when the dir is empty");

  fs.writeFileSync(t.sessionPath, header);
  assert.equal(await sessionArg(t.threadId), t.sessionPath, "the thread's own file");

  // pi's /new wrote a fresh session in the same dir — that is now the
  // thread's conversation; reattaching must not resume the stale one.
  const fresh = path.join(t.sessionDir, "2026-08-28T10-00-00-000Z_newer.jsonl");
  fs.writeFileSync(fresh, header);
  fs.utimesSync(t.sessionPath, new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(fresh, new Date(2_000_000), new Date(2_000_000));
  assert.equal(await sessionArg(t.threadId), fresh, "newest session in the thread's own dir wins");

  // A symlink planted in the sessions dir must never become the session.
  const planted = path.join(t.sessionDir, "planted.jsonl");
  fs.symlinkSync("/etc/passwd", planted);
  fs.lutimesSync(planted, new Date(9_000_000), new Date(9_000_000));
  assert.equal(await sessionArg(t.threadId), fresh, "symlinked session candidate is ignored");

  console.log("4 ok: session file follows pi's /new and never follows a symlink");
}

// ------------------------------- 5. the spawn's security-critical flags
{
  const t = makeThread("t-flags01");
  const plan = await supervisor.terminalPlan(t.threadId, () => {});
  for (const flag of ["--no-extensions", "--no-approve", "--no-context-files"]) {
    assert.ok(plan.argv.includes(flag), `pi must be spawned with ${flag}`);
  }
  assert.equal(plan.env.CUBE_NAME, "t-flags01", "the extension is pointed at this thread's cube");
  assert.equal(plan.env.CUBE_BACKEND, "mock", "the separate extension process receives the selected backend");
  assert.ok(plan.argv.includes("-e"), "the cube extension is loaded explicitly");
  console.log("5 ok: spawn carries the fail-closed launch flags");
}

registry.close();
fs.rmSync(base, { recursive: true, force: true });
console.log("terminal-guards-test: ALL PASS");
