/** cubed's real code with a real `berth vm` (C-a): a fresh cubed in this
 * process (createCubed with a new state, a faux model, the real
 * cube-gateway built with test-hooks, the real ProtocolMachines and
 * RunnerMachines with its egress policy) and a keel machine under QEMU.
 *
 * berth vm is enrolled in this test's cubed only, where it is the whole
 * pool: OptChat's spawn naming it starts a thread there, pinned, and a
 * spawn that names no runner is placed there too, unpinned. The first
 * thread of the project builds its template first (C-5): a build machine
 * of cubed's own (its own id and placeholder, no agent) boots from the
 * base, checks out a repository through the credential stream from
 * test-vm-e2e's fake GitHub (fake-github.ts; the host side resolves it from
 * a local mirror through GIT_CONFIG_GLOBAL), runs the project's pre-setup
 * hook (a slow one, whose log the thread's startup log shows while it runs:
 * keel's read, C-2b) and the repository's `.agents/setup`, and is published
 * by keel and berth; the thread's own machine then starts from that
 * template with its boot documents and policy, and skips setup. A second
 * thread of the project, from the pool, starts from the template too, and a third, pinned
 * to a commit whose `.agents/setup` changed, runs setup itself and removes
 * the template. The first thread gets
 * the portal's settings without its agent being replaced, runs a tool call,
 * pushes through the credential stream (the guest holds only the
 * placeholder), serves the portal over `dial`, is diagnosed with berth's
 * document and what its keel agent says of itself (version, build, boot,
 * hooks), logs the Iroh path in use and its RTT for each connection to
 * berth (K-2b), survives a restart of berth with its resume hooks, gets the
 * answer of a forced `machine_stop` (a paused guest: berth's whole 30 s
 * SHUTDOWN_WAIT) within cubed's stop deadline and starts again, and is
 * archived (retained) and discarded.
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
import { CLOSE_MS, createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { portalSettings } from "../src/portal.ts";
import { enrollRunner } from "../src/runner-enroll.ts";
import { describeRunners, observeRunners } from "../src/runner-observe.ts";
import { MachineStatus_Phase, Template_State } from "../src/gen/runner_pb.js";
import { runnerSession, STOP_TIMEOUT_MS } from "../src/runner-session.ts";
import { currentMachineEpoch } from "../src/vm.ts";
import { formatDiagnostics } from "../src/vm-diagnostics.ts";
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
/** One QMP command on a machine's socket (berth holds no connection between verbs). */
async function qmp(socketPath: string, command: string): Promise<void> {
  const socket = net.connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const next = async () => {
    for (;;) {
      const line = buffer.indexOf("\n");
      if (line >= 0) { const message = JSON.parse(buffer.slice(0, line)); buffer = buffer.slice(line + 1); if (!("event" in message)) return message; continue; }
      const [chunk] = await once(socket, "data") as [string];
      buffer += chunk;
    }
  };
  try {
    await next();
    socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
    await next();
    socket.write(`${JSON.stringify({ execute: command })}\n`);
    const answer = await next() as { return?: unknown };
    assert.ok(answer.return !== undefined, `${command}: ${JSON.stringify(answer)}`);
  } finally { socket.destroy(); }
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
faux.setResponses(Array.from({ length: 1000 }, () => async (request: { messages: Array<{ role: string; content: unknown }> }) => {
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
// cubed's log in this process: its runner session's lines (K-2b), kept and still written.
const sessionLines: string[] = [];
const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  if (typeof chunk === "string" && chunk.startsWith("info runner-session ")) sessionLines.push(chunk);
  return write(chunk, ...rest);
}) as typeof process.stdout.write;
/** The fields of cubed's `msg` lines about this test's runner. */
const sessionLog = (msg: string) => sessionLines.filter(line => line.startsWith(`info runner-session ${msg} `)).map(line =>
  Object.fromEntries([...line.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, name, value]) => [name!, value!.startsWith("\"") ? JSON.parse(value!) as string : value!])))
  .filter(fields => fields.runner === node);
const openCubed = () => createCubed({ state, models, claude: null, gateway: gatewayBin, skillSource: null,
  secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => token }],
  portal: portalSettings({ CUBED_PORTAL_IP: "127.0.0.1", CUBED_PORTAL_DOMAIN: "localhost", CUBED_PORTAL_PORT: String(portalPort) }) });
// `let`: the restart below (G1) opens cubed again on the same state.
let app = await openCubed();
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
let url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${route}: ${response.status} ${answer}`);
  return answer ? JSON.parse(answer) : undefined;
};
/** `expected` appear in `actual` in this order (other entries may come between). */
function assertInOrder(actual: string[], expected: string[]): void {
  let at = 0;
  for (const item of actual) if (item === expected[at]) at++;
  assert.equal(at, expected.length, `expected ${expected.join(", ")} in order; got ${actual.join(", ")}`);
}
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
  // enrollment: berth vm by its hello, in the pool
  const enrolled = await enrollRunner({ state, configPath });
  assert.equal(enrolled.profile, "vm-runner");
  assert.match(enrolled.next, /the pool places it on a berth vm/);
  const admitted = app.registry.getRunner(node)!;
  assert.deepEqual([admitted.protocol, admitted.kind], [4, "vm"]);
  const overview = describeRunners(observeRunners(app.registry, 60_000));
  assert.match(overview, /protocol-4 VM runner \(berth vm\): in the pool/);
  assert.match(overview, new RegExp(`pool: ${enrolled.maxActiveVms} of ${enrolled.maxActiveVms} slots free across 1 runners`), "berth vm is the pool");
  note(`enrolled in this test's cubed only; the pool is this berth vm (${enrolled.maxActiveVms} slots)`);

  await api("/api/onboarding", "POST", {});
  const MARKER = `c2b-pre-setup-${randomBytes(4).toString("hex")}`;
  const project = (await api("/api/projects", "POST", { name: "ca", repositories: [{ url: upstream, base: "main" }],
    // Slow, with a marker in its log (C-2b); the last line is what the tool call reads back.
    hooks: { preSetup: `echo ${MARKER}; sleep 8\necho "pre-setup as $(id -un)" >> ~/ca-hooks.log`, preResume: "echo \"pre-resume $(cat /proc/sys/kernel/random/boot_id)\" >> ~/ca-hooks.log" } })).project as { id: string };
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

  // spawn naming berth vm: the template build, then boot, boot documents, policy, checkout and hooks
  // a deployment's gateway is up before any thread starts; the credential route refuses, not waits, while it starts (F-Ca-2)
  assert.ok(app.gateway, "cubed started its gateway");
  await app.gateway.ready();
  const seenBefore = github.seen.length;
  const booting = Date.now();
  const spawned = await threads.spawn({ project: "ca", task: "say hi", runner: node }, "req-vm");
  const id = spawned.id;
  const thread = app.registry.getThread(id)!;
  assert.deepEqual([thread.runnerId, thread.pinned], [node, true]);
  // While pre-setup runs, the thread's startup log is its log, read in the keel machine.
  let live = null as { machine: string; hook: string | null; text: string } | null;
  const reads: string[] = [];
  await until("the thread's machine is ready", 900000, async () => {
    const current = app.registry.getThread(id)!;
    if (current.workspaceState === "failed") throw new Error(`the machine failed: ${current.workspaceError}`);
    if (!live) {
      const { log } = await api(`/api/threads/${id}/startup-log`) as { log: { machine: string; hook: string | null; text: string; error?: string } | null };
      const seen = log === null ? "null" : log.error ? `error ${log.error}` : `hook ${log.hook}`;
      if (reads.at(-1) !== seen) reads.push(seen);
      if (log?.hook === "pre-setup" && log.text.includes(MARKER)) live = log;
    }
    return current.workspaceState === "available";
  });
  assert.ok(live, `the startup log showed pre-setup and its marker while it ran; it said: ${reads.join(" -> ")}`);
  assert.equal(live!.machine, "build", "pre-setup ran in the template's build machine");
  note(`startup log while pre-setup ran: ${live!.machine} machine, hook ${live!.hook}, ${JSON.stringify(live!.text.trim())} (reads: ${reads.join(" -> ")})`);
  const vm = app.registry.getThread(id)!.vm!;
  const steps = vm.steps!.map(step => `${step.name}:${step.state}`);
  assertInOrder(steps, ["lookup:ok", "build-boot:ok", "build-prepare:ok", "build-publish:ok", "boot:ok", "prepare:ok", "resume:ok"]);
  assert.ok(!steps.some(step => step.startsWith("build-seal")), "no seal on keel: template_publish cleans the layer itself");
  assert.equal(vm.steps!.find(step => step.name === "lookup")!.detail, "the project has no template on this runner yet: building one");
  assert.equal(vm.steps!.find(step => step.name === "build-prepare")!.detail, "pre-setup ok, setup ok", "pre-setup and setup ran in the build machine");
  assert.match(vm.steps!.find(step => step.name === "boot")!.detail ?? "", new RegExp(`^a keel machine on VM runner ${node}: 2 vCPU, 2048 MiB memory, 16 GiB disk$`));
  // The template: the build machine's id; berth deleted the build machine (C1), cubed forgot it.
  const templateId = vm.preparation?.templateId ?? "";
  assert.deepEqual([vm.preparation?.source, /^[0-9a-f]{16}$/.test(templateId), templateId !== vm.vmId, vm.build], ["template", true, true, undefined], JSON.stringify(vm.preparation));
  assert.ok(fs.existsSync(path.join(directory, "templates", `${templateId}.erofs`)), "berth keeps the layer");
  assert.ok(!fs.existsSync(path.join(directory, templateId)), "the build machine is gone");
  const publishedTemplates = await runnerSession(app.registry.getRunner(node)!).call({ case: "templateList", value: {} });
  assert.ok(publishedTemplates.case === "templates" && publishedTemplates.value.items.length === 1 && publishedTemplates.value.items[0]!.id === templateId, "one template");
  assert.equal(JSON.parse(publishedTemplates.value.items[0]!.meta).projectId, project.id);
  // The build machine checked out through berth's credential stream (the fake GitHub wants the token), and so did the thread's machine.
  const fetches = github.seen.slice(seenBefore).filter(seen => seen.method === "POST" && seen.path.endsWith("/git-upload-pack"));
  assert.ok(fetches.length >= 2 && fetches.every(seen => seen.auth === "token"), JSON.stringify(github.seen.slice(seenBefore)));
  // From the template, setup is not run again in the thread's machine.
  assert.deepEqual(Object.fromEntries(Object.entries(vm.hooks ?? {}).map(([name, hook]) => [name, hook.status])),
    { "pre-setup": "skipped", setup: "skipped", "pre-resume": "ok", resume: "ok" }, JSON.stringify(vm.hooks));
  note(`template ${templateId} built in the thread's slot (${vm.steps!.filter(step => step.name.startsWith("build-")).map(step => `${step.name} ${((step.endedAt! - step.startedAt) / 1000).toFixed(1)} s`).join(", ")}); `
    + `ready in ${((Date.now() - booting) / 1000).toFixed(1)} s: ${steps.join(", ")}`);
  // The task is the first turn; a prompt during it is refused.
  await until("the first turn", 300000, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === "cube:initial" && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });

  // a tool call in the keel machine
  const facts = (await bash(id, "id -un; pwd; hostname; cat /etc/cube/hooks/pre-setup | tail -1; cat .agents/setup | tail -1; "
    + "cat ~/ca-hooks.log; printenv GH_TOKEN")).split("\n");
  assert.deepEqual(facts.slice(0, 3), ["agent", "/workspace", `cube-${vm.vmId.slice(0, 8)}`], "the hostname document");
  assert.equal(facts[3], "echo \"pre-setup as $(id -un)\" >> ~/ca-hooks.log", "the pre-setup document");
  assert.equal(facts[4], "echo \"setup as $(id -un) in $PWD\" >> ~/ca-hooks.log", "the repository's setup hook");
  // Written in the build machine, and in the template since.
  assert.deepEqual(facts.slice(5, 7), ["pre-setup as agent", "setup as agent in /workspace"]);
  assert.match(facts.at(-1)!, /^cube_ph_github_[A-Za-z0-9]{22}$/, "the env document: the guest holds the placeholder only");
  assert.equal(facts.at(-1), vm.placeholders.github);
  note("tool call: hostname, env and hook documents in the machine; pre-setup, setup, pre-resume and resume ran");

  // git push through the credential stream: the token stays on this host
  const pushed = await bash(id, "set -e; echo ca > ca.txt; git add ca.txt; git -c user.name=ca -c user.email=ca@example.invalid commit -qm ca; "
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
  const diagnostics = (await api(`/api/threads/${id}/diagnostics`)).diagnostics as { machine: { runner: Record<string, any>; gateway: { status: string }; guest: Record<string, any> } };
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
  // keel's own word on itself, from berth's watch (C-2b).
  const guest = diagnostics.machine.guest;
  assert.deepEqual([guest.status, guest.ready, guest.error], ["observed", true, null], JSON.stringify(guest));
  assert.match(guest.agent.version, /^\d+\.\d+\.\d+/, JSON.stringify(guest.agent));
  assert.match(guest.agent.build, /^[0-9a-f]{64}$/);
  assert.match(guest.agent.bootId, /^[0-9a-f-]{36}$/);
  assert.ok(guest.agent.kernel.length > 0);
  note(`keel agent (first boot): ${JSON.stringify(guest.agent)}`);
  const said = (await (await fetch(`${url}/api/threads/${id}/diagnostics`)).text()).length;
  note(`diagnosis: ${Buffer.byteLength(JSON.stringify(doc))} bytes from berth (${said} in the bundle); QEMU ${doc.qemu.version} ${doc.qemu.path}`);

  // K-2b: cubed logged the path in use to berth after hello, its RTT and berth's own (rtt_to_cubed).
  const connectedBefore = sessionLog("runner connected");
  assert.ok(connectedBefore.length >= 1, sessionLines.join(""));
  for (const line of connectedBefore) {
    assert.deepEqual([line.network, line.kind], ["loopback", "direct"], JSON.stringify(line));
    assert.match(line.remote ?? "", /^(127\.0\.0\.1|\[::1\]):\d+$/, JSON.stringify(line));
    assert.match(line.rttMs ?? "", /^\d+$/, JSON.stringify(line));
    assert.match(line.runnerRttMs ?? "", /^\d+(\.\d+)?$/, JSON.stringify(line));
  }
  note(`cubed's path lines before berth's restart: ${connectedBefore.length} connected, ${sessionLog("runner path changed").length} changed, `
    + `${sessionLog("runner disconnected").length} disconnected; first ${JSON.stringify(connectedBefore[0])}`);

  // C-5: a second thread of the project starts from the template; setup does not run again.
  const waitReady = (threadId: string, what: string) => until(what, 900000, () => {
    const current = app.registry.getThread(threadId)!;
    if (current.workspaceState === "failed") throw new Error(`${what}: the machine failed: ${current.workspaceError}`);
    return current.workspaceState === "available";
  });
  const firstTurn = (threadId: string) => until("the first turn", 300000, async () => {
    const value = await api(`/api/threads/${threadId}/history`);
    return value.status?.run === "cube:initial" && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  const archive = async (threadId: string) => {
    let answer: { ok?: boolean; retained?: boolean; reason?: string } = {};
    for (let tries = 0; tries < 200 && !answer.ok; tries++) {
      answer = await (await fetch(`${url}/api/threads/${threadId}`, { method: "DELETE" })).json() as typeof answer;
      if (!answer.ok) await delay(500);
    }
    assert.ok(answer.ok, JSON.stringify(answer));
    return answer;
  };
  const hookStatus = (threadId: string) => Object.fromEntries(Object.entries(app.registry.getThread(threadId)!.vm!.hooks ?? {}).map(([name, hook]) => [name, hook.status]));
  const secondBooting = Date.now();
  // No runner named: the pool places it on the berth vm, unpinned.
  const second = (await threads.spawn({ project: "ca", task: "from the template" }, "req-vm-2")).id;
  assert.deepEqual([app.registry.getThread(second)!.runnerId, app.registry.getThread(second)!.pinned], [node, undefined], "a thread that names no runner is placed on berth vm");
  await waitReady(second, "the second thread's machine is ready");
  const vm2 = app.registry.getThread(second)!.vm!;
  const steps2 = vm2.steps!.map(step => `${step.name}:${step.state}`);
  assert.ok(!steps2.some(step => step.startsWith("build-")), `nothing built for the second thread: ${steps2.join(", ")}`);
  assertInOrder(steps2, ["lookup:ok", "boot:ok", "prepare:ok", "resume:ok"]);
  assert.match(vm2.steps!.find(step => step.name === "lookup")!.detail ?? "", new RegExp(`^template ${templateId}, prepared `));
  assert.deepEqual(vm2.preparation, { source: "template", templateId, setupBlob: vm.preparation!.setupBlob });
  assert.deepEqual(hookStatus(second), { "pre-setup": "skipped", setup: "skipped", "pre-resume": "ok", resume: "ok" });
  await firstTurn(second);
  const hooks2 = (await bash(second, "cat ~/ca-hooks.log")).split("\n");
  assert.equal(hooks2.filter(line => line === "setup as agent in /workspace").length, 1, `setup ran once, in the build machine: ${hooks2.join(" | ")}`);
  assert.equal(hooks2.filter(line => line === "pre-setup as agent").length, 1, hooks2.join(" | "));
  assert.equal(hooks2.filter(line => line.startsWith("resume ")).length, 1, "its own resume");
  const secondMs = Date.now() - secondBooting;
  await archive(second);
  note(`second thread, from the pool: from template ${templateId}, setup skipped, ready and archived in ${(secondMs / 1000).toFixed(1)} s: ${steps2.join(", ")}`);

  // C-5: a changed .agents/setup: the third thread runs setup itself and the template is removed.
  fs.writeFileSync(path.join(seed, ".agents", "setup"), "#!/bin/bash\necho \"setup v2 as $(id -un)\" >> ~/ca-hooks.log\n", { mode: 0o755 });
  git(seed, "commit", "-qam", "setup v2");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const v2 = git(seed, "rev-parse", "HEAD");
  await api(`/api/projects/${project.id}/check`, "POST", {});
  await until("the project sees the new commit", 60000, () => app.registry.getProject(project.id)!.repositories[0]!.baseOid === v2);
  const third = (await threads.spawn({ project: "ca", task: "a new setup", runner: node }, "req-vm-3")).id;
  await waitReady(third, "the third thread's machine is ready");
  const vm3 = app.registry.getThread(third)!.vm!;
  assert.deepEqual([vm3.preparation?.source, vm3.preparation?.templateId], ["template", templateId], "the key has no commit: the template is found");
  assert.deepEqual(hookStatus(third), { "pre-setup": "ok", setup: "ok", "pre-resume": "ok", resume: "ok" }, "its setup differs: pre-setup and setup ran here");
  await firstTurn(third);
  assert.ok((await bash(third, "cat ~/ca-hooks.log")).split("\n").includes("setup v2 as agent"));
  const afterInvalidation = await runnerSession(app.registry.getRunner(node)!).call({ case: "templateList", value: {} });
  assert.ok(afterInvalidation.case === "templates");
  const stale = afterInvalidation.value.items.find(item => item.id === templateId);
  assert.ok(!stale || stale.state === Template_State.REMOVING, `the template is removed: ${JSON.stringify(afterInvalidation.value.items.map(item => [item.id, item.state, item.users]))}`);
  await archive(third);
  note(`third thread at ${v2.slice(0, 8)} (a new .agents/setup): pre-setup and setup ran in its machine; template ${templateId} ${stale ? `removing (users ${stale.users})` : "gone"}`);

  // berth restarts: the thread's machine boots again with its resume hooks
  const bootBefore = (await bash(id, "cat /proc/sys/kernel/random/boot_id")).trim();
  assert.match(bootBefore, /^[0-9a-f-]{36}$/);
  await stop(runner.child);
  runner = await start(false);
  note("berth vm restarted on the same address");
  const bootRestarted = await until("the thread's machine runs again after berth's restart", 600000, async () => {
    void app.conversations.activate(id).catch(() => {});
    const answer = await bash(id, "cat /proc/sys/kernel/random/boot_id", 60000).catch(() => "");
    return /^[0-9a-f-]{36}$/.test(answer) && answer !== bootBefore ? answer : undefined;
  });
  const hooks = (await bash(id, "cat ~/ca-hooks.log")).split("\n");
  assert.equal(hooks.filter(line => line.startsWith("pre-resume ")).length, 2, hooks.join("\n"));
  assert.equal(hooks.filter(line => line.startsWith("resume ")).length, 2, hooks.join("\n"));
  assert.equal(await bash(id, "cat ca.txt"), "ca", "the disk was kept across the restart");
  // The agent's status after this boot's machine_setup: this boot, and pre-setup's outcome from the preparation.
  const restartedBundle = (await api(`/api/threads/${id}/diagnostics`)).diagnostics as Record<string, any>;
  const agent = restartedBundle.machine.guest.agent;
  assert.equal(agent.bootId, bootRestarted, JSON.stringify(agent));
  assert.equal(agent.hooks["pre-setup"], "skipped", JSON.stringify(agent));
  assert.match(formatDiagnostics(restartedBundle), new RegExp(`\\nguest agent: .*boot ${bootRestarted}; hooks at its last status: .*pre-setup skipped`));
  note(`keel agent after berth's restart: ${JSON.stringify(agent)}`);
  // K-2b: berth's restart closed the connection (logged with its reason) and the new one has its own line.
  const connectedAfter = sessionLog("runner connected");
  const disconnected = sessionLog("runner disconnected");
  assert.ok(connectedAfter.length > connectedBefore.length, sessionLines.join(""));
  assert.ok(disconnected.some(line => line.connection === connectedBefore.at(-1)!.connection && /^\d+$/.test(line.durationMs ?? "")), sessionLines.join(""));
  const latest = connectedAfter.at(-1)!;
  assert.deepEqual([latest.kind, /^(127\.0\.0\.1|\[::1\]):\d+$/.test(latest.remote ?? ""), /^\d+$/.test(latest.rttMs ?? "")], ["direct", true, true], JSON.stringify(latest));
  note(`cubed's path lines after berth's restart: closed ${JSON.stringify(disconnected.at(-1))}; new ${JSON.stringify(latest)}`);
  note("after berth's restart the machine booted again, ran pre-resume and resume, and kept its disk");

  // the stop deadline: a guest that cannot answer (QMP stop pauses it) makes
  // berth wait its whole SHUTDOWN_WAIT (30 s) before it quits QEMU; cubed's
  // machine_stop through its own session still gets the answer
  await qmp(path.join(directory, vm.vmId, "qmp.sock"), "stop");
  const session = runnerSession(app.registry.getRunner(node)!);
  const stopping = Date.now();
  const stopped = await session.machine({ case: "machineStop", value: { ref: { owner: id, id: vm.vmId },
    fence: { epoch: BigInt(Math.max(1, currentMachineEpoch(path.join(state, "threads", id, "vm")))) } } });
  const stopMs = Date.now() - stopping;
  assert.equal(stopped.status?.phase, MachineStatus_Phase.STOPPED);
  const forced = JSON.parse(fs.readFileSync(path.join(directory, vm.vmId, "machine.json"), "utf8")) as { stopped?: { kind: string } };
  assert.equal(forced.stopped?.kind, "forced");
  assert.ok(stopMs >= 30000 && stopMs < STOP_TIMEOUT_MS, `a forced machine_stop answered in ${stopMs} ms`);
  note(`forced stop through cubed's session answered in ${(stopMs / 1000).toFixed(1)} s (deadline ${STOP_TIMEOUT_MS / 1000} s; 15 s would have given up)`);
  const bootStopped = (await until("the thread's machine runs again after the forced stop", 600000, async () => {
    void app.conversations.activate(id).catch(() => {});
    const answer = await bash(id, "cat /proc/sys/kernel/random/boot_id", 60000).catch(() => "");
    return /^[0-9a-f-]{36}$/.test(answer) && answer !== bootRestarted ? answer : undefined;
  }));
  note(`started again after the forced stop: boot ${bootStopped.slice(0, 8)}`);

  // archive: dirty, so the disk is retained; berth stops the machine within the deadline
  await bash(id, "echo dirty > uncommitted.txt");
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
  // cubed closes while a thread's command runs in its machine (G1): the
  // close is bounded, the machine goes on, and the reopened cubed reattaches
  // the command (its effect once, its own result) and finishes the turn.
  {
    const run = `ca-${++requests}`;
    await api(`/api/threads/${second}/prompt`, "POST", { text: `tool ${JSON.stringify({ name: "bash", args: { command: "sleep 20; printf once >> ca-reattach; printf reattached", timeoutMs: 120000 } })}`, requestId: run });
    await until("the command runs in the machine", 120000, async () => (await api(`/api/threads/${second}/history`)).events.some((event: { type: string; name?: string }) => event.type === "tool-call"));
    await delay(3000);
    const closing = Date.now();
    app.server.closeAllConnections();
    await app.close();
    const closeMs = Date.now() - closing;
    assert.ok(closeMs < CLOSE_MS, `cubed closed within its bound (${closeMs} ms)`);
    app = await openCubed();
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    const history = await until(`run ${run} after the reopen`, 300000, async () => {
      const value = await api(`/api/threads/${second}/history`);
      return value.status?.run === run && !["working", "idle"].includes(value.status.state) ? value : undefined;
    });
    assert.equal(history.status.state, "completed", JSON.stringify(history.status));
    const results = history.events.filter((event: { type: string }) => event.type === "tool-result") as Array<{ output?: string; isError?: boolean }>;
    assert.ok(results.some(result => !result.isError && result.output?.includes("reattached")), `the command was reattached: ${JSON.stringify(results.slice(-2))}`);
    assert.equal(await bash(second, "cat ca-reattach"), "once", "its effect happened once");
    note(`cubed closed in ${(closeMs / 1000).toFixed(1)} s mid-command; reopened, the command was reattached, its effect once`);
  }
  console.log("ok: cubed with berth vm: by name and from the pool, a template built in the first thread's slot and used by the next, invalidated by a changed setup, "
    + "boot documents and policy, checkout and hooks, a tool call, push through the credential stream, "
    + "the portal over dial, berth's diagnosis, a berth restart with resume hooks, a forced stop within the deadline, archive retained, discard, "
    + "a cubed close mid-command within its bound and the command reattached after it");
} finally {
  app.server.closeAllConnections();
  await app.close();
  await stop(runner.child);
  github.close();
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  if (env.CUBE_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
  else note(`kept ${root}`);
}
