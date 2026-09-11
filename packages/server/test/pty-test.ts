/**
 * Offline unit test for the pty bridge (PiTerminals): spawn-on-first-attach,
 * output broadcast + scrollback replay, input and resize routing, status
 * forwarding while the plan settles, plan-failure surfacing, linger reaping
 * after the last detach, and kill() on thread deletion. Uses a real pty
 * around plain shell processes — no pi, no Incus, no network.
 *
 *   node packages/server/test/pty-test.ts
 */
import assert from "node:assert";
import { Effect } from "effect";

import { PiTerminals, type TerminalClient, type TerminalSpawnPlan } from "../src/pty.ts";

class FakeClient implements TerminalClient {
  output = "";
  frames: Array<Record<string, unknown>> = [];
  closed = false;
  send(data: string | Buffer): void {
    if (typeof data === "string") this.frames.push(JSON.parse(data));
    else this.output += data.toString("utf8");
  }
  close(): void {
    this.closed = true;
  }
  frame(t: string): Record<string, unknown> | undefined {
    return this.frames.find((f) => f.t === t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

const shellPlan = (script: string): TerminalSpawnPlan => ({
  argv: ["/bin/sh", "-c", script],
  cwd: "/tmp",
  env: { PATH: process.env.PATH, TERM: "xterm-256color" },
});

// 1. attach spawns, output reaches the client, input reaches the child
{
  const activity: string[] = [];
  const terminals = new PiTerminals(
    { plan: async () => shellPlan("echo ready; cat"), activity: (id) => activity.push(id) },
    { lingerMs: 60_000 },
  );
  const a = new FakeClient();
  const handle = terminals.attach("t1", a, 80, 24);
  assert.equal(terminals.isLive("t1"), true, "live from the first attach (while starting)");
  await until("spawn + first output", () => a.output.includes("ready"));
  assert.ok(a.frame("spawned"), "spawned control frame sent");
  handle.input("hello-from-input\r");
  await until("input echoed back by cat", () => a.output.includes("hello-from-input"));
  assert.deepEqual(activity, ["t1"], "terminal I/O reported as activity (throttled to once)");

  // 2. late attacher gets the scrollback replay
  const b = new FakeClient();
  terminals.attach("t1", b, 80, 24);
  await until("replay", () => b.output.includes("ready"));

  // 3. kill (thread deletion): exit frame to every client, session gone
  terminals.kill("t1");
  await until("exit frames", () => !!a.frame("exit") && !!b.frame("exit"));
  assert.equal(terminals.isLive("t1"), false);
  assert.ok(a.closed && b.closed, "clients closed on teardown");
  console.log("1-3 ok: spawn, io, replay, kill");
}

// 4. resize propagates to the pty (last resize wins)
{
  const terminals = new PiTerminals(
    { plan: async () => shellPlan("cat > /dev/null; stty size"), activity: () => {} },
    { lingerMs: 60_000 },
  );
  const a = new FakeClient();
  const handle = terminals.attach("t2", a, 80, 24);
  await until("spawn", () => !!a.frame("spawned"));
  handle.resize(100, 30);
  handle.input("\x04"); // ^D ends cat; stty then reports the CURRENT size
  await until("stty size output", () => a.output.includes("30 100"));
  terminals.kill("t2");
  console.log("4 ok: resize reached the pty");
}

// 5. status frames stream while the plan settles; plan failure surfaces
{
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const progress = { phase: "running .cube/setup…", log: "installing dependencies\n", startedAt: 1, updatedAt: 2, truncated: false, failed: false };
  const terminals = new PiTerminals(
    {
      plan: async (_id, onStatus) => {
        onStatus(progress.phase, progress);
        await gate;
        throw new Error("environment error: boom");
      },
      activity: () => {},
    },
    { lingerMs: 60_000 },
  );
  const a = new FakeClient();
  terminals.attach("t3", a, 80, 24);
  await until("status frame", () => !!a.frame("status"));
  const late = new FakeClient();
  terminals.attach("t3", late, 80, 24);
  assert.deepEqual(a.frame("status")?.progress, progress);
  assert.deepEqual(late.frame("status")?.progress, progress, "late attach replays the bounded log");
  release();
  await until("error frame", () => !!a.frame("error") && !!late.frame("error"));
  assert.match(String(a.frame("error")!.text), /environment error: boom/);
  assert.equal(terminals.isLive("t3"), false, "failed plan clears the session");
  assert.ok(a.closed && late.closed);
  console.log("5 ok: status forwarding + plan failure surfaced");
}

// 6. linger: last detach arms the reap timer; reattach within it survives
{
  const terminals = new PiTerminals(
    { plan: async () => shellPlan("echo up; cat"), activity: () => {} },
    { lingerMs: 150 },
  );
  const a = new FakeClient();
  const handleA = terminals.attach("t4", a, 80, 24);
  await until("spawn", () => a.output.includes("up"));

  // Reattach inside the window keeps the process alive past the deadline.
  handleA.detach();
  const b = new FakeClient();
  const handleB = terminals.attach("t4", b, 80, 24);
  await sleep(300);
  assert.equal(terminals.isLive("t4"), true, "reattach within linger cancels the reap");

  handleB.detach();
  await until("linger reap", () => !terminals.isLive("t4"));
  console.log("6 ok: linger reaps after the last detach, reattach cancels");
}

// 7. child exiting on its own tears the session down with its exit code
{
  const terminals = new PiTerminals(
    { plan: async () => shellPlan("exit 3"), activity: () => {} },
    { lingerMs: 60_000 },
  );
  const a = new FakeClient();
  terminals.attach("t5", a, 80, 24);
  await until("exit frame", () => !!a.frame("exit"));
  assert.equal(a.frame("exit")!.code, 3);
  assert.equal(terminals.isLive("t5"), false);
  console.log("7 ok: child exit -> exit frame + session cleared");
}

console.log("pty-test: ALL PASS");

// A setup failure remains inspectable when reconnecting to an already-live PTY.
await Effect.runPromise(Effect.gen(function* () {
  const progress = { phase: "Setup failed", log: "dependency failed\n", startedAt: 1, updatedAt: 2, truncated: false, failed: true };
  const terminals = new PiTerminals({
    plan: (_id, onStatus) => Effect.runPromise(Effect.sync(() => {
      onStatus(progress.phase, progress);
      return { argv: ["sh", "-c", "cat"], cwd: "/tmp", env: process.env };
    })),
    activity: () => {},
  });
  yield* Effect.gen(function* () {
    const first = new FakeClient();
    terminals.attach("setup-failed", first, 80, 24);
    yield* Effect.tryPromise(() => until("spawn", () => !!first.frame("spawned")));
    const late = new FakeClient();
    terminals.attach("setup-failed", late, 80, 24);
    assert.deepEqual(late.frame("status")?.progress, progress);
    assert.ok(late.frame("attached"), "reconnected client can continue into the usable thread");
  }).pipe(Effect.ensuring(Effect.sync(() => terminals.close())));
}));
console.log("8 ok: failed startup log replays even after PTY spawn");
