// Machine templates with real thread VMs: a disposable cubed (faux model)
// with CUBED_STATE under $TMPDIR, the real cube-gateway and one runner serving
// `--max-active-vms 2`, each guest a Debian genericcloud VM.
//
//   node scripts/test-vm-templates.ts <cube-runner> <cube-gateway> <image.qcow2>
//
// 1 the first thread of a project with hooks builds a template in a build
//   machine (pre-setup runs there), and boots from it; pre-resume runs; 2 the
//   thread's machine has its own identity (machine id, host key, placeholder,
//   empty helper journal) and none of the build machine's; 3 a second thread
//   starts from the same template beside the first, faster, skipping
//   pre-setup, and neither sees the other's files; 4 a changed pre-setup
//   builds a new template and the old one is deleted once its last machine
//   is archived; 5 a runner restart boots the machine again and the resume
//   hooks run again before the agent continues; 6 a failing pre-setup
//   publishes nothing and the thread starts fresh with the failure shown;
//   7 a pre-setup the OOM killer stops: the build and the thread's first try
//   fail saying so, with memory and log (the build's read live), and the
//   next try succeeds; 8 every process stopped. Small VMs (1 vCPU, 1 GiB). CUBE_SMOKE_KEEP=1
//   keeps the work directory; TMPDIR chooses where it is.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";

const [runnerBin, gatewayBin, image] = process.argv.slice(2).map(p => path.resolve(p));
if (!runnerBin || !gatewayBin || !image) throw new Error("usage: test-vm-templates.ts <cube-runner> <cube-gateway> <image.qcow2>");
const repo = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-tpl-"));
fs.chmodSync(work, 0o700);
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
const runnerState = path.join(work, "runner-state");

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  const lines = readline.createInterface({ input: child.stdout! });
  return JSON.parse(await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", code => reject(new Error(`process exited (${code}) before its ready line`)));
  }));
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
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
type Hook = { status: string; exitCode?: number };
type Row = { id: string; state: string; error: string | null; vm: { vmId: string; placeholders: { github: string }; preparation?: { source: string; templateId?: string; reason?: string };
  hooks?: Record<string, Hook>; startup?: { totalMs: number; phases: Record<string, number> } } };
const row = async (id: string) => (await api("/api/threads")).threads.find((candidate: Row) => candidate.id === id) as Row;
async function ready(id: string, seconds = 1200): Promise<Row> {
  const found = await until(`thread ${id.slice(0, 8)} ready`, seconds, async () => { const r = await row(id); return r && r.state !== "starting" ? r : undefined; });
  assert.equal(found.state, "ready", found.error ?? "");
  await until(`thread ${id.slice(0, 8)} first turn`, 180, async () => {
    const history = await api(`/api/threads/${id}/history`);
    return history.status?.run === "cube:initial" && history.status.state === "completed";
  });
  return row(id);
}
let requests = 0;
async function bash(id: string, command: string, seconds = 300): Promise<string> {
  const run = `tpl-${++requests}`;
  await until(`thread ${id.slice(0, 8)} idle`, 300, async () => {
    const response = await call(`/api/threads/${id}/prompt`, "POST", { text: `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs: seconds * 1000 } })}`, requestId: run });
    return response.status < 400;
  });
  const value = await until(`run ${run}`, seconds + 60, async () => {
    const history = await api(`/api/threads/${id}/history`);
    return history.status?.run === run && !["working", "idle"].includes(history.status.state) ? history : undefined;
  });
  assert.equal(value.status.state, "completed", JSON.stringify(value.status));
  const last = [...value.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text: string };
  assert.match(last.text, /^result: /, last.text);
  return last.text.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}
const templateDirs = () => fs.existsSync(path.join(runnerState, "templates")) ? fs.readdirSync(path.join(runnerState, "templates")).sort() : [];
const statuses = (hooks: Record<string, Hook> | undefined) => Object.fromEntries(Object.entries(hooks ?? {}).map(([name, hook]) => [name, hook.status]));
const seconds = (r: Row) => `${((r.vm.startup?.totalMs ?? 0) / 1000).toFixed(0)} s ${JSON.stringify(r.vm.startup?.phases ?? {})}`;

// A fixed port: a restarted runner keeps the address cubed enrolled.
const port = await new Promise<number>(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
function startRunner(): ChildProcess {
  const runner = spawn(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", runnerState,
    "--listen", `127.0.0.1:${port}`, "--max-active-vms", "2"], { stdio: ["ignore", "pipe", "pipe"] });
  runner.stderr!.pipe(fs.createWriteStream(path.join(work, "runner.log"), { flags: "a" }));
  children.add(runner);
  return runner;
}

try {
  const peerOf = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;
  const controlPeer = peerOf(path.join(work, "control.key"));
  peerOf(path.join(work, "runner.key"));
  execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", runnerState, "--image", image,
    "--allow-peer", controlPeer, "--node-id", "node-tpl", "--thread-id", "install-tpl", "--env", "1",
    "--max-vcpus", "1", "--max-memory-mib", "1024", "--max-disk-gib", "16"], { stdio: "ignore" });
  let runner = startRunner();
  const runnerReady = await firstLine(runner);
  const config = path.join(work, "runner.json");
  const address = (runnerReady.addresses as string[])[0];
  fs.writeFileSync(config, JSON.stringify({ version: 2, binding: { nodeId: "node-tpl", threadId: "install-tpl", environmentId: 1 },
    controlKey: path.join(work, "control.key"), serverPeer: runnerReady.peerId, address, network: "loopback" }), { mode: 0o600 });
  fs.mkdirSync(path.join(work, "state"), { mode: 0o700 });
  execFileSync(process.execPath, [path.join(repo, "scripts/enroll-runner.ts"), "--state", path.join(work, "state"), "--config", config, "--trusted-runner"]);
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
  const create = async (projectId: string, name: string) => (await api("/api/threads", "POST", { projectId, requestId: name, text: "hello", model })).id as string;

  // 1. The first thread builds the template, then boots from it.
  const preSetup = "set -e\nsudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q jq >/dev/null\n"
    + "{ date +%s; cat /etc/machine-id; hostname; } | sudo tee /var/tmp/prepared >/dev/null\necho prepared";
  const preResume = "date +%s%N >> \"$HOME/resumed\"";
  const project = (await api("/api/projects", "POST", { name: "tpl", repositories: [], hooks: { preSetup, preResume } })).project;
  assert.equal((await api(`/api/projects/${project.id}/check`, "POST", {})).project.status, "ready");
  const a = await create(project.id, "a");
  const rowA = await ready(a);
  assert.equal(rowA.vm.preparation?.source, "template", JSON.stringify(rowA.vm.preparation));
  assert.deepEqual(statuses(rowA.vm.hooks), { "pre-setup": "skipped", setup: "skipped", "pre-resume": "ok", resume: "absent" });
  const firstTemplate = rowA.vm.preparation!.templateId!;
  assert.deepEqual(templateDirs(), [firstTemplate]);
  assert.ok(rowA.vm.startup!.phases["build-boot"] > 0 && rowA.vm.startup!.phases["build-prepare"] > 0, seconds(rowA));
  log(`1: the first thread built template ${firstTemplate} and booted from it in ${seconds(rowA)}`);

  // 2. Its own identity, none of the build machine's.
  const [stamp, buildMachineId, buildHost] = (await bash(a, "cat /var/tmp/prepared")).split("\n");
  assert.ok(Number(stamp) > 0 && /^[0-9a-f]{32}$/.test(buildMachineId), stamp);
  assert.equal(await bash(a, "command -v jq"), "/usr/bin/jq", "what pre-setup installed is there");
  const idA = await bash(a, "cat /etc/machine-id; hostname");
  assert.notEqual(idA.split("\n")[0], buildMachineId, "a new machine id");
  assert.notEqual(idA.split("\n")[1], buildHost, "a new hostname");
  const hostKey = await bash(a, "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub; ls /etc/ssh | grep -c '^ssh_host_.*_key$'");
  const pinned = fs.readFileSync(path.join(work, "state", "threads", a, "vm", "host_ed25519.pub"), "utf8").split(" ").slice(0, 2).join(" ");
  assert.deepEqual(hostKey.split("\n"), [pinned, "1"], "only the host key cubed pinned for this machine");
  const placeholders = await bash(a, "sudo grep -rhoaE 'cube_ph_github_[A-Za-z0-9]{22}' /etc /home /var/lib/cube /var/tmp /root 2>/dev/null | sort -u");
  assert.deepEqual(placeholders.split("\n"), [rowA.vm.placeholders.github], "no placeholder but its own");
  // ([ ] keeps this command's own journal record from matching itself.)
  const journal = await bash(a, "sudo sh -c 'grep -l \"sbin/cube-guest[ ]seal\" /var/lib/cube/ops/*/request.json 2>/dev/null | wc -l'");
  assert.equal(journal, "0", "the build machine's journal is gone");
  assert.equal(await bash(a, "wc -l < ~/resumed"), "1");
  log("2: the thread's machine has a new machine id, hostname, its pinned host key, its own placeholder and journal");

  // 3. A second thread starts from the same template beside the first.
  const b = await create(project.id, "b");
  const rowB = await ready(b);
  assert.equal(rowB.vm.preparation?.templateId, firstTemplate);
  assert.ok(!rowB.vm.startup!.phases["build-boot"], "no build");
  assert.ok(rowB.vm.startup!.totalMs < rowA.vm.startup!.totalMs, `faster: ${seconds(rowB)} vs ${seconds(rowA)}`);
  await bash(a, "echo only-a > /workspace/a.txt; echo only-a | sudo tee /var/tmp/a-only >/dev/null");
  assert.equal(await bash(b, "ls /workspace; test -e /var/tmp/a-only && echo shared || echo separate; head -1 /var/tmp/prepared"), `separate\n${stamp}`);
  const idB = await bash(b, "cat /etc/machine-id; hostname");
  assert.notEqual(idB, idA, "two machines, two identities");
  log(`3: a second thread started from the template beside the first in ${seconds(rowB)}; their files are separate`);

  // 4. A changed pre-setup means a new template; the old one goes with its last machine.
  await api(`/api/projects/${project.id}`, "PUT", { name: "tpl", repositories: [], hooks: { preSetup: `${preSetup}\necho v2 | sudo tee /var/tmp/v2`, preResume } });
  await api(`/api/threads/${a}`, "DELETE");
  await api(`/api/threads/${a}/discard`, "POST", {});
  const c = await create(project.id, "c");
  const rowC = await ready(c);
  const secondTemplate = rowC.vm.preparation!.templateId!;
  assert.notEqual(secondTemplate, firstTemplate);
  assert.equal(await bash(c, "cat /var/tmp/v2"), "v2");
  assert.deepEqual(templateDirs(), [firstTemplate, secondTemplate].sort(), "the old template stays while b's disk depends on it");
  assert.equal((await api(`/api/threads/${b}`, "DELETE")).retained, true, "b's agent ran commands: its disk is retained");
  assert.deepEqual(templateDirs(), [firstTemplate, secondTemplate].sort(), "a retained disk keeps its template");
  await api(`/api/threads/${b}/discard`, "POST", {});
  assert.deepEqual(templateDirs(), [secondTemplate], "deleted with the last disk that depended on it");
  log(`4: a changed pre-setup built template ${secondTemplate} (${seconds(rowC)}); the superseded one was deleted after its last thread`);

  // 5. A runner restart boots the machine again: resume hooks run again before the agent goes on.
  await stop(runner);
  runner = startRunner();
  assert.deepEqual((await firstLine(runner)).addresses, [address]);
  log("5: runner restarted; waiting for cubed's recovery loop to boot the machine again");
  const resumed = await until("the resume hooks after the restart", 600, async () => {
    try { return (await bash(c, "wc -l < ~/resumed", 60)) === "2" ? true : undefined; } catch { return undefined; }
  });
  assert.ok(resumed);
  log("5: the machine booted again and its resume hooks ran again; the agent continued");

  // 6. A failing pre-setup publishes nothing; the thread starts fresh and shows the failure.
  const broken = (await api("/api/projects", "POST", { name: "broken", repositories: [], hooks: { preSetup: "echo broken; exit 5", preResume: "" } })).project;
  await api(`/api/threads/${c}`, "DELETE");
  await api(`/api/threads/${c}/discard`, "POST", {});
  const d = await create(broken.id, "d");
  const rowD = await ready(d);
  assert.equal(rowD.vm.preparation?.source, "fresh");
  assert.match(rowD.vm.preparation?.reason ?? "", /template build failed: pre-setup failed \(exit 5\)/);
  assert.deepEqual(statuses(rowD.vm.hooks), { "pre-setup": "failed", setup: "notrun", "pre-resume": "absent", resume: "absent" });
  assert.match(await bash(d, "cat ~/.cache/cube/pre-setup.log"), /broken/);
  assert.deepEqual(templateDirs(), [secondTemplate], "nothing published for the broken project");
  log(`6: a failing pre-setup published nothing; the thread started fresh (${seconds(rowD)}) with the failure recorded`);
  await api(`/api/threads/${d}`, "DELETE");

  // 7. A pre-setup the kernel's OOM killer stops: the template build fails
  // saying so, with the build machine's memory and the end of its log, which
  // the thread showed live while it ran; the thread's own first try fails
  // the same way and the recovery loop's next try (same disk) succeeds.
  const hungry = (await api("/api/projects", "POST", { name: "hungry", repositories: [], hooks: { preResume: "", preSetup: [
    "if [ -e /var/tmp/fed ]; then echo fed; exit 0; fi",
    "sudo touch /var/tmp/fed; echo allocating; sleep 25",
    "python3 -c 'x = []\nwhile True: x.append(b\"\\x01\" * (32 << 20))'",
  ].join("\n") } })).project;
  const e = await create(hungry.id, "e");
  const live = await until("the build machine's live log", 300, async () => {
    const { log } = await api(`/api/threads/${e}/startup-log`);
    return log?.machine === "build" && log.hook === "pre-setup" && log.text.includes("allocating") ? log : undefined;
  });
  assert.equal(live.text, "allocating\n");
  const rowE = await until("the thread after its second try", 900, async () => {
    const r = await row(e);
    return r && r.state === "ready" ? r : undefined;
  }) as Row & { vm: { steps: Array<{ name: string; attempt?: number; state: string; detail?: string; log?: string; memory?: { peakBytes: number; totalBytes: number; oomKills: number } }> } };
  const oom = /pre-setup was stopped: the machine ran out of memory \(this command used up to [\d.]+ (MB|GB); the machine has [\d.]+ (MB|GB)\)/;
  assert.equal(rowE.vm.preparation?.source, "fresh");
  assert.match(rowE.vm.preparation?.reason ?? "", new RegExp(`^the template build failed: ${oom.source}$`));
  assert.deepEqual(rowE.vm.steps.map(step => `${step.name}${step.attempt ? ` ${step.attempt}` : ""} ${step.state}`),
    ["lookup ok", "build-boot ok", "build-prepare failed", "boot ok", "prepare 1 failed", "prepare 2 ok", "resume ok"]);
  const [build, , first] = [rowE.vm.steps[2]!, rowE.vm.steps[3]!, rowE.vm.steps[4]!];
  for (const failed of [build, first]) {
    assert.match(failed.detail ?? "", oom);
    assert.ok(failed.memory && failed.memory.oomKills >= 1 && failed.memory.totalBytes < 1.1 * 2 ** 30 && failed.memory.peakBytes > 256 * 2 ** 20, JSON.stringify(failed.memory));
    assert.match(failed.log ?? "", /allocating/, "the end of the killed hook's log");
  }
  assert.match(build.detail!, /; no template was published$/);
  // (Whether bash printed "Killed" before systemd stopped the unit varies.)
  assert.match(await bash(e, "cat ~/.cache/cube/pre-setup.log.prev"), /^allocating(\n|$)/, "the try before keeps its log");
  assert.equal(await bash(e, "cat ~/.cache/cube/pre-setup.log"), "fed");
  const diagnosis = await api(`/api/threads/${e}/diagnostics`);
  assert.equal(diagnosis.diagnostics.thread.machine.steps.length, 7);
  log(`7: an OOM-killed pre-setup: the build failed saying so (memory peak ${(build.memory!.peakBytes / 2 ** 20).toFixed(0)} MiB of ${(build.memory!.totalBytes / 2 ** 20).toFixed(0)} MiB, ${build.memory!.oomKills} killed), its log was live and kept; the thread's next try succeeded (${seconds(rowE)})`);
  await api(`/api/threads/${e}`, "DELETE");

  // 8. Stop everything this run started.
  await stop(cubed);
  await until("the gateway to exit with cubed", 30, () => gatewayPids().length === 0);
  await stop(runner);
  assert.equal(spawnSync("pgrep", ["-f", `${runnerState}/vms/`]).status, 1, "no qemu left");
  log("8: every process stopped");
  console.log(`test-vm-templates: PASS in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} catch (error) {
  console.error("test-vm-templates: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await sleep(3000);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of gatewayPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  spawnSync("pkill", ["-f", `${runnerState}/vms/`]);
  if (process.env.CUBE_SMOKE_KEEP === "1") console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
