// Several threads on one runner with real thread VMs: a disposable cubed
// (faux model) with CUBED_STATE under /tmp, the real cube-gateway and one
// runner serving `--max-active-vms 2`, each guest a Debian genericcloud VM.
//
//   node scripts/test-vm-concurrency.ts <cube-runner> <cube-gateway> <image.qcow2>
//
// 1 the runner advertises two machines and cubed records them at enrollment;
// 2 two threads created at once boot their VMs side by side, a third is
// refused; 3 commands run in both guests at the same time, each in its own
// machine; 4 archiving one frees its slot, a new thread boots in it, and every
// archive returns its slot; 5 every process stopped. Small VMs (1 vCPU,
// 1 GiB) so two fit on a modest host. CUBE_SMOKE_KEEP=1 keeps the work
// directory; TMPDIR chooses where it is (the VM disks grow there).
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const [runnerBin, gatewayBin, image] = process.argv.slice(2).map(p => path.resolve(p));
if (!runnerBin || !gatewayBin || !image) throw new Error("usage: test-vm-concurrency.ts <cube-runner> <cube-gateway> <image.qcow2>");
const repo = path.resolve(import.meta.dirname, "..");
// TMPDIR moves the VM disks off a small tmpfs; keep it short (socket paths).
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-conc-"));
fs.chmodSync(work, 0o700);
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
const vmIds: string[] = [];

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  const lines = readline.createInterface({ input: child.stdout! });
  return JSON.parse(await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", code => reject(new Error(`process exited (${code}) before its ready line`)));
  }));
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill(signal);
  await exited;
  children.delete(child);
}
const gatewayPids = () => { try { return execFileSync("pgrep", ["-f", `serve --state ${path.join(work, "state", "gateway")}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

let url = "";
async function call(route: string, method = "GET", body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}
async function api(route: string, method = "GET", body?: unknown) {
  const { status, json } = await call(route, method, body);
  if (status >= 400) throw new Error(`${method} ${route}: ${status} ${JSON.stringify(json)}`);
  return json;
}
type Row = { id: string; state: string; error: string | null; vm?: { vmId: string } };
async function ready(id: string, seconds = 900): Promise<Row> {
  const row = await until(`thread ${id.slice(0, 8)} ready`, seconds, async () => {
    const row = (await api("/api/threads")).threads.find((candidate: Row) => candidate.id === id) as Row | undefined;
    return row && row.state !== "starting" ? row : undefined;
  });
  assert.equal(row.state, "ready", row.error ?? "");
  vmIds.push(row.vm!.vmId);
  // The creation text is the first turn; a prompt during it is refused.
  await until(`thread ${id.slice(0, 8)} first turn`, 120, async () => {
    const history = await api(`/api/threads/${id}/history`);
    return history.status?.run === "cube:initial" && history.status.state === "completed";
  });
  return row;
}
let requests = 0;
async function bash(id: string, command: string, seconds = 300): Promise<string> {
  const run = `conc-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text: `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs: seconds * 1000 } })}`, requestId: run });
  const value = await until(`run ${run}`, seconds + 30, async () => {
    const history = await api(`/api/threads/${id}/history`);
    return history.status?.run === run && !["working", "idle"].includes(history.status.state) ? history : undefined;
  });
  assert.equal(value.status.state, "completed", JSON.stringify(value.status));
  const last = [...value.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text: string };
  assert.match(last.text, /^result: /, last.text);
  return last.text.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}
const runnerStatus = async () => {
  const runners = (await api("/api/runners")).runners;
  return (await api(`/api/runners/${runners[0].id}/check`, "POST", {})).runner;
};

try {
  // 1. A runner with room for two machines.
  const peerOf = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;
  const controlPeer = peerOf(path.join(work, "control.key"));
  peerOf(path.join(work, "runner.key"));
  execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"), "--image", image,
    "--allow-peer", controlPeer, "--node-id", "node-conc", "--thread-id", "install-conc", "--env", "1",
    "--max-vcpus", "1", "--max-memory-mib", "1024", "--max-disk-gib", "16"], { stdio: "ignore" });
  const runner = spawn(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"),
    "--listen", "127.0.0.1:0", "--max-active-vms", "2"], { stdio: ["ignore", "pipe", "pipe"] });
  runner.stderr!.pipe(fs.createWriteStream(path.join(work, "runner.log"), { flags: "a" }));
  children.add(runner);
  const runnerReady = await firstLine(runner);
  assert.equal(runnerReady.maxActiveVms, 2, "the ready line names the bound");
  const config = path.join(work, "runner.json");
  fs.writeFileSync(config, JSON.stringify({ version: 2, binding: { nodeId: "node-conc", threadId: "install-conc", environmentId: 1 },
    controlKey: path.join(work, "control.key"), serverPeer: runnerReady.peerId, address: (runnerReady.addresses as string[])[0], network: "loopback" }), { mode: 0o600 });
  fs.mkdirSync(path.join(work, "state"), { mode: 0o700 });
  const enrolled = JSON.parse(execFileSync(process.execPath, [path.join(repo, "scripts/enroll-runner.ts"), "--state", path.join(work, "state"), "--config", config, "--trusted-runner"], { encoding: "utf8" }));
  assert.equal(enrolled.maxActiveVms, 2);
  fs.mkdirSync(path.join(work, "home"), { mode: 0o700 });
  const cubed = fork(path.join(repo, "packages/server/test/e2e-fixture.ts"), [path.join(work, "state")], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: path.join(work, "home"), PI_CODING_AGENT_DIR: path.join(work, "home", "pi"), CUBED_GATEWAY: gatewayBin,
      CUBED_VM_VCPUS: "1", CUBED_VM_MEMORY_MIB: "1024", CUBED_VM_DISK_GIB: "8" } });
  const output = fs.createWriteStream(path.join(work, "cubed.log"), { flags: "a" });
  cubed.stdout!.pipe(output); cubed.stderr!.pipe(output);
  children.add(cubed);
  const fixture = await new Promise<Record<string, unknown>>((resolve, reject) => {
    cubed.once("message", message => resolve(message as Record<string, unknown>));
    cubed.once("exit", code => reject(new Error(`cubed exited (${code}) before ready`)));
  });
  url = String(fixture.url);
  const model = { provider: fixture.provider, id: fixture.model };
  const project = (await api("/api/projects", "POST", { name: "conc", repositories: [] })).project;
  assert.equal((await api(`/api/projects/${project.id}/check`, "POST", {})).project.status, "ready");
  log("1: runner serves at most 2 machines; cubed enrolled it with 2 slots");

  // 2. Two threads at once; a third finds no free machine.
  const create = (name: string) => call("/api/threads", "POST", { projectId: project.id, requestId: name, text: "hello", model });
  const [a, b] = (await Promise.all([create("a"), create("b")])).map(response => { assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.id as string; });
  const refused = await create("c");
  assert.ok(refused.status >= 400 && /no free thread machine/.test(refused.json.error), JSON.stringify(refused.json));
  const projects = (await api("/api/projects")).projects;
  assert.deepEqual(projects[0].runnerCapacity.slots, { free: 0, total: 2 });
  const booting = Date.now();
  await Promise.all([ready(a), ready(b)]);
  const both = await runnerStatus();
  assert.deepEqual([both.health.activeVms, both.health.runningVms, both.health.maxActiveVms, both.activeThreads], [2, 2, 2, 2]);
  log(`2: two thread VMs booted side by side in ${((Date.now() - booting) / 1000).toFixed(0)} s; a third thread was refused`);

  // 3. Both guests work at the same time, each in its own machine.
  const span = "h=$(hostname); s=$(date +%s%N); sleep 8; touch mine; echo \"$h $s $(date +%s%N) $(ls)\"";
  const [outA, outB] = await Promise.all([bash(a, span), bash(b, span)]);
  const [hostA, startA, endA] = outA.split(" "), [hostB, startB, endB] = outB.split(" ");
  assert.notEqual(hostA, hostB, "two machines");
  assert.ok(BigInt(startA) < BigInt(endB) && BigInt(startB) < BigInt(endA), `overlapping commands: ${outA} | ${outB}`);
  assert.equal(await bash(a, "echo only-a > a.txt; ls"), "a.txt\nmine");
  assert.equal(await bash(b, "ls; test -e a.txt && echo shared || echo separate"), "mine\nseparate");
  log("3: commands ran in both guests at once; files of one thread are not in the other's machine");

  // 4. Archive frees a slot; a new thread boots in it; every archive returns its slot.
  const archived = await api(`/api/threads/${a}`, "DELETE");
  assert.equal(archived.retained, true, "the agent wrote files: its disk is retained");
  const c = await create("c");
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await ready(c.json.id);
  assert.equal(await bash(c.json.id, "ls | wc -l"), "0", "the new machine starts empty");
  assert.equal(await bash(b, "cat /etc/hostname >/dev/null; echo still-here"), "still-here", "the other thread kept working");
  await api(`/api/threads/${b}`, "DELETE");
  await api(`/api/threads/${c.json.id}`, "DELETE");
  const idle = await runnerStatus();
  assert.deepEqual([idle.health.activeVms, idle.activeThreads, (await api("/api/projects")).projects[0].runnerCapacity.slots], [0, 0, { free: 2, total: 2 }]);
  log(`4: archive freed a slot for a third thread; all slots returned (runner retains ${idle.health.retainedVms} disks)`);

  // 5. Stop everything this run started.
  await kill(cubed, "SIGTERM");
  await until("the gateway to exit with cubed", 30, () => gatewayPids().length === 0);
  await kill(runner, "SIGTERM");
  for (const vmId of vmIds) assert.equal(spawnSync("pgrep", ["-f", `guest=${vmId}`]).status, 1, `qemu for ${vmId} is gone`);
  log("5: every process stopped");
  console.log(`test-vm-concurrency: PASS in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} catch (error) {
  console.error("test-vm-concurrency: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await sleep(3000);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of gatewayPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  for (const vmId of vmIds) spawnSync("pkill", ["-f", `guest=${vmId}`]);
  if (process.env.CUBE_SMOKE_KEEP === "1") console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
