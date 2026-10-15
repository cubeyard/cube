/** cubed's real code with a real `berth vm` (C-a): a fresh cubed in this
 * process (createCubed with a new state, a faux model, the real
 * cube-gateway built with test-hooks, the real ProtocolMachines and
 * RunnerMachines with its egress policy) and a keel machine under QEMU.
 *
 * berth vm is enrolled in this test's cubed only, and takes threads only by
 * name (C-a decision 1): a thread started without a runner is refused (the
 * pool is empty), and OptChat's spawn naming it starts one there. The thread
 * boots with its boot documents and policy, checks out a repository through
 * the credential stream from test-vm-e2e's fake GitHub (fake-github.ts; the
 * host side resolves it from a local mirror through GIT_CONFIG_GLOBAL), runs
 * the project's pre-setup hook and the repository's `.agents/setup`, gets
 * the portal's settings without its agent being replaced, runs a tool call,
 * pushes through the credential stream (the guest holds only the
 * placeholder), serves the portal over `dial`, is diagnosed with berth's
 * document, survives a restart of berth with its resume hooks, and is
 * archived (retained, within the stop deadline) and discarded.
 *
 *   node packages/server/test/runner-vm-cubed-test.ts target/debug/berth
 *
 * The environment is runner-vm-test.ts's: CUBE_TEST_BERTH_QEMU,
 * CUBE_TEST_BERTH_QEMU_IMG, CUBE_TEST_BERTH_KEEL, CUBE_TEST_BERTH_IMAGE (an
 * image keel says ready for: bash, sudo, flock, git, gh, curl, perl and a CA
 * bundle), CUBE_TEST_BERTH_MKFS, CUBE_TEST_BERTH_ACCEL, CUBE_TEST_BERTH_PULLED,
 * CUBE_TEST_BERTH_GATEWAY and CUBE_TEST_BERTH_TMP; without them it is skipped
 * with a notice, and CUBE_TEST_BERTH_VM=required makes that a failure. Loopback
 * only; nothing outside its temporary directory. Mocks are not runner
 * acceptance; this is not one. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { fakeGithub, git } from "../../../scripts/fake-github.ts";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { portalSettings } from "../src/portal.ts";
import { enrollRunner } from "../src/runner-enroll.ts";
import { describeRunners, observeRunners } from "../src/runner-observe.ts";
import { STOP_TIMEOUT_MS } from "../src/runner-session.ts";
import { DIAL_APP, request } from "./portal-dial.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const started = Date.now();
const note = (line: string) => console.log(`runner-vm-cubed-test [${((Date.now() - started) / 1000).toFixed(1)}s]: ${line}`);

const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const image = env.CUBE_TEST_BERTH_IMAGE ?? "";
const mkfs = env.CUBE_TEST_BERTH_MKFS ?? "";
const pulled = env.CUBE_TEST_BERTH_PULLED ?? "";
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(image) ? [] : ["CUBE_TEST_BERTH_IMAGE=<registry/repository@sha256:digest>"]),
  ...(path.isAbsolute(mkfs) && fs.existsSync(mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS=<absolute mkfs.erofs path>"]),
];
if (missing.length) {
  console.error(`\nSKIP: cubed with berth vm did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cvc-")));
const directory = path.join(root, "m");
const state = path.join(root, "state");
const node = "node-vm-cubed";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };

// ---------------------------------------------------------------- berth vm

let listen = "127.0.0.1:0";
async function start(first: boolean): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--accel", accel, "--image", image, "--listen", listen, ...(first ? ["--allow-peer", control.peerId, "--node-id", node] : [])],
  // Its own process group, as in a terminal: a Ctrl-C reaches the whole group.
  { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  const log = fs.createWriteStream(path.join(root, "berth.log"), { flags: "a" });
  child.stderr!.on("data", chunk => log.write(chunk));
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  return { child, peer: field("peer"), address: field("listen").split(", ")[0]!, banner };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGINT");
  await exited;
}
if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
let runner = await start(true);
listen = runner.address;
note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|listen):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 9 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });

// ---------------------------------------------------------------- the fake GitHub and the repository

const token = `ghs_ca${randomBytes(12).toString("hex")}`;
const github = await fakeGithub({ dir: path.join(root, "github"), token });
const seed = path.join(root, "seed");
git(root, "clone", "-q", github.repository, seed);
fs.mkdirSync(path.join(seed, ".agents"));
fs.writeFileSync(path.join(seed, ".agents", "setup"), "#!/bin/bash\necho \"setup as $(id -un) in $PWD\" >> ~/ca-hooks.log\n", { mode: 0o755 });
fs.writeFileSync(path.join(seed, ".agents", "resume"), "#!/bin/bash\necho \"resume $(cat /proc/sys/kernel/random/boot_id)\" >> ~/ca-hooks.log\n", { mode: 0o755 });
git(seed, "add", "-A");
git(seed, "commit", "-qm", "hooks");
git(seed, "push", "-q", "origin", "HEAD:main");
const upstream = "https://github.com/cube-e2e/repo.git";
// cubed's host side resolves the repository from the fake's directory; the
// guest reaches the fake only through berth, the credential stream and the
// gateway's test upstream.
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(gitconfig, `[url "file://${path.join(root, "github", "cube-e2e")}/"]\n\tinsteadOf = https://github.com/cube-e2e/\n`);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY || (() => {
  execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks"],
    { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
  return path.join(repo, "target/test-hooks/debug/cube-gateway");
})();
process.env.CUBED_GATEWAY_TEST_ARGS = JSON.stringify(["--test-upstream", `github.com=127.0.0.1:${github.port}`,
  "--test-upstream", `api.github.com=127.0.0.1:${github.port}`, "--test-upstream-ca", github.ca]);
process.env.CUBED_VM_VCPUS = "2";
process.env.CUBED_VM_MEMORY_MIB = "2048";
process.env.CUBED_VM_DISK_GIB = "16";

// ---------------------------------------------------------------- cubed

const free = net.createServer().listen(0, "127.0.0.1");
await once(free, "listening");
const portalPort = (free.address() as net.AddressInfo).port;
await new Promise(resolve => free.close(resolve));
const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 4, max: 8 } });
// As e2e-fixture.ts: `tool {"name","args"}` calls that tool; then `result: <output>`.
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: Array<{ role: string; content: unknown }> }) => {
  const last = request.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`result: ${text(last.content)}`);
  const prompt = text(last?.content).trim();
  if (prompt.startsWith("tool ")) {
    const { name, args } = JSON.parse(prompt.slice(5)) as { name: string; args: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state, models, claude: null, gateway: gatewayBin, skillSource: null,
  secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => token }],
  portal: portalSettings({ CUBED_PORTAL_IP: "127.0.0.1", CUBED_PORTAL_DOMAIN: "localhost", CUBED_PORTAL_PORT: String(portalPort) }) });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${route}: ${response.status} ${answer}`);
  return answer ? JSON.parse(answer) : undefined;
};
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await delay(250);
  }
}
let requests = 0;
async function prompt(id: string, line: string, ms = 300000): Promise<string> {
  const run = `ca-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text: line, requestId: run });
  const history = await until(`run ${run}`, ms, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === run && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  assert.equal(history.status.state, "completed", JSON.stringify(history.status));
  const last = [...history.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text?: string } | undefined;
  return last?.text ?? "";
}
async function bash(id: string, command: string, ms = 300000): Promise<string> {
  const answer = await prompt(id, `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs: Math.min(ms, 600000) } })}`, ms + 30000);
  assert.match(answer, /^result: /, answer);
  return answer.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}

try {
  // enrollment: berth vm by its hello, outside the pool
  const enrolled = await enrollRunner({ state, configPath });
  assert.equal(enrolled.profile, "vm-runner");
  assert.match(enrolled.next, /by name/);
  const admitted = app.registry.getRunner(node)!;
  assert.deepEqual([admitted.protocol, admitted.kind], [4, "vm"]);
  const overview = describeRunners(observeRunners(app.registry, 60_000));
  assert.match(overview, /protocol-4 VM runner \(berth vm\): not in the pool yet/);
  assert.match(overview, /pool: 0 of 0 slots free across 0 runners/, "berth vm is not in the pool");
  note("enrolled in this test's cubed only; not in the pool");

  await api("/api/onboarding", "POST", {});
  const project = (await api("/api/projects", "POST", { name: "ca", repositories: [{ url: upstream, base: "main" }],
    hooks: { preSetup: "echo \"pre-setup as $(id -un)\" >> ~/ca-hooks.log", preResume: "echo \"pre-resume $(cat /proc/sys/kernel/random/boot_id)\" >> ~/ca-hooks.log" } })).project as { id: string };
  const ready = await until("the project is ready", 60000, async () => {
    const row = (await api("/api/projects")).projects.find((p: { id: string }) => p.id === project.id) as { status: string; error: string | null };
    return row.status !== "checking" ? row : undefined;
  });
  assert.equal(ready.status, "ready", ready.error ?? "");
  const threads = cubeThreads({ registry: app.registry, conversations: app.conversations,
    catalog: async () => [{ provider: faux.getModel().provider, id: faux.getModel().id }],
    runners: () => observeRunners(app.registry, 60_000),
    latestCommits: async () => {
      const current = app.registry.getProject(project.id)!;
      return { projectRevision: current.revision, repositories: current.repositories.map(r => ({ url: r.url, base: r.resolvedBase!, baseOid: r.baseOid! })) };
    } });

  // a thread that names no runner never lands on berth vm
  await assert.rejects(threads.spawn({ project: "ca", task: "pool" }, "req-pool"), /no free thread machine in the global runner pool/);
  assert.equal(app.registry.listThreads().length, 0);
  note("a thread without a runner name was refused: the pool is empty, berth vm is not in it");

  // spawn naming berth vm: boot, boot documents, policy, checkout and hooks
  const booting = Date.now();
  const spawned = await threads.spawn({ project: "ca", task: "say hi", runner: node }, "req-vm");
  const id = spawned.id;
  const thread = app.registry.getThread(id)!;
  assert.deepEqual([thread.runnerId, thread.pinned], [node, true]);
  await until("the thread's machine is ready", 900000, () => {
    const current = app.registry.getThread(id)!;
    if (current.workspaceState === "failed") throw new Error(`the machine failed: ${current.workspaceError}`);
    return current.workspaceState === "available";
  });
  const vm = app.registry.getThread(id)!.vm!;
  const steps = vm.steps!.map(step => `${step.name}:${step.state}`);
  assert.ok(steps.includes("boot:ok") && steps.includes("prepare:ok") && steps.includes("resume:ok"), steps.join(", "));
  assert.match(vm.steps!.find(step => step.name === "boot")!.detail ?? "", new RegExp(`^a keel machine on VM runner ${node}: 2 vCPU, 2048 MiB memory, 16 GiB disk$`));
  assert.deepEqual(Object.fromEntries(Object.entries(vm.hooks ?? {}).map(([name, hook]) => [name, hook.status])),
    { "pre-setup": "ok", setup: "ok", "pre-resume": "ok", resume: "ok" }, JSON.stringify(vm.hooks));
  note(`ready in ${((Date.now() - booting) / 1000).toFixed(1)} s: ${steps.join(", ")}`);

  // a tool call in the keel machine
  const facts = (await bash(id, "id -un; pwd; hostname; cat /etc/cube/hooks/pre-setup | tail -1; cat repo/.agents/setup | tail -1 | cut -c1-12; "
    + "cat ~/ca-hooks.log; printenv GH_TOKEN")).split("\n");
  assert.deepEqual(facts.slice(0, 3), ["agent", "/workspace", `cube-${vm.vmId.slice(0, 8)}`], "the hostname document");
  assert.equal(facts[3], "echo \"pre-setup as $(id -un)\" >> ~/ca-hooks.log", "the pre-setup document");
  assert.equal(facts[4], "echo \"setup a");
  assert.deepEqual(facts.slice(5, 7), ["pre-setup as agent", "setup as agent in /workspace/repo"]);
  assert.match(facts.at(-1)!, /^cube_ph_github_[A-Za-z0-9]{22}$/, "the env document: the guest holds the placeholder only");
  assert.equal(facts.at(-1), vm.placeholders.github);
  note("tool call: hostname, env and hook documents in the machine; pre-setup, setup, pre-resume and resume ran");

  // git push through the credential stream: the token stays on this host
  const pushed = await bash(id, "set -e; cd repo; echo ca > ca.txt; git add ca.txt; git -c user.name=ca -c user.email=ca@example.invalid commit -qm ca; "
    + "git push -q origin HEAD:refs/heads/ca-push; git rev-parse HEAD", 300000);
  assert.equal(git(github.repository, "rev-parse", "ca-push"), pushed.split("\n").at(-1), "the push reached the fake GitHub");
  assert.ok(github.seen.some(seen => seen.method === "POST" && seen.path.endsWith("/git-receive-pack") && seen.auth === "token"), JSON.stringify(github.seen));
  assert.ok(!github.seen.some(seen => seen.auth === "placeholder"), "no placeholder reached GitHub");
  note("git push went through berth's credential stream and cubed's gateway; GitHub saw the token, the guest only the placeholder");

  // the portal over `dial`
  const write = await prompt(id, `tool ${JSON.stringify({ name: "write", args: { path: "ca-app/dial-app.pl", content: fs.readFileSync(DIAL_APP, "utf8") } })}`);
  assert.match(write, /^result: /);
  const servicePort = 18080;
  await bash(id, `mkdir -p /tmp/ca-app-state && cube service start dialapp --port ${servicePort} --cwd ca-app --env CUBE_APP_STATE=/tmp/ca-app-state --json -- perl dial-app.pl`, 120000);
  const label = app.portal!.label(id);
  const host = `dialapp-${label}.localhost:${portalPort}`;
  // refreshGuest gave keel's cube command the portal's settings (and replaced nothing).
  const listed = await bash(id, "cube service list --json");
  assert.ok(listed.includes(`http://${host}/`), listed);
  const served = await until("the portal serves dial-app", 60000, async () => {
    const answer = await request(portalPort, host, "GET", "/").catch(() => null);
    return answer?.status === 200 ? answer : undefined;
  });
  assert.equal(served.body.toString(), "dial-app: hello from dialapp\n");
  const body = randomBytes(256 * 1024);
  const echoed = await request(portalPort, host, "POST", "/echo", body);
  assert.ok(echoed.status === 200 && echoed.body.equals(body), "256 KiB through the portal and back");
  note(`portal: ${host} reached dial-app.pl in the machine over berth's dial`);

  // the diagnosis: berth's bounded, redacted document as cubed's machine evidence
  const diagnostics = (await api(`/api/threads/${id}/diagnostics`)).diagnostics as { machine: { runner: Record<string, any>; gateway: { status: string } } };
  const evidence = diagnostics.machine.runner;
  assert.equal(evidence.status, "observed", JSON.stringify(evidence));
  assert.equal(evidence.method, "machine_diagnose");
  const doc = evidence.diagnosis;
  assert.equal(doc.qemu.path, qemu, "the real QEMU path (B-9 P4)");
  assert.equal(doc.machine.ref.id, vm.vmId);
  assert.equal(doc.egress.policy.summary.default, "allow_public_http", "the policy cubed sent, its default explicit");
  assert.equal(doc.egress.policy.summary.leaseSeconds, 900, "and its 15-minute lease");
  assert.deepEqual(doc.egress.policy.summary.rules.shown.map((rule: { credential: string }) => rule.credential), ["github"]);
  const whole = JSON.stringify(diagnostics);
  assert.ok(Buffer.byteLength(whole) < 600 * 1024, `${Buffer.byteLength(whole)} bytes`);
  assert.ok(!whole.includes(token), "no token in the diagnosis");
  assert.ok(!whole.includes(vm.placeholders.github!), "no placeholder in the diagnosis");
  const said = (await (await fetch(`${url}/api/threads/${id}/diagnostics`)).text()).length;
  note(`diagnosis: ${Buffer.byteLength(JSON.stringify(doc))} bytes from berth (${said} in the bundle); QEMU ${doc.qemu.version} ${doc.qemu.path}`);

  // berth restarts: the thread's machine boots again with its resume hooks
  const bootBefore = (await bash(id, "cat /proc/sys/kernel/random/boot_id")).trim();
  await stop(runner.child);
  runner = await start(false);
  note("berth vm restarted on the same address");
  await until("the thread's machine runs again after berth's restart", 600000, async () => {
    void app.conversations.activate(id);
    const answer = await bash(id, "cat /proc/sys/kernel/random/boot_id", 60000).catch(() => "");
    return answer && answer !== bootBefore ? answer : undefined;
  });
  const hooks = (await bash(id, "cat ~/ca-hooks.log")).split("\n");
  assert.equal(hooks.filter(line => line.startsWith("pre-resume ")).length, 2, hooks.join("\n"));
  assert.equal(hooks.filter(line => line.startsWith("resume ")).length, 2, hooks.join("\n"));
  assert.equal(await bash(id, "cat repo/ca.txt"), "ca", "the disk was kept across the restart");
  note("after berth's restart the machine booted again, ran pre-resume and resume, and kept its disk");

  // archive: dirty, so the disk is retained; berth stops the machine within the deadline
  await bash(id, "echo dirty > repo/uncommitted.txt");
  const archiving = Date.now();
  let archived: { ok?: boolean; retained?: boolean; reason?: string; error?: string } = {};
  for (let tries = 0; tries < 200 && !archived.ok; tries++) {
    archived = await (await fetch(`${url}/api/threads/${id}`, { method: "DELETE" })).json() as typeof archived;
    if (!archived.ok) await delay(500);
  }
  const archiveMs = Date.now() - archiving;
  assert.equal(archived.retained, true, JSON.stringify(archived));
  assert.ok(archiveMs < STOP_TIMEOUT_MS, `archived in ${archiveMs} ms`);
  const record = JSON.parse(fs.readFileSync(path.join(directory, vm.vmId, "machine.json"), "utf8")) as { phase: string; stopped?: { kind: string } };
  assert.equal(record.phase.toLowerCase(), "retained");
  note(`archived in ${(archiveMs / 1000).toFixed(1)} s (deadline ${STOP_TIMEOUT_MS / 1000} s): retained, stop ${record.stopped?.kind ?? "?"}: ${archived.reason}`);

  // discard: berth deletes the retained machine
  await api(`/api/threads/${id}/discard`, "POST", {});
  assert.equal(app.registry.getThread(id)!.vm!.discarded, true);
  await until("the machine's directory is gone", 30000, () => !fs.existsSync(path.join(directory, vm.vmId)));
  note("discarded: berth deleted the machine's directory");
  console.log("ok: cubed with berth vm: by name only, boot documents and policy, checkout and hooks, a tool call, push through the credential stream, "
    + "the portal over dial, berth's diagnosis, a berth restart with resume hooks, archive retained within the stop deadline, discard");
} finally {
  app.server.closeAllConnections();
  await app.close();
  await stop(runner.child);
  github.close();
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  if (env.CUBE_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
  else note(`kept ${root}`);
}
