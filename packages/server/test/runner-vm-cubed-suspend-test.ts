/** P7-5's native gate (masterplan S-7a; review a647b211 §9, N1–N7): cubed's
 * real suspend, slot and wake code with a real `berth vm` and a keel machine
 * under QEMU. A fresh cubed in this process (createCubed with a new state, a
 * faux model, the real cube-gateway, ProtocolMachines and RunnerMachines)
 * and its real 30 s recovery loop; only the idle time is short
 * (CUBE_TEST_SUSPEND_IDLE_MS, default 60 s, instead of 5 min). berth vm has
 * one slot. Every `machine_suspend` and `machine_start` cubed sends is
 * counted where it leaves (RunnerSession.call), so "never asked" is seen, not
 * inferred from berth's answer.
 *
 *   N7  control first: berth vm without --suspend-disk-margin-gib (no
 *       `machine.suspend`): an idle thread is never asked (K-6). berth then
 *       restarts with the flag, so the same idle thread is the pair of
 *   N1  idle, only the loop runs: SUSPENDED within idle + 2 ticks + the
 *       save, its slot free in /api/projects, no QEMU left, the memory file
 *       on disk; across two more ticks the loop neither wakes nor asks again
 *       (B-207-1);
 *   N4  a message to the suspended thread wakes it before its run: the same
 *       boot, no resume hooks again;
 *   N2  `exec sleep` through cubed's guest for the thread as the agent's tool
 *       sends it (the agent's lease epoch), and no poll: not asked while it
 *       runs (K-5, also with no call open); once a `get` saw its end,
 *       suspended; then a guest call wakes it (the same boot);
 *   N3  the listener is the product's own, a `cube service` (keel kills what
 *       a command leaves behind and its commands see no cgroupfs, so a
 *       listener with no service and no command cannot be reached in keel).
 *       A dial and a registered service are told apart by the order cubed
 *       checks in (suspendIfIdle: idleMs before it asks the guest for its
 *       `services`), counted where the `services` call leaves cubed
 *       (RunnerSession.guestCall):
 *   N3a a `dial` to it held open: not asked, and cubed never asks for the
 *       machine's services;
 *   N3b the dial closed, the service still registered (the interim rule
 *       while the user decides N-207-8; it decides nothing): not asked, and
 *       cubed asks for its services at least once;
 *   N3c the service stopped: suspended;
 *   N3d a portal request wakes it within the portal's 60 s and is answered
 *       by the guest (404, no such service), the same boot; suspended again;
 *   N5  one slot: thread A suspended, thread B takes the slot and stays busy;
 *       a message to A shows "waiting for a free slot …", berth is not
 *       asked to resume A (the registry holds the slot for B) and A stays
 *       suspended; B archived, A resumes (the same boot) and its run ends;
 *   N6  berth restarted with A suspended and the snapshot's key changed as
 *       another berth would write it: the loop does not wake A across the
 *       reconnect; a message boots it cold (SnapshotDropped/version), the
 *       B7-5 notice, the resume hooks run, a new boot, the memory file gone.
 *
 *   node packages/server/test/runner-vm-cubed-suspend-test.ts target/debug/berth
 *
 * The environment is runner-vm-cubed-test.ts's (CUBE_TEST_BERTH_QEMU,
 * _QEMU_IMG, _KEEL, _IMAGE, _MKFS, _ACCEL, _PULLED, _GATEWAY, _TMP; skipped
 * without them, a failure with CUBE_TEST_BERTH_VM=required), and:
 * CUBE_TEST_SUSPEND_IDLE_MS (≥ 30000), CUBE_TEST_SUSPEND_MEMORY_MIB (the
 * guest's memory, 1024), CUBE_TEST_SUSPEND_DEADLINE_S (the whole run, 3000;
 * past it the run stops, cleans up and fails), CUBE_TEST_SUSPEND_MIN_FREE_GIB
 * (free space the run needs under CUBE_TEST_BERTH_TMP before it starts, 10)
 * and CUBE_TEST_EVIDENCE (a new or empty directory: the run's small logs and
 * its summary are copied there, passed or failed). A failed run keeps its
 * temporary directory; CUBE_TEST_KEEP=1 keeps it always. Loopback only;
 * nothing outside its temporary directory and CUBE_TEST_EVIDENCE.
 * `--suspend-disk-margin-gib 1` is a test value only (N-2 is the user's).
 * Under TCG the times say nothing; only KVM and HVF runs are the gate. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { fakeGithub, git } from "../../../scripts/fake-github.ts";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { portalSettings } from "../src/portal.ts";
import { enrollRunner } from "../src/runner-enroll.ts";
import { observeRunners } from "../src/runner-observe.ts";
import { RunnerSession } from "../src/runner-session.ts";
import { request } from "./portal-dial.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const began = Date.now();
const timeline: Array<{ s: number; line: string }> = [];
const note = (line: string) => {
  const s = Number(((Date.now() - began) / 1000).toFixed(1));
  timeline.push({ s, line });
  console.log(`runner-vm-cubed-suspend-test [${s}s]: ${line}`);
};

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
  console.error(`\nSKIP: cubed suspending and waking on berth vm (P7-5, N1–N7) did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

const IDLE_MS = Number(env.CUBE_TEST_SUSPEND_IDLE_MS ?? 60000);
assert.ok(Number.isSafeInteger(IDLE_MS) && IDLE_MS >= 30000, "CUBE_TEST_SUSPEND_IDLE_MS must be at least 30000");
/** cubed's recovery loop (index.ts): not changed by this test. */
const TICK_MS = 30000;
/** A machine that was going to be suspended has been asked by then. */
const QUIET_MS = IDLE_MS + 2 * TICK_MS + 15000;
/** A suspend that was due has ended by then: berth answers within 85 s. */
const SUSPEND_BY_MS = IDLE_MS + 2 * TICK_MS + 90000;
const memoryMib = Number(env.CUBE_TEST_SUSPEND_MEMORY_MIB ?? 1024);
const deadlineS = Number(env.CUBE_TEST_SUSPEND_DEADLINE_S ?? 3000);
const minFreeGib = Number(env.CUBE_TEST_SUSPEND_MIN_FREE_GIB ?? 10);
const evidence = env.CUBE_TEST_EVIDENCE ? path.resolve(env.CUBE_TEST_EVIDENCE) : "";
if (evidence) {
  fs.mkdirSync(evidence, { recursive: true });
  assert.equal(fs.readdirSync(evidence).length, 0, `CUBE_TEST_EVIDENCE ${evidence} must be new or empty`);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const tmp = env.CUBE_TEST_BERTH_TMP ?? "/tmp";
const space = fs.statfsSync(tmp);
const freeGib = (space.bavail * space.bsize) / 2 ** 30;
if (freeGib < minFreeGib) {
  console.error(`STOP: ${freeGib.toFixed(1)} GiB free under ${tmp}, below CUBE_TEST_SUSPEND_MIN_FREE_GIB ${minFreeGib}; nothing started`);
  process.exit(1);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "cvs-")));
const directory = path.join(root, "m");
const state = path.join(root, "state");
const node = "node-vm-cubed-suspend";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
/** Suspends that took more than one machine_suspend (berth refused one first). */
const extraAsks: Array<{ what: string; asks: number; refusals: string[] }> = [];
const summary: Record<string, unknown> = { accel, idleMs: IDLE_MS, tickMs: TICK_MS, memoryMib, freeGibAtStart: Number(freeGib.toFixed(1)), extraAsks };

// ---------------------------------------------------------------- what cubed sends

/** Every machine_suspend and machine_start cubed sends to this runner, as it
 * leaves, with how long its answer took and what it was (#208: berth answers
 * a suspend within 85 s, before cubed's 90 s). */
const sent: Array<{ at: number; verb: "machineSuspend" | "machineStart"; owner: string; ms?: number; outcome?: string }> = [];
let capabilities: string[] = [];
const call = RunnerSession.prototype.call;
const counted: typeof call = function (this: RunnerSession, verb, timeoutMs) {
  if (this.nodeId === node) capabilities = [...this.capabilities];
  const answer = call.call(this, verb, timeoutMs);
  if (this.nodeId === node && (verb.case === "machineSuspend" || verb.case === "machineStart")) {
    const entry: (typeof sent)[number] = { at: Date.now(), verb: verb.case, owner: verb.value.ref?.owner ?? "" };
    sent.push(entry);
    void answer.then(result => { entry.ms = Date.now() - entry.at; entry.outcome = result.case; },
      (error: { code?: string; reason?: string; message?: string }) => { entry.ms = Date.now() - entry.at; entry.outcome = `${error.code ?? "error"}/${error.reason ?? ""}: ${error.message ?? ""}`.slice(0, 300); });
  }
  return answer;
};
RunnerSession.prototype.call = counted;
const asked = (owner: string, verb: "machineSuspend" | "machineStart" = "machineSuspend", since = 0) =>
  sent.filter(entry => entry.owner === owner && entry.verb === verb && entry.at >= since).length;
/** Every `services` guest call cubed sends to this runner, as it leaves
 * (suspendIfIdle's, and the portal's, which N3a and N3b do not use). */
const servicesSent: Array<{ at: number; owner: string }> = [];
const sendGuest = RunnerSession.prototype.guestCall;
const countedGuest: typeof sendGuest = function (this: RunnerSession, ref, epoch, op, request, options) {
  if (this.nodeId === node && op === "services") servicesSent.push({ at: Date.now(), owner: ref.owner });
  return sendGuest.call(this, ref, epoch, op, request, options);
};
RunnerSession.prototype.guestCall = countedGuest;
const servicesAsked = (owner: string, since: number) =>
  servicesSent.filter(entry => entry.owner === owner && entry.at >= since).length;

// ---------------------------------------------------------------- berth vm

let listen = "127.0.0.1:0";
async function start(suspend: boolean, first: boolean): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--accel", accel, "--image", image, "--listen", listen, "--max-machines", "1",
    ...(suspend ? ["--suspend-disk-margin-gib", "1"] : []), ...(first ? ["--allow-peer", control.peerId, "--node-id", node] : [])],
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
  await Promise.race([exited, delay(60000)]);
  if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, "SIGKILL"); await exited; }
}
/** QEMU processes of a machine of this test ("" for any). */
function qemus(id: string): string {
  try { return execFileSync("pgrep", ["-f", path.join(directory, id)], { encoding: "utf8" }).trim(); } catch { return ""; }
}
/** berth's own record of a machine (events.log), one line each. */
const berthEvents = (vmId: string): string[] => {
  try { return fs.readFileSync(path.join(directory, vmId, "events.log"), "utf8").split("\n").filter(Boolean); } catch { return []; }
};
const memoryFile = (vmId: string) => path.join(directory, vmId, "memory");

if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
let runner = await start(false, true);
listen = runner.address;
note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|machines|suspend):/.test(line)).join(" | "));
assert.match(runner.banner, /^suspend: off/m, "N7 runs berth without --suspend-disk-margin-gib");
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 9 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });

// ---------------------------------------------------------------- the fake GitHub and the repository

const token = `ghs_cs${randomBytes(12).toString("hex")}`;
const github = await fakeGithub({ dir: path.join(root, "github"), token });
const seed = path.join(root, "seed");
git(root, "clone", "-q", github.repository, seed);
fs.mkdirSync(path.join(seed, ".agents"));
fs.writeFileSync(path.join(seed, ".agents", "setup"), "#!/bin/bash\necho \"setup $(cat /proc/sys/kernel/random/boot_id)\" >> ~/cs-hooks.log\n", { mode: 0o755 });
fs.writeFileSync(path.join(seed, ".agents", "resume"), "#!/bin/bash\necho \"resume $(cat /proc/sys/kernel/random/boot_id)\" >> ~/cs-hooks.log\n", { mode: 0o755 });
git(seed, "add", "-A");
git(seed, "commit", "-qm", "hooks");
git(seed, "push", "-q", "origin", "HEAD:main");
const upstream = "https://github.com/cube-e2e/repo.git";
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
process.env.CUBED_VM_MEMORY_MIB = String(memoryMib);
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
const app = await createCubed({ state, models, claude: null, gateway: gatewayBin, skillSource: null, suspendIdleMs: IDLE_MS,
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
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms: ${what}`);
    await delay(250);
  }
}
let requests = 0;
/** Sends a message; its run ends later (`ran`). */
async function send(id: string, line: string): Promise<string> {
  const run = `cs-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text: line, requestId: run });
  return run;
}
async function ran(id: string, run: string, ms = 300000, raw = false): Promise<string> {
  const history = await until(`run ${run}`, ms, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === run && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  assert.equal(history.status.state, "completed", JSON.stringify(history.status));
  const last = [...history.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text?: string } | undefined;
  const answer = last?.text ?? "";
  assert.match(answer, /^result: /, answer);
  if (raw) return answer.replace(/^result: /, "");
  return answer.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}
const bashLine = (command: string, ms = 120000) => `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs: ms } })}`;
/** One bash tool call by the thread's agent: its output. */
const bash = async (id: string, command: string, ms = 120000) => ran(id, await send(id, bashLine(command, ms)), ms + 120000);
/** A command that prepares a check, not one it measures: it must exit 0
 * and print `sentinel` as a line of its own, or the run stops there as the
 * harness's failure, with the command's output. Its output, without the
 * exit line. */
async function setup(id: string, what: string, command: string, sentinel: string): Promise<string> {
  const answer = await ran(id, await send(id, bashLine(command)), 240000, true);
  const exit = answer.match(/\n\[exit=(-?\d+); ([a-z]+)[^\]\n]*\]$/);
  const output = exit ? answer.slice(0, exit.index) : answer;
  if (!exit || exit[1] !== "0" || exit[2] !== "exited" || !output.split("\n").includes(sentinel)) {
    throw new Error(`STOP: harness setup: ${what}: ${answer}`);
  }
  note(`setup ${what}: ${output.replace(/\n/g, " | ")}`);
  return output;
}
const BOOT = "cat /proc/sys/kernel/random/boot_id";
const hookLines = (log: string, kind: string) => log.split("\n").filter(line => line.startsWith(`${kind} `));
const thread = (id: string) => app.registry.getThread(id)!;
const suspended = (id: string) => thread(id).vm?.suspension?.state === "suspended";
const listedThread = async (id: string) => ((await api("/api/threads")).threads as Array<{ id: string; vm?: { suspension?: { state: string; waiting?: string }; notice?: { text: string } }; waiting?: string | null }>).find(t => t.id === id)!;
const freeSlots = async () => ((await api("/api/projects")).projects as Array<{ availableSlotCount: number }>)[0]!.availableSlotCount;
/** The thread's lease epoch: Pi holds the lease for life, and the guest
 * refuses a mutation older than the newest epoch it saw. */
const agentEpoch = (id: string): number => {
  const db = new DatabaseSync(path.join(state, "threads", id, "lease.sqlite"), { readOnly: true });
  try { return Number((db.prepare("SELECT epoch FROM lease WHERE id = 1").get() as { epoch: number }).epoch); } finally { db.close(); }
};
/** One guest call through cubed's guest for the thread (RunnerMachines.guest:
 * counted as activity; it wakes a suspended machine first). */
async function guestCall(id: string, op: "exec" | "get", header: Record<string, unknown>) {
  const guest = app.machines!.guest(thread(id));
  try { return await guest.call(op, header, { timeoutMs: 60000 }); } finally { await guest.close().catch(() => {}); }
}
/** A command as the agent's tool sends it (its epoch), and nothing polls it. */
async function begin(id: string, command: string, timeoutMs: number): Promise<string> {
  const op = `ws-${randomBytes(32).toString("hex")}`;
  const answer = await guestCall(id, "exec", { id: op, epoch: agentEpoch(id), command, cwd: ".", timeoutMs, outputLimit: 4096 });
  assert.ok(["Accepted", "Running"].includes(String(answer.header.state)), `exec: ${JSON.stringify(answer.header)}`);
  return op;
}
/** Polls the command (`get`) until it ends: its output. */
async function end(id: string, op: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await guestCall(id, "get", { id: op, waitMs: 10000 });
    const now = String(answer.header.state);
    if (!["Accepted", "Running"].includes(now)) {
      const result = answer.header.result as { exitCode?: number } | undefined;
      assert.ok(now === "Succeeded" && result?.exitCode === 0, `get: ${JSON.stringify(answer.header)}`);
      return Buffer.from(answer.body ?? new Uint8Array()).toString("utf8").trim();
    }
    if (Date.now() > deadline) throw new Error(`the command ${op} did not end in ${ms} ms`);
  }
}

/** Neither asked nor suspended for `ms` (a suspend would have come by then). */
async function quiet(id: string, what: string, ms = QUIET_MS): Promise<void> {
  const before = asked(id);
  const events = berthEvents(thread(id).vm!.vmId).length;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.equal(asked(id), before, `${what}: cubed sent machine_suspend`);
    assert.ok(!suspended(id), `${what}: the thread's machine was suspended`);
    await delay(1000);
  }
  const later = berthEvents(thread(id).vm!.vmId).slice(events);
  assert.ok(!later.some(line => / suspend(ed| failed)?: /.test(line)), `${what}: berth saw a suspend: ${later.join(" | ")}`);
  note(`${what}: not asked for ${(ms / 1000).toFixed(0)} s (idle ${IDLE_MS / 1000} s + 2 ticks + 15 s)`);
}
/** Suspended by the loop, once: how long it took from `from`. */
async function suspendedBy(id: string, what: string, from: number): Promise<number> {
  const before = asked(id, "machineSuspend", from);
  await until(`${what}: suspended by the loop`, SUSPEND_BY_MS - (Date.now() - from), () => suspended(id));
  const ms = Date.now() - from;
  const vmId = thread(id).vm!.vmId;
  // More than one: berth refused one (its busy backstop) and the loop asked
  // again; recorded with cubed's reason, for the reviewer.
  const asks = asked(id, "machineSuspend", from) - before;
  assert.ok(asks >= 1, `${what}: cubed sent machine_suspend`);
  if (asks > 1) {
    const refusals = fs.readFileSync(path.join(state, "threads", id, "machine-events.jsonl"), "utf8").split("\n").filter(line => line.includes("\"not suspended\"")).slice(-(asks - 1));
    note(`${what}: NOTE ${asks} machine_suspend calls; cubed's refusals: ${refusals.join(" | ")}`);
    extraAsks.push({ what, asks, refusals });
  }
  await until(`${what}: no QEMU left`, 15000, () => qemus(vmId) === "");
  assert.ok(fs.existsSync(memoryFile(vmId)), `${what}: the memory file is on disk`);
  const line = berthEvents(vmId).filter(event => / suspended: /.test(event)).at(-1) ?? "";
  note(`${what}: suspended ${(ms / 1000).toFixed(1)} s after it went idle; berth: ${line}; memory ${thread(id).vm?.suspension?.memoryBytes ?? "?"} bytes`);
  return ms;
}
async function echo(socket: Duplex, line: string): Promise<void> {
  let got = "";
  const seen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no echo of ${line}: ${got}`)), 15000);
    const data = (chunk: Buffer) => { got += chunk.toString("utf8"); if (got.includes(line)) { clearTimeout(timer); socket.off("data", data); resolve(); } };
    socket.on("data", data);
  });
  socket.write(line);
  await seen;
}

let failed = false;
let tornDown = false;
async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  RunnerSession.prototype.call = call;
  RunnerSession.prototype.guestCall = sendGuest;
  try { app.server.closeAllConnections(); await Promise.race([app.close(), delay(60000)]); } catch (error) { console.error(`cubed close: ${String(error)}`); }
  await stop(runner.child).catch(() => {});
  github.close();
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  for (let i = 0; qemus("") && i < 50; i++) await delay(100);
  summary.processesLeft = qemus("");
  summary.failed = failed;
  summary.seconds = Math.round((Date.now() - began) / 1000);
  summary.sent = sent.map(entry => ({ ...entry, s: Math.round((entry.at - began) / 100) / 10 }));
  summary.servicesSent = servicesSent.map(entry => ({ ...entry, s: Math.round((entry.at - began) / 100) / 10 }));
  if (evidence) {
    // Small files only: logs and journals, not disks or memory files.
    const copy = (from: string, to: string) => {
      try {
        const size = fs.statSync(from).size;
        const limit = 8 * 2 ** 20;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (size <= limit) fs.copyFileSync(from, to);
        else { const fd = fs.openSync(from, "r"); const tail = Buffer.alloc(limit); fs.readSync(fd, tail, 0, limit, size - limit); fs.closeSync(fd); fs.writeFileSync(to, tail); }
      } catch { /* absent */ }
    };
    copy(path.join(root, "berth.log"), path.join(evidence, "berth.log"));
    for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      for (const name of ["events.log", "machine.json", "qemu.log", "console.log", "console.previous.log"]) copy(path.join(directory, entry, name), path.join(evidence, "machines", entry, name));
    }
    for (const entry of fs.existsSync(path.join(state, "threads")) ? fs.readdirSync(path.join(state, "threads")) : []) {
      for (const name of ["machine-events.prev.jsonl", "machine-events.jsonl"]) copy(path.join(state, "threads", entry, name), path.join(evidence, "threads", entry, name));
    }
    fs.writeFileSync(path.join(evidence, "timeline.jsonl"), timeline.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    fs.writeFileSync(path.join(evidence, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`evidence: ${evidence}`);
  }
  if (failed || env.CUBE_TEST_KEEP === "1") console.error(`kept for reading: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
const watchdog = setTimeout(() => {
  failed = true;
  console.error(`STOP: the run passed CUBE_TEST_SUSPEND_DEADLINE_S ${deadlineS}; cleaning up`);
  void teardown().finally(() => process.exit(2));
}, deadlineS * 1000);
watchdog.unref();

try {
  const enrolled = await enrollRunner({ state, configPath });
  assert.equal(enrolled.profile, "vm-runner");
  assert.equal(enrolled.maxActiveVms, 1, "berth vm has one slot (N5)");
  await api("/api/onboarding", "POST", {});
  const project = (await api("/api/projects", "POST", { name: "cs", repositories: [{ url: upstream, base: "main" }],
    hooks: { preResume: "echo \"pre-resume $(cat /proc/sys/kernel/random/boot_id)\" >> ~/cs-hooks.log" } })).project as { id: string };
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
  assert.ok(app.gateway, "cubed started its gateway");
  await app.gateway.ready();
  const waitReady = (id: string, what: string) => until(what, 900000, () => {
    const current = thread(id);
    if (current.workspaceState === "failed") throw new Error(`${what}: the machine failed: ${current.workspaceError}`);
    return current.workspaceState === "available";
  });
  const firstTurn = (id: string) => until("the first turn", 300000, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === "cube:initial" && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  const archive = async (id: string) => {
    let answer: { ok?: boolean; retained?: boolean; reason?: string } = {};
    for (let tries = 0; tries < 200 && !answer.ok; tries++) {
      answer = await (await fetch(`${url}/api/threads/${id}`, { method: "DELETE" })).json() as typeof answer;
      if (!answer.ok) await delay(500);
    }
    assert.ok(answer.ok, JSON.stringify(answer));
    return answer;
  };

  // Thread A, named to the runner (its template is built in its slot first).
  const a = (await threads.spawn({ project: "cs", task: "say hi", runner: node }, "req-a")).id;
  await waitReady(a, "thread A's machine is ready");
  await firstTurn(a);
  const vmA = thread(a).vm!.vmId;
  note(`thread A ready on ${vmA}: ${thread(a).vm!.steps!.map(step => `${step.name}:${step.state}`).join(", ")}`);

  // N7: no `machine.suspend`, never asked (K-6).
  await bash(a, "true");
  assert.ok(!capabilities.includes("machine.suspend"), `capabilities without the flag: ${capabilities.join(", ")}`);
  await quiet(a, "N7 (berth without --suspend-disk-margin-gib)");
  assert.equal(sent.filter(entry => entry.verb === "machineSuspend").length, 0, "N7: no machine_suspend at all");
  const n7Events = fs.readFileSync(path.join(state, "threads", a, "machine-events.jsonl"), "utf8");
  assert.ok(!/"not suspended"|"suspended"/.test(n7Events), "N7: cubed recorded no suspend outcome");
  summary.N7 = { asked: 0, capabilities };

  // berth again, now with the flag; the machine boots again (as after any berth restart).
  await stop(runner.child);
  runner = await start(true, false);
  assert.match(runner.banner, /^suspend: on/m);
  const boot = await until("thread A runs again on berth with suspend on", 600000, async () => {
    void app.conversations.activate(a).catch(() => {});
    const answer = await bash(a, BOOT, 60000).catch(() => "");
    return /^[0-9a-f-]{36}$/.test(answer) ? answer : undefined;
  });
  assert.ok(capabilities.includes("machine.suspend"), `capabilities with the flag: ${capabilities.join(", ")}`);
  const hooksAtBoot = await bash(a, "cat ~/cs-hooks.log");
  assert.equal(hookLines(hooksAtBoot, "resume").at(-1), `resume ${boot}`, "the resume hook ran for this boot");
  note(`N7 pair: berth restarted with --suspend-disk-margin-gib 1; thread A on boot ${boot}`);

  // N1: idle; only the loop runs.
  const slotsRunning = await freeSlots();
  assert.equal(slotsRunning, 0, "A holds the one slot");
  const n1 = await suspendedBy(a, "N1", Date.now());
  assert.equal(await freeSlots(), 1, "N1: a suspended machine holds no slot (B7-2)");
  assert.equal((await listedThread(a)).vm?.suspension?.state, "suspended", "N1: /api/threads shows it");
  const startsBefore = asked(a, "machineStart");
  const asksBefore = asked(a);
  await delay(2 * TICK_MS + 5000);
  assert.ok(suspended(a), "N1: the loop leaves it suspended");
  assert.equal(asked(a, "machineStart"), startsBefore, "N1: the loop sends no machine_start");
  assert.equal(asked(a), asksBefore, "N1: the loop does not ask again");
  summary.N1 = { suspendedAfterMs: n1, memoryBytes: thread(a).vm?.suspension?.memoryBytes ?? null };

  // N4: a message wakes it before the run; the same boot, no resume hooks.
  const n4From = Date.now();
  const n4 = (await bash(a, `${BOOT}; cat ~/cs-hooks.log`)).split("\n");
  const n4Ms = Date.now() - n4From;
  assert.equal(n4[0], boot, "N4: a resume is not a boot");
  assert.equal(hookLines(n4.slice(1).join("\n"), "resume").length, hookLines(hooksAtBoot, "resume").length, "N4: no resume hook on a resume");
  assert.equal(hookLines(n4.slice(1).join("\n"), "pre-resume").length, hookLines(hooksAtBoot, "pre-resume").length, "N4: no pre-resume hook on a resume");
  assert.ok(!suspended(a) && !thread(a).vm?.suspension, "N4: awake");
  assert.equal(thread(a).vm?.notice, undefined, "N4: no notice");
  assert.ok(berthEvents(vmA).some(line => / restore: loaded/.test(line)), "N4: berth restored from the snapshot");
  assert.ok(!fs.existsSync(memoryFile(vmA)), "N4: the memory file is deleted after the resume");
  note(`N4: the message's run woke A and ended in ${(n4Ms / 1000).toFixed(1)} s; same boot, no hooks`);
  summary.N4 = { runMs: n4Ms };

  // N2: a command through cubed's guest, as the agent's tool sends it, and no poll.
  const sleepS = Math.ceil((QUIET_MS + 10000) / 1000);
  const n2Op = await begin(a, `sleep ${sleepS}; echo n2-done`, (sleepS + 60) * 1000);
  const n2From = Date.now();
  await quiet(a, `N2 (exec sleep ${sleepS}, no poll, no call open)`, QUIET_MS);
  const n2Until = Date.now();
  // The loop's own check of a running machine (machineGet, then an idempotent machineStart) each tick; not a wake.
  const startsInWindow = sent.filter(entry => entry.owner === a && entry.verb === "machineStart" && entry.at >= n2From && entry.at <= n2Until)
    .map(entry => ({ s: Math.round((entry.at - began) / 100) / 10, ms: entry.ms, outcome: entry.outcome }));
  assert.equal(await end(a, n2Op, (sleepS + 60) * 1000), "n2-done", "N2: the command over the quiet window");
  assert.ok(Date.now() - n2From >= (sleepS - 5) * 1000, "N2: the command really ran its time");
  const n2 = await suspendedBy(a, "N2 (after a get saw the end)", Date.now());
  // A guest call wakes it (RunnerMachines.awake).
  assert.equal(await end(a, await begin(a, BOOT, 60000), 120000), boot, "N2: a guest call woke it, the same boot");
  assert.ok(!thread(a).vm?.suspension, "N2: awake");
  note("N2: a guest call woke it; the same boot");
  summary.N2 = { sleepS, suspendedAfterGetMs: n2, startsInWindow };

  // N3: the listener is a `cube service` (the product's own). A listener
  // with no service and no command cannot be reached in keel: a command's
  // processes are killed when it ends, it sees no cgroupfs to leave its
  // cgroup, and `cube service stop` kills the service's. So a dial and a
  // registered service are told apart by the order suspendIfIdle checks in:
  // idleMs (0 with a dial open) before it asks the guest for its `services`.
  const PORT = 18081;
  await setup(a, "N3 service start", [
    "command -v perl >/dev/null || { echo 'no perl'; exit 3; }",
    "cat > /tmp/cs-echo.pl <<'EOF'",
    "use IO::Socket::INET;",
    "$SIG{CHLD} = 'IGNORE';",
    `my $s = IO::Socket::INET->new(LocalAddr => '0.0.0.0', LocalPort => ${PORT}, Listen => 5, ReuseAddr => 1) or die "listen: $!";`,
    "while (my $c = $s->accept) { if (fork) { close $c; next } while (sysread($c, my $b, 4096)) { syswrite($c, $b) } exit 0 }",
    "EOF",
    `cube service start csecho --port ${PORT} --wait 15 --json -- "$(command -v perl)" /tmp/cs-echo.pl || exit $?`,
    "echo CS-STARTED",
  ].join("\n"), "CS-STARTED");
  const status = await setup(a, "N3 service status", "cube service status csecho --json || exit $?\necho CS-STATUS", "CS-STATUS");
  const view = JSON.parse(status.split("\n")[0]!) as { kind?: string; state?: string; listening?: boolean };
  if (view.kind !== "command" || view.state !== "active" || view.listening !== true) throw new Error(`STOP: harness setup: N3 service status: ${status}`);
  await setup(a, "N3 listening", `exec 3<>/dev/tcp/127.0.0.1/${PORT} && printf 'p\\n' >&3 && read -t 5 l <&3 && [ "$l" = p ] && echo "LISTENING ${PORT}"`, `LISTENING ${PORT}`);

  // N3a: a dial open: not asked, and cubed never asks for the services.
  const socket = await app.machines!.dial!(thread(a), PORT);
  await echo(socket, "n3-open\n");
  const n3aFrom = Date.now();
  await quiet(a, "N3a (a dial open, the service registered)");
  const n3aAsks = servicesAsked(a, n3aFrom);
  assert.equal(n3aAsks, 0, "N3a: with a dial open cubed does not ask for the machine's services");
  await echo(socket, "n3-still\n");
  const closed = once(socket, "close");
  socket.end();
  socket.destroy();
  await closed;
  summary.N3a = { servicesAsks: n3aAsks };

  // N3b: the dial closed, the service registered (today's rule while N-207-8 is open): not asked, its services asked.
  const n3bFrom = Date.now();
  await quiet(a, "N3b (the dial closed, the service registered)");
  const n3bAsks = servicesAsked(a, n3bFrom);
  assert.ok(n3bAsks >= 1, `N3b: cubed asked for the machine's services (${n3bAsks})`);
  note(`N3a/N3b: services asked ${n3aAsks} times with the dial open, ${n3bAsks} with the service alone`);
  summary.N3b = { servicesAsks: n3bAsks, note: "interim rule; N-207-8 is the user's" };

  // N3c: the service stopped: suspended.
  const stopped = await setup(a, "N3c service stop", "cube service stop csecho --json || exit $?\necho CS-STOPPED", "CS-STOPPED");
  if ((JSON.parse(stopped.split("\n")[0]!) as { stopped?: boolean }).stopped !== true) throw new Error(`STOP: harness setup: N3c service stop: ${stopped}`);
  const n3c = await suspendedBy(a, "N3c (after the service was stopped)", Date.now());
  summary.N3c = { suspendedAfterStopMs: n3c };

  // N3d: the portal wakes it: the guest answers (no such service), not the 503 of a machine that still wakes.
  const portalFrom = Date.now();
  const answer = await request(portalPort, `nosuch-${app.portal!.label(a)}.localhost:${portalPort}`, "GET", "/");
  const portalMs = Date.now() - portalFrom;
  assert.equal(answer.status, 404, `N3d: the portal's answer after waking: ${answer.status} ${answer.body.toString()}`);
  assert.match(answer.body.toString(), /no service nosuch/, answer.body.toString());
  assert.ok(portalMs < 60000, `N3d: woken within the portal's 60 s (${portalMs} ms)`);
  assert.ok(!thread(a).vm?.suspension, "N3d: awake");
  assert.equal(await bash(a, BOOT), boot, "N3d: the same boot");
  note(`N3d: a portal request woke it in ${(portalMs / 1000).toFixed(1)} s and the guest answered ${answer.status}; same boot`);
  // N5 needs A suspended.
  const n3d = await suspendedBy(a, "N3d (suspended again before N5)", Date.now());
  summary.N3d = { portalStatus: answer.status, portalWakeMs: portalMs, suspendedAfterMs: n3d };

  // N5: one slot. A suspended; B takes the slot and stays busy (a command, no poll).
  assert.equal(await freeSlots(), 1);
  const b = (await threads.spawn({ project: "cs", task: "take the slot" }, "req-b")).id;
  await waitReady(b, "thread B's machine is ready");
  assert.equal(thread(b).runnerId, node, "B is placed on the one runner");
  await firstTurn(b);
  await begin(b, "sleep 900", 960000);
  assert.equal(await freeSlots(), 0, "N5: B holds the slot");
  assert.ok(suspended(a), "N5: A is still suspended");
  const startsA = asked(a, "machineStart");
  const n5Run = await send(a, bashLine(`${BOOT}; echo n5`));
  const waitingText = await until("N5: A says it waits for a free slot", 60000, async () => (await listedThread(a)).vm?.suspension?.waiting);
  assert.match(waitingText, /^waiting for a free slot on runner /, waitingText);
  // The registry reserves a wake's slot first (Registry.beginWake): with B
  // on the only one, berth is not asked to resume A at all.
  assert.equal(asked(a, "machineStart"), startsA, "N5: cubed did not ask berth to resume A while B held the slot");
  await delay(12000);
  assert.ok(thread(a).vm?.suspension && fs.existsSync(memoryFile(vmA)), "N5: A stays suspended while B holds the slot");
  assert.equal(asked(b), 0, "N5: B was never asked to suspend (busy)");
  note(`N5: a message to A with B on the slot: "${waitingText}"`);
  const archivedFrom = Date.now();
  await archive(b);
  const n5 = (await ran(a, n5Run, 300000)).split("\n");
  const n5Ms = Date.now() - archivedFrom;
  assert.deepEqual(n5, [boot, "n5"], "N5: A resumed, the same boot, and its run ended");
  assert.ok(!thread(a).vm?.suspension, "N5: awake");
  note(`N5: B archived; A resumed and its run ended ${(n5Ms / 1000).toFixed(1)} s later`);
  summary.N5 = { waiting: waitingText, resumedAfterArchiveMs: n5Ms };

  // N6: suspended, berth restarted, the snapshot's key another berth's.
  await suspendedBy(a, "N6 (suspended before berth's restart)", Date.now());
  await stop(runner.child);
  const journalPath = path.join(directory, vmA, "machine.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { snapshot: { key: { berth: string } } };
  journal.snapshot.key.berth = "0.0.0-other";
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  runner = await start(true, false);
  const startsBeforeQuiet = asked(a, "machineStart");
  await delay(2 * TICK_MS + 5000);
  assert.ok(suspended(a) && fs.existsSync(memoryFile(vmA)), "N6: across berth's restart the loop leaves A suspended");
  assert.equal(asked(a, "machineStart"), startsBeforeQuiet, "N6: no machine_start from the loop");
  const n6 = (await bash(a, `${BOOT}; cat ~/cs-hooks.log`)).split("\n");
  const coldBoot = n6[0]!;
  assert.match(coldBoot, /^[0-9a-f-]{36}$/);
  assert.notEqual(coldBoot, boot, "N6: a cold boot");
  const hooks = n6.slice(1).join("\n");
  assert.equal(hookLines(hooks, "resume").at(-1), `resume ${coldBoot}`, "N6: the resume hook ran for the cold boot");
  assert.equal(hookLines(hooks, "pre-resume").at(-1), `pre-resume ${coldBoot}`, "N6: the pre-resume hook too");
  const listed = await listedThread(a);
  assert.equal(listed.vm?.notice?.text, "restarted after an update; running commands were interrupted", JSON.stringify(listed.vm));
  assert.ok(berthEvents(vmA).some(line => / snapshot dropped: version: /.test(line)), `N6: berth dropped it: ${berthEvents(vmA).slice(-5).join(" | ")}`);
  assert.ok(!fs.existsSync(memoryFile(vmA)), "N6: the memory file is gone");
  note(`N6: cold boot ${coldBoot} with SnapshotDropped/version; notice "${listed.vm?.notice?.text}"; pre-resume and resume ran`);
  summary.N6 = { coldBoot, notice: listed.vm?.notice?.text };

  // Every machine_suspend was answered, within berth's 85 s (#208), none past cubed's 90 s.
  const suspends = sent.filter(entry => entry.verb === "machineSuspend");
  assert.ok(suspends.length >= 5 && suspends.every(entry => entry.ms !== undefined && entry.ms < 85000),
    `machine_suspend answers: ${JSON.stringify(suspends)}`);
  summary.suspendCalls = { count: suspends.length, maxMs: Math.max(...suspends.map(entry => entry.ms!)), outcomes: [...new Set(suspends.map(entry => entry.outcome))] };
  note(`machine_suspend: ${suspends.length} calls, the slowest answered in ${(summary.suspendCalls as { maxMs: number }).maxMs} ms`);

  console.log(`ok: cubed with berth vm (${accel}), idle ${IDLE_MS / 1000} s and the real 30 s loop: N7 never asked without the capability; `
    + "N1 suspended by the loop, its slot free, not woken by it; N4 a message woke it (same boot, no hooks); N2 not during a command with no poll, "
    + "suspended after its end, woken by a guest call; N3a not with a dial open (services not asked), N3b not with a registered service (services asked), "
    + "N3c suspended once the service stopped, N3d woken by the portal; "
    + "N5 waited for a free slot and resumed after B's archive; N6 cold after another berth's snapshot, with the notice and resume hooks");
} catch (error) {
  failed = true;
  throw error;
} finally {
  clearTimeout(watchdog);
  await teardown();
}
