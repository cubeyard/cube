/** Native gate for cubed's bounded close (G1) and the no-resend rule (N2),
 * with the real supervisor (scripts/cubed-supervisor.ts) sending the real
 * SIGTERM to a real cubed process, which runs `serve`'s own lifecycle
 * (packages/server/test/close-gate-fixture.ts: createCubed of
 * --source, a faux model, local guests: the real guest helper and real
 * guest processes on this host, not a VM).
 *
 *   A  a thread's guest command (sleep 12) runs at the SIGTERM: cubed exits
 *      by itself in < 28 s; after the restart the command is reattached and
 *      its effect happens once, the turn completes, and the first request
 *      was sent once.
 *   B  one thread's model request is out at a provider that never answers
 *      and ignores the abort, while another thread's command (sleep 40)
 *      runs: cubed exits by itself in < 28 s; after the restart the request
 *      is not sent again, its run is stopped and says why, the usage counts
 *      one turn without a usage report, the next message is answered, and
 *      the other command is reattached and its effect happens once.
 *
 * `--control <checkout of main>` runs B's stop against that tree instead:
 * it must NOT exit by itself (the supervisor's SIGKILL at 30 s), which
 * shows the gate tells the two apart.
 *
 * Guards: everything lives in one new temporary root (CUBE_GATE_TMP or
 * TMPDIR), on a free loopback port; no service manager, no sudo, no
 * network but loopback. The supervisor, cubed and the guests run in their
 * own process group, killed at the end; the production supervisor's pids
 * and (on Linux) `systemctl --user is-active cubed.service` are read
 * before and after and must not change.
 *
 *   node scripts/gate-close.ts                 (the candidate: this checkout)
 *   node scripts/gate-close.ts --control <dir> (main, for B's stop only)
 *   CUBE_GATE_KEEP=1 keeps the root. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = path.resolve(import.meta.dirname, "..");
const controlIndex = process.argv.indexOf("--control");
const control = controlIndex > 0 ? path.resolve(process.argv[controlIndex + 1]!) : null;
const source = control ?? repo;
assert.ok(fs.existsSync(path.join(source, "packages/server/src/index.ts")), `${source} is a cube checkout`);
const root = fs.mkdtempSync(path.join(process.env.CUBE_GATE_TMP ?? os.tmpdir(), "cube-gate-close-"));
const log = (line: string) => { console.log(line); fs.appendFileSync(path.join(root, "gate.log"), `${new Date().toISOString()} ${line}\n`); };
const summary: Record<string, unknown> = { source, control: !!control, root, platform: `${process.platform}-${process.arch}`, node: process.version };

// --- guards ---------------------------------------------------------------
// The gate's own supervisor runs only between these two reads.
const pgrep = (): string[] => {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const lines = ps.stdout ? ps.stdout.split("\n")
    : fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(pid => { try { return `${pid} ${fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")}`; } catch { return ""; } });
  return lines.filter(line => line.includes("cubed-supervisor")).map(line => line.trim().split(/\s+/)[0]!).sort();
};
const unit = () => process.platform === "linux" ? (spawnSync("systemctl", ["--user", "is-active", "cubed.service"], { encoding: "utf8" }).stdout ?? "no systemctl").trim() : "n/a";
const before = { pids: pgrep(), unit: unit() };
summary.productionBefore = before;
log(`root ${root}; production supervisor pids ${JSON.stringify(before.pids)}; cubed.service ${before.unit}`);

const port = await new Promise<number>(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const install = path.join(root, "install"), state = path.join(root, "state"), machines = path.join(root, "machines"), dir = path.join(root, "gate");
for (const d of [install, state, machines, dir, path.join(root, "home")]) fs.mkdirSync(d, { recursive: true });
const release = path.join(install, "releases/v0.0.0-gate");
fs.mkdirSync(path.join(release, "bin"), { recursive: true });
fs.mkdirSync(path.join(release, "app/packages/server/src"), { recursive: true });
fs.writeFileSync(path.join(release, "bin/node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(release, "app/packages/server/src/index.ts"), `await import(${JSON.stringify(path.join(repo, "packages/server/test/close-gate-fixture.ts"))});\n`);
fs.writeFileSync(path.join(release, "release.json"), JSON.stringify({ version: "v0.0.0-gate", commit: "0".repeat(40), stateSchema: 100, entry: "app/packages/server/src/index.ts" }));
fs.symlinkSync(release, path.join(install, "current"));
const phase = (value: "answer" | "hold") => fs.writeFileSync(path.join(dir, "phase"), value);

// A repository for the project, local and bare.
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Gate", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const work = path.join(root, "repository"); fs.mkdirSync(work);
git(work, ["init", "-q", "--initial-branch=develop"]); fs.writeFileSync(path.join(work, "README"), "gate\n"); git(work, ["add", "README"]); git(work, ["commit", "-qm", "gate"]);
const remote = path.join(root, "remote.git"); git(root, ["clone", "-q", "--bare", work, remote]);

// --- the supervisor -------------------------------------------------------
let supervisor: ChildProcess | undefined;
async function startSupervisor(): Promise<void> {
  fs.rmSync(path.join(dir, "ready"), { force: true });
  supervisor = spawn(process.execPath, [path.join(repo, "scripts/cubed-supervisor.ts")], {
    detached: true, stdio: ["ignore", fs.openSync(path.join(root, "supervisor.out"), "a"), fs.openSync(path.join(root, "supervisor.out"), "a")],
    env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: root, CUBED_INSTALL_ROOT: install, CUBED_STATE: state,
      CUBE_GATE_SOURCE: source, CUBE_GATE_DIR: dir, CUBE_GATE_MACHINES: machines, CUBE_GATE_PORT: String(port) },
  });
  for (const deadline = Date.now() + 60_000; !fs.existsSync(path.join(dir, "ready")); await delay(50)) {
    assert.ok(Date.now() < deadline && supervisor.exitCode === null, `cubed did not start: ${fs.readFileSync(path.join(root, "supervisor.out"), "utf8").slice(-2000)}`);
  }
}
/** SIGTERM to the supervisor, as a service manager's stop: how long until it and cubed are gone, and whether cubed closed by itself. */
async function stopSupervisor(): Promise<{ ms: number; closedItself: boolean }> {
  const cubedPid = Number(fs.readFileSync(path.join(dir, "ready"), "utf8"));
  const target = supervisor!;
  const exited = new Promise(resolve => target.once("exit", resolve));
  const marks = fs.existsSync(path.join(dir, "cubed.log")) ? fs.readFileSync(path.join(dir, "cubed.log"), "utf8").split("\n").length : 0;
  const started = Date.now();
  target.kill("SIGTERM");
  await exited;
  const ms = Date.now() - started;
  let alive = true;
  for (let k = 0; k < 50 && alive; k++) { try { process.kill(cubedPid, 0); await delay(20); } catch { alive = false; } }
  assert.ok(!alive, "cubed is gone with its supervisor");
  const lines = fs.readFileSync(path.join(dir, "cubed.log"), "utf8").split("\n").slice(Math.max(0, marks - 1));
  return { ms, closedItself: lines.some(line => line.endsWith(" stopped")) && ms < 29_000 };
}
const base = `http://127.0.0.1:${port}`;
const post = async (url: string, body: unknown) => { const response = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert.ok(response.ok, `${url}: ${response.status} ${await response.clone().text()}`); return response.json(); };
const get = async (url: string) => (await fetch(`${base}${url}`)).json();
type History = { status: { state: string; error: string | null }; events: Array<{ type: string; text?: string }> };
async function until<T>(what: string, check: () => Promise<T | false | undefined>, ms = 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    assert.ok(Date.now() < deadline, `waiting for ${what}`);
    await delay(100);
  }
}
const requests = () => fs.existsSync(path.join(dir, "requests.log")) ? fs.readFileSync(path.join(dir, "requests.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { user: string; answered: boolean }) : [];
const guestFile = (thread: string, file: string) => path.join(machines, thread, "workspace", file);
/** A command running at the stop is never run twice, and its result is
 * true: with a VM it goes on and is reattached (its effect once, the
 * result its own). The local guest helper here does not outlive cubed as
 * a VM does: then the result says the outcome is unknown (the effect at
 * most once), never a second run and never a success it did not have. */
function commandOnce(what: string, thread: string, file: string, done: History): void {
  const effect = fs.existsSync(guestFile(thread, file)) ? fs.readFileSync(guestFile(thread, file), "utf8") : "";
  const results = done.events.filter(event => event.type === "tool-result") as Array<{ output?: string; isError?: boolean }>;
  assert.ok(effect === "" || effect === "once", `${what}: its effect at most once (${JSON.stringify(effect)})`);
  if (effect === "once") assert.ok(results.some(result => !result.isError), `${what}: reattached, its own result`);
  else assert.ok(results.length === 1 && results[0]!.isError && /outcome is unknown/.test(results[0]!.output ?? ""), `${what}: an honest unknown outcome: ${JSON.stringify(results)}`);
  log(`${what}: ${effect === "once" ? "reattached, its effect once" : "outcome unknown (the guest did not outlive cubed), never run twice"}`);
  const commands = (summary.commands ??= {}) as Record<string, string>;
  commands[what] = effect === "once" ? "reattached" : "unknown";
}

try {
  phase("answer");
  await startSupervisor();
  const model = ((await get("/api/models")).models as Array<{ provider: string; id: string }>).find(item => item.provider === "faux")!;
  const project = (await post("/api/projects", { name: "gate", repositories: [{ url: remote, base: "develop" }] })).project.id as string;
  const thread = async (requestId: string, text: string) => {
    const { id } = await post("/api/threads", { projectId: project, requestId, text, model });
    return id as string;
  };
  const history = (id: string) => get(`/api/threads/${id}/history`) as Promise<History>;

  if (!control) {
    // A: a guest command at the stop.
    const a = await thread("gate-a", "run sleep 12; printf once >> gate-a; printf 42");
    await until("A's command runs", async () => (await history(a)).events.some(event => event.type === "tool-call"));
    await delay(1500);
    const stopA = await stopSupervisor();
    log(`A stop: ${stopA.ms} ms, cubed closed itself: ${stopA.closedItself}`);
    summary.A = stopA;
    assert.ok(stopA.closedItself && stopA.ms < 28_000, `A: cubed exits by itself within its bound (${stopA.ms} ms)`);
    await startSupervisor();
    const doneA = await until("A completes after the restart", async () => { const h = await history(a); return h.status.state === "completed" && h; }, 90_000);
    assert.ok(doneA.events.some(event => event.text?.includes("gate done: run sleep 12")), "A's turn completed after its command's result");
    commandOnce("A", a, "gate-a", doneA);
    assert.equal(requests().filter(r => r.user.startsWith("run sleep 12") && !r.answered).length, 1, "A's first request was sent once");
    log("A ok: cubed exited by itself, the command was not run twice, the turn completed, nothing sent twice");
    // Its machine slot back, for B's two threads.
    const archived = await fetch(`${base}/api/threads/${a}`, { method: "DELETE" });
    assert.ok(archived.ok, `archive A: ${archived.status} ${await archived.text()}`);
  }

  // B: a request out at a provider that hangs, and another thread's command.
  const b2 = await thread("gate-b2", "run sleep 40; printf once >> gate-b2; printf 7");
  await until("B2's command runs", async () => (await history(b2)).events.some(event => event.type === "tool-call"));
  const b1 = await thread("gate-b1", "say hello");
  await until("B1 answered", async () => (await history(b1)).status.state === "completed");
  phase("hold");
  fs.rmSync(path.join(dir, "out"), { force: true });
  await post(`/api/threads/${b1}/prompt`, { text: "say second", requestId: "gate-b1-second" });
  await until("B1's request is out", async () => fs.existsSync(path.join(dir, "out")));
  await delay(500);
  const stopB = await stopSupervisor();
  log(`B stop: ${stopB.ms} ms, cubed closed itself: ${stopB.closedItself}`);
  summary.B = stopB;
  if (control) {
    assert.ok(!stopB.closedItself && stopB.ms >= 29_000, `control: the old close does not end by itself (${stopB.ms} ms): the gate tells them apart`);
    log("control ok: without the bound the supervisor's SIGKILL ended it");
  } else {
    assert.ok(stopB.closedItself && stopB.ms < 28_000, `B: cubed exits by itself within its bound (${stopB.ms} ms)`);
    phase("answer");
    await startSupervisor();
    const stopped = await until("B1 shows its stopped run", async () => { const h = await history(b1); return h.status.state === "stopped" && h; }, 60_000);
    assert.match(stopped.status.error ?? "", /model request was out, so it was not sent again/, "B1's stopped run says why");
    await delay(1000);
    assert.equal(requests().filter(r => r.user === "say second").length, 1, "B1's request out at the stop was not sent again");
    const report = await get("/api/usage");
    assert.ok(report.totals.unknownTurns >= 1, `the usage counts it as a turn without a usage report (${JSON.stringify(report.totals)})`);
    await post(`/api/threads/${b1}/prompt`, { text: "say third", requestId: "gate-b1-third" });
    await until("B1's next message is answered", async () => { const h = await history(b1); return h.status.state === "completed" && h.events.some(event => event.text?.includes("gate ok: say third")); });
    const doneB2 = await until("B2 completes after the restart", async () => { const h = await history(b2); return h.status.state === "completed" && h; }, 90_000);
    commandOnce("B2", b2, "gate-b2", doneB2);
    log("B ok: the request out was not sent again, its run says why, usage counts it, the next message is answered; the other command was never run twice");
  }
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) await stopSupervisor().catch(() => {});
} finally {
  try { if (supervisor?.pid && supervisor.exitCode === null) process.kill(-supervisor.pid, "SIGKILL"); } catch { /* gone */ }
  for (const entry of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (!entry.endsWith("wrap.pid") && !entry.endsWith("supervisor.pid")) continue;
    try { process.kill(-Number(fs.readFileSync(path.join(root, entry), "utf8")), "SIGKILL"); } catch { /* gone */ }
  }
  const after = { pids: pgrep(), unit: unit() };
  summary.productionAfter = after;
  log(`production after: supervisor pids ${JSON.stringify(after.pids)}; cubed.service ${after.unit}`);
  assert.deepEqual(after, before, "production cubed was not touched");
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (process.env.CUBE_GATE_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
