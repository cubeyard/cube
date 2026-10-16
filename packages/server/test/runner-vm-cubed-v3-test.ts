/** V3 through cubed on a real `berth vm` (A-1b): cubed, its supervised
 * cube-gateway (the protocol-4 credential proxy) and the guest's cube-agent
 * are each killed while a thread's command runs; the command takes effect
 * once and its result comes back by the same key.
 *
 * cubed is a child process here (e2e-fixture.ts: the real product server,
 * a faux model scripted by `tool {…}` prompts, the test-hooks cube-gateway),
 * as in scripts/test-vm-e2e.ts, so it can be SIGKILLed and started again on
 * the same state and port. berth vm is enrolled into that state before
 * cubed starts and is the whole pool; one project (the fake GitHub's
 * repository), one thread on the pool, then in order:
 *
 *   (a) cubed SIGKILLed mid-command: the gateway follows its lifeline, a new
 *       cubed on the same state and port reattaches to the same guest
 *       operation (the machine is not rebooted), the command ran once and
 *       its result came back by the key;
 *   (b) the supervised cube-gateway SIGKILLed mid-push of a 200 MiB blob
 *       through berth's credential stream: either the push happened once or
 *       it was refused by the credential route and the ref did not move,
 *       never two; the gateway is restarted and a fresh push succeeds;
 *   (c) the command ends the guest's own cube-agent: the agent comes back
 *       (a new session, the same boot), adopts the running command, which
 *       ran once, and its result came back by the key.
 *
 * Each command writes host-comparable timestamps (`date +%s%3N`): `start`
 * before the kill and `done` after the replacement is back prove the kill
 * fell inside the command. A result cubed reports as unknown
 * (COMPLETION_UNKNOWN, completionUnknown) fails the scenario, quoted: it
 * is a product finding, not a harness problem.
 *
 *   node packages/server/test/runner-vm-cubed-v3-test.ts target/debug/berth
 *
 * The environment is runner-vm-cubed-test.ts's: CUBE_TEST_BERTH_QEMU,
 * CUBE_TEST_BERTH_QEMU_IMG, CUBE_TEST_BERTH_KEEL, CUBE_TEST_BERTH_IMAGE,
 * CUBE_TEST_BERTH_MKFS, CUBE_TEST_BERTH_ACCEL, CUBE_TEST_BERTH_PULLED,
 * CUBE_TEST_BERTH_GATEWAY and CUBE_TEST_BERTH_TMP; without them it is skipped
 * with a notice, and CUBE_TEST_BERTH_VM=required makes that a failure.
 * CUBE_TEST_KEEP=1 keeps its root (cubed.log, berth.log). Loopback only;
 * nothing outside its temporary directory. Mocks are not runner acceptance;
 * this is not one. */
import assert from "node:assert/strict";
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fakeGithub, git } from "../../../scripts/fake-github.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const started = Date.now();
const note = (line: string) => console.log(`runner-vm-cubed-v3-test [${((Date.now() - started) / 1000).toFixed(1)}s]: ${line}`);

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
  console.error(`\nSKIP: cubed V3 with berth vm did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cv3-")));
const directory = path.join(root, "m");
const state = path.join(root, "state");
const node = "node-vm-cubed-v3";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };

// ---------------------------------------------------------------- berth vm

const berth = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
  "--accel", accel, "--image", image, "--listen", "127.0.0.1:0", "--allow-peer", control.peerId, "--node-id", node],
// Its own process group, as in a terminal: a Ctrl-C reaches the whole group.
{ stdio: ["ignore", "ignore", "pipe"], detached: true });
if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
const banner = await (async () => {
  let text = "";
  berth.stderr!.setEncoding("utf8");
  const log = fs.createWriteStream(path.join(root, "berth.log"), { flags: "a" });
  berth.stderr!.on("data", chunk => log.write(chunk));
  await new Promise<void>((resolve, reject) => {
    berth.stderr!.on("data", chunk => { text += chunk; if (text.includes("waiting for cubed")) resolve(); });
    berth.once("exit", code => reject(new Error(`berth vm exited (${code}): ${text}`)));
  });
  return text;
})();
const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
note(banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|listen):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 9 },
  controlKey, serverPeer: field("peer"), network: "loopback", address: field("listen").split(", ")[0]! }), { mode: 0o600 });

// ---------------------------------------------------------------- the fake GitHub

const token = `ghs_v3${randomBytes(12).toString("hex")}`;
const github = await fakeGithub({ dir: path.join(root, "github"), token });
const upstream = "https://github.com/cube-e2e/repo.git";
// cubed's host side resolves the repository from the fake's directory; the
// guest reaches the fake only through berth, the credential stream and the
// gateway's test upstream.
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(gitconfig, `[url "file://${path.join(root, "github", "cube-e2e")}/"]\n\tinsteadOf = https://github.com/cube-e2e/\n`);
const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY || (() => {
  execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks"],
    { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
  return path.join(repo, "target/test-hooks/debug/cube-gateway");
})();

// ---------------------------------------------------------------- cubed, a child process

type Cubed = { child: ChildProcess; url: string; port: number; provider: string; model: string };
fs.mkdirSync(path.join(root, "home"), { mode: 0o700 });
const fixtureEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "home", "pi"),
  GIT_CONFIG_GLOBAL: gitconfig, CUBED_GATEWAY: gatewayBin, CUBED_GITHUB_TOKEN: token,
  CUBED_VM_VCPUS: "2", CUBED_VM_MEMORY_MIB: "2048", CUBED_VM_DISK_GIB: "16",
  CUBED_GATEWAY_TEST_ARGS: JSON.stringify(["--test-upstream", `github.com=127.0.0.1:${github.port}`,
    "--test-upstream", `api.github.com=127.0.0.1:${github.port}`, "--test-upstream-ca", github.ca]) };
const cubedLog = path.join(root, "cubed.log");
async function startCubed(port = 0): Promise<Cubed> {
  const child = fork(path.join(repo, "packages/server/test/e2e-fixture.ts"), [state], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...fixtureEnv, CUBE_FIXTURE_PORT: String(port) } });
  const output = fs.createWriteStream(cubedLog, { flags: "a" });
  child.stdout!.pipe(output); child.stderr!.pipe(output);
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once("message", message => resolve(message as Record<string, unknown>));
    child.once("exit", code => reject(new Error(`cubed exited (${code}) before ready; see ${cubedLog}`)));
  });
  return { child, url: String(ready.url), port: Number(ready.port), provider: String(ready.provider), model: String(ready.model) };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
const gatewayPids = () => { try { return execFileSync("pgrep", ["-f", `serve --state ${path.join(state, "gateway")}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

let cubed: Cubed | undefined;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${cubed!.url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
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
type ThreadEvent = { type: string; text?: string; name?: string; input?: unknown };
type History = { status?: { run?: string; state?: string }; events: ThreadEvent[] };
const history = (id: string) => api(`/api/threads/${id}/history`) as Promise<History>;
const settled = (id: string, run: string, ms = 300000) => until(`run ${run}`, ms, async () => {
  const value = await history(id);
  return value.status?.run === run && !["working", "idle"].includes(value.status.state ?? "") ? value : undefined;
});
const lastText = (value: History) => [...value.events].reverse().find(event => event.type === "assistant-text")?.text ?? "";
const tool = (command: string, timeoutMs: number) => `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs } })}`;
let requests = 0;
async function bash(id: string, command: string, ms = 300000): Promise<string> {
  const run = `v3-read-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text: tool(command, Math.min(ms, 600000)), requestId: run });
  const value = await settled(id, run, ms + 30000);
  assert.equal(value.status!.state, "completed", JSON.stringify(value.status));
  const answer = lastText(value);
  assert.match(answer, /^result: /, answer);
  return answer.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}
const now = () => Date.now();
/** The guest command under test: its timestamps, one effect, its marker. */
const marked = (n: string, middle: string, effect = `echo once >> effect-${n}`) =>
  `echo "start $(date +%s%3N)" >> v3-${n}.log; ${middle}; echo "done $(date +%s%3N)" >> v3-${n}.log; ${effect}; echo finished-${n}`;
/** Waits for the tool call carrying the command (not the prompt that asks for it). */
const toolCallSeen = (id: string, marker: string) => until(`the tool call with ${marker}`, 120000, async () =>
  (await history(id)).events.some(event => event.type === "tool-call" && event.name === "bash" && JSON.stringify(event.input ?? {}).includes(marker)));
/** The honesty rule: an unknown outcome fails the scenario, quoted verbatim (F-A1b-1). */
function assertKnown(what: string, value: History): void {
  const unknown = [...value.events.map(event => JSON.stringify(event)), JSON.stringify(value.status)]
    .filter(text => /command outcome is unknown|COMPLETION_UNKNOWN|"completionUnknown":true/.test(text));
  assert.equal(unknown.length, 0, `${what}: the product reported the outcome as unknown (a product finding, F-A1b-1), verbatim:\n${unknown.join("\n")}`);
}
type Readback = { starts: number[]; dones: number[]; kills: number[]; effects: number; raw: string };
async function readBack(id: string, n: string): Promise<Readback> {
  const raw = await bash(id, `cat v3-${n}.log; echo ---; cat effect-${n} 2>/dev/null || true`);
  const [log = "", effect = ""] = raw.split("---");
  const stamps = (kind: string) => log.split("\n").filter(line => line.startsWith(`${kind} `)).map(line => Number(line.slice(kind.length + 1)));
  return { starts: stamps("start"), dones: stamps("done"), kills: stamps("kill"), effects: effect.split("\n").filter(line => line === "once").length, raw };
}
/** The common assertions of a scenario: settled completed by the same key with its marker, ran once, the kill inside the command. */
async function verify(id: string, n: string, run: string, tKill: number, tBack: number, options: { effects?: number; doneAfterBack?: boolean; killInside?: boolean } = {}) {
  const value = await settled(id, run, 300000);
  assertKnown(`scenario (${n})`, value);
  assert.equal(value.status!.state, "completed", `scenario (${n}): the run ${run} settled ${JSON.stringify(value.status)}; last text ${JSON.stringify(lastText(value))}`);
  const answer = lastText(value);
  assert.ok(answer.startsWith("result: ") && answer.includes(`finished-${n}`) && answer.includes("[exit=0; exited]"),
    `scenario (${n}): the result by the key: ${JSON.stringify(answer)}`);
  const back = await readBack(id, n);
  assert.equal(back.starts.length, 1, `scenario (${n}): the command started once: ${JSON.stringify(back.raw)}`);
  assert.equal(back.dones.length, 1, `scenario (${n}): the command finished once: ${JSON.stringify(back.raw)}`);
  assert.equal(back.effects, options.effects ?? 1, `scenario (${n}): exactly ${options.effects ?? 1} effect line(s): ${JSON.stringify(back.raw)}`);
  const [start, done] = [back.starts[0]!, back.dones[0]!];
  // (c) kills from inside the command: its `kill` line may share the `start` line's millisecond.
  assert.ok(options.killInside ? start <= tKill : start < tKill, `scenario (${n}): kill before the command started (start ${start}, kill ${tKill}): V3 not exercised`);
  assert.ok(done > tKill, `scenario (${n}): the command was over before the kill (done ${done}, kill ${tKill}): V3 not exercised`);
  if (options.doneAfterBack ?? true) assert.ok(done > tBack, `scenario (${n}): the command was over before the replacement was back (done ${done}, back ${tBack})`);
  return { value, back, start, done, answer };
}
type Diagnostics = { machine: { runner: { status: string; diagnosis?: { guest?: { info?: { session?: string; ready?: boolean; bootId?: string } | null } } }; guest: { status: string; agent?: { bootId: string } } } };
const diagnose = async (id: string) => (await api(`/api/threads/${id}/diagnostics`)).diagnostics as Diagnostics;
/** The guest's boot and its agent's session, as cubed's diagnosis shows them (berth's document). */
async function guestNow(id: string): Promise<{ bootId: string; session: string; ready: boolean } | undefined> {
  const diagnostics = await diagnose(id).catch(() => undefined);
  const info = diagnostics?.machine.runner.diagnosis?.guest?.info;
  const bootId = diagnostics?.machine.guest.agent?.bootId ?? "";
  return info?.session && bootId ? { bootId, session: info.session, ready: !!info.ready } : undefined;
}

let failed = true;
try {
  // enrollment: berth vm into this test's state before cubed starts; it is the pool
  fs.mkdirSync(state, { mode: 0o700 });
  const enrolled = JSON.parse(execFileSync(process.execPath, [path.join(repo, "scripts/enroll-runner.ts"), "--state", state, "--config", configPath, "--trusted-runner"],
    { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig } })) as { profile: string; admitted: boolean; maxActiveVms: number };
  assert.deepEqual([enrolled.profile, enrolled.admitted], ["vm-runner", true], JSON.stringify(enrolled));
  cubed = await startCubed();
  note(`berth vm enrolled before cubed started (${enrolled.maxActiveVms} slots); cubed ${cubed.url} (pid ${cubed.child.pid})`);

  // one project, one thread on the pool, the machine ready
  await api("/api/onboarding", "POST", {});
  const project = (await api("/api/projects", "POST", { name: "v3", repositories: [{ url: upstream, base: "main" }] })).project as { id: string };
  const projectReady = await until("the project is ready", 60000, async () => {
    const row = (await api("/api/projects")).projects.find((p: { id: string }) => p.id === project.id) as { status: string; error: string | null };
    return row.status !== "checking" ? row : undefined;
  });
  assert.equal(projectReady.status, "ready", projectReady.error ?? "");
  const booting = now();
  const id = (await api("/api/threads", "POST", { projectId: project.id, requestId: "v3", text: "hello", model: { provider: cubed.provider, id: cubed.model } })).id as string;
  const row = await until("the thread's machine is ready", 900000, async () => {
    const current = (await api("/api/threads")).threads.find((t: { id: string }) => t.id === id) as { state: string; error: string | null; workspaceState: string; runnerId?: string };
    return current && current.state !== "starting" ? current : undefined;
  });
  assert.equal(row.state, "ready", row.error ?? JSON.stringify(row));
  assert.equal((await settled(id, "cube:initial")).status!.state, "completed");
  note(`thread ${id.slice(0, 8)} on the pool, ready in ${((now() - booting) / 1000).toFixed(1)} s`);

  // ---------------------------------------------------------------- (a) cubed killed mid-command
  const bootA = await until("the guest's boot before (a)", 60000, () => guestNow(id));
  await api(`/api/threads/${id}/prompt`, "POST", { text: tool(marked("a", "sleep 20"), 120000), requestId: "v3-cubed" });
  await toolCallSeen(id, "v3-a.log");
  await delay(3000);
  const tKillA = now();
  const oldCubed = cubed.child.pid;
  await kill(cubed.child);
  await until("the old gateway to exit with cubed's lifeline", 30000, () => gatewayPids().length === 0);
  cubed = await startCubed(cubed.port);
  const tBackA = now();
  note(`(a) cubed ${oldCubed} SIGKILLed; its gateway followed; cubed ${cubed.child.pid} on the same state and port ${cubed.port}`);
  const a = await verify(id, "a", "v3-cubed", tKillA, tBackA);
  const bootAfterA = await until("the guest's boot after (a)", 120000, () => guestNow(id));
  assert.equal(bootAfterA.bootId, bootA.bootId, `scenario (a): the machine was rebooted, not re-attached (boot ${bootA.bootId} -> ${bootAfterA.bootId})`);
  note(`(a) start ${a.start} < kill ${tKillA} < back ${tBackA} < done ${a.done}; completed by the key: ${JSON.stringify(a.answer)}; one effect; boot ${bootA.bootId} kept (re-attached)`);

  // ---------------------------------------------------------------- (b) the proxy killed mid-push
  const before = git(github.repository, "rev-parse", "main");
  const prepared = await bash(id, "set -e; git push -q origin HEAD:refs/heads/v3-push; head -c 209715200 /dev/urandom > v3-b.bin; git add v3-b.bin; "
    + "git -c user.name=v3 -c user.email=v3@example.invalid commit -qm v3-b; git rev-parse HEAD^ HEAD", 600000);
  const [baseB, commitB] = prepared.split("\n").slice(-2) as [string, string];
  assert.equal(git(github.repository, "rev-parse", "v3-push"), baseB, `the branch starts at ${baseB} (main was ${before})`);
  const receivesBefore = github.seen.filter(seen => seen.path.endsWith("/git-receive-pack")).length;
  await api(`/api/threads/${id}/prompt`, "POST", { text: tool(marked("b", "git push origin HEAD:refs/heads/v3-push > v3-b.push 2>&1; rc=$?",
    "[ $rc = 0 ] && echo once >> effect-b; cat v3-b.push; echo \"push-rc $rc\""), 600000), requestId: "v3-proxy" });
  await toolCallSeen(id, "v3-b.log");
  await delay(2000);
  const proxies = gatewayPids();
  assert.equal(proxies.length, 1, `one supervised gateway: ${proxies.join(", ")}`);
  const tKillB = now();
  process.kill(Number(proxies[0]), "SIGKILL");
  const newProxy = await until("a new gateway pid and /api/health gateway ready", 60000, async () => {
    const pids = gatewayPids();
    return pids.length === 1 && pids[0] !== proxies[0] && (await api("/api/health")).gateway === "ready" ? pids[0] : undefined;
  });
  const tBackB = now();
  note(`(b) gateway ${proxies[0]} SIGKILLed mid-push; gateway ${newProxy} ready`);
  const settledB = await settled(id, "v3-proxy", 900000);
  const pushRc = Number(lastText(settledB).match(/push-rc (\d+)/)?.[1] ?? NaN);
  const pushedOnce = pushRc === 0;
  const b = await verify(id, "b", "v3-proxy", tKillB, tBackB, { effects: pushedOnce ? 1 : 0, doneAfterBack: pushedOnce });
  const remote = git(github.repository, "rev-parse", "v3-push");
  const seenFromGuest = (await bash(id, "git ls-remote origin refs/heads/v3-push | cut -f1")).split("\n").at(-1);
  const receives = github.seen.filter(seen => seen.path.endsWith("/git-receive-pack")).length - receivesBefore;
  if (pushedOnce) {
    assert.equal(remote, commitB, "scenario (b): the push reached the fake GitHub");
    assert.equal(git(github.repository, "rev-parse", "v3-push^"), baseB, "scenario (b): the ref advanced by exactly one commit");
    assert.equal(seenFromGuest, commitB, "scenario (b): the guest's ls-remote shows the pushed commit");
  } else {
    assert.match(b.answer, /credential_proxy|the credential proxy is not running|does not answer/, `scenario (b): the push failed (rc ${pushRc}) without the credential refusal: ${JSON.stringify(b.answer)}`);
    assert.equal(remote, baseB, "scenario (b): a refused push left the ref where it was");
    assert.equal(seenFromGuest, baseB, "scenario (b): the guest's ls-remote shows the ref unmoved");
  }
  note(`(b) start ${b.start} < kill ${tKillB} < done ${b.done} (back ${tBackB}); outcome: ${pushedOnce ? `pushed once (${baseB.slice(0, 8)} -> ${commitB.slice(0, 8)})` : `refused (rc ${pushRc}), ref unmoved at ${baseB.slice(0, 8)}`}; `
    + `${receives} receive-pack request(s) at the fake; push output: ${JSON.stringify(b.answer)}`);
  const fresh = await bash(id, "set -e; head -c 1048576 /dev/urandom > v3-b2.bin; git add v3-b2.bin; git -c user.name=v3 -c user.email=v3@example.invalid commit -qm v3-b2; "
    + "git push -q origin HEAD:refs/heads/v3-push-2; git rev-parse HEAD", 300000);
  assert.equal(git(github.repository, "rev-parse", "v3-push-2"), fresh.split("\n").at(-1), "scenario (b): a fresh push after the restart");
  assert.equal((await api("/api/health")).gateway, "ready");
  note(`(b) a fresh push after the restart reached the fake GitHub (${fresh.split("\n").at(-1)!.slice(0, 8)})`);

  // ---------------------------------------------------------------- (c) the agent killed mid-command
  // The main agent is the cube-agent in the root cgroup (as runner-vm-test.ts's endAgent); /proc and bash's kill only.
  const endAgent = "for p in /proc/[0-9]*; do [ \"$(cat $p/comm 2>/dev/null)\" = cube-agent ] && [ \"$(cat $p/cgroup 2>/dev/null)\" = 0::/ ] && sudo bash -c \"kill ${p#/proc/}\"; done; sleep 1";
  const guestC = await until("the guest's session before (c)", 60000, async () => { const g = await guestNow(id); return g?.ready ? g : undefined; });
  await api(`/api/threads/${id}/prompt`, "POST", { text: tool(marked("c", `echo "kill $(date +%s%3N)" >> v3-c.log; ${endAgent}; sleep 15`), 120000), requestId: "v3-agent" });
  const renewed = await until("the agent back: a new session, ready", 120000, async () => {
    const g = await guestNow(id);
    return g && g.session !== guestC.session && g.ready ? g : undefined;
  });
  const tBackC = now();
  assert.equal(renewed.bootId, guestC.bootId, `scenario (c): the machine was rebooted (boot ${guestC.bootId} -> ${renewed.bootId}), not the agent restarted`);
  const settledC = await settled(id, "v3-agent", 300000);
  assertKnown("scenario (c)", settledC);
  const tKillC = (await readBack(id, "c")).kills[0] ?? NaN;
  assert.ok(Number.isFinite(tKillC), "scenario (c): the command logged its kill");
  const c = await verify(id, "c", "v3-agent", tKillC, tBackC, { killInside: true });
  assert.ok(tKillC < tBackC, `scenario (c): the agent came back (${tBackC}) after the kill (${tKillC})`);
  note(`(c) start ${c.start} <= kill ${tKillC} < back ${tBackC} < done ${c.done}; agent session ${guestC.session} -> ${renewed.session}, boot ${renewed.bootId} kept; `
    + `adopted, not restarted (one start line); completed by the key: ${JSON.stringify(c.answer)}`);

  // archive (dirty: retained) and discard
  const vmId = (await api("/api/threads")).threads.find((t: { id: string }) => t.id === id).vm.vmId as string;
  let archived: { ok?: boolean; retained?: boolean; reason?: string } = {};
  for (let tries = 0; tries < 200 && !archived.ok; tries++) {
    archived = await (await fetch(`${cubed.url}/api/threads/${id}`, { method: "DELETE" })).json() as typeof archived;
    if (!archived.ok) await delay(500);
  }
  assert.equal(archived.retained, true, JSON.stringify(archived));
  await api(`/api/threads/${id}/discard`, "POST", {});
  await until("the machine's directory is gone", 30000, () => !fs.existsSync(path.join(directory, vmId)));
  note(`archived (retained: ${archived.reason}) and discarded`);
  console.log("ok: cubed V3 with berth vm: cubed killed mid-command (reattached, one effect, the result by key), the proxy killed mid-push "
    + "(one push or a refused one, never two; restarted), the agent killed mid-command (adopted, one effect, the result by key)");
  failed = false;
} finally {
  if (cubed) await kill(cubed.child, "SIGTERM");
  for (const pid of gatewayPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  if (berth.exitCode === null && berth.signalCode === null) {
    const exited = once(berth, "exit");
    process.kill(-berth.pid!, "SIGINT");
    await exited;
  }
  github.close();
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  if (env.CUBE_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
  else note(`kept ${root}`);
  if (failed) note(`failed; cubed.log and berth.log ${env.CUBE_TEST_KEEP === "1" ? `in ${root}` : "removed (CUBE_TEST_KEEP=1 keeps them)"}`);
}
