/** V13 (masterplan A-5): two machines on one `berth vm` at the same time,
 * kept apart. Machines A and B (owners thread-a and thread-b) run together
 * on one runner, both ready before any check and both still running on
 * their first boot at the end, each with its own GitHub placeholder as
 * GH_TOKEN and its own egress policy. The test plays cubed as
 * runner-vm-test.ts's V6-V8 do: its report reader, a RunnerSession with
 * cubed's credential check, the egress policy with a two-entry `vms` map
 * (machine -> thread and placeholders), the gateway's credential proxy (a
 * test-hooks cube-gateway) and the fake GitHub (fake-github.ts).
 *
 *   (a) placeholders: A's request with its own placeholder reaches the fake
 *       GitHub with the token, and so does B's; B sending A's placeholder
 *       and A sending B's are refused, by layer named, and reach nothing;
 *       the token is in no file of the runner's directory or the gateway's
 *       state, in berth's output or a log.
 *   (b) LANs: both guests have the same address (192.168.127.2) on links of
 *       their own. With a listener in B on 8080, A reaches neither
 *       192.168.127.2:8080 (its own address) nor 192.168.127.1:8080 (the
 *       runner); cubed's `dial` to A on 8080 fails and to B answers B.
 *   (c) the flood, once from A while B is probed and once mirrored:
 *       (c1) cubed connected, the flooder under DENY opens 400 connections
 *            that each send a request and stay open, more than its link's
 *            256 flows; the prober's 40 HTTPS probes are 200 and under 5 s
 *            each, the flooder's own next connection is refused, and every
 *            report is the flooder's, delivered or counted in
 *            dropped_before, one per accepted connection;
 *       (c2) cubed gone, the flooder's lease 3 s and the prober's 15 min:
 *            400 connections from the flooder refused (lease_expired) and
 *            queued past the runner's queue of 256, 20 probes from the
 *            prober meanwhile all 200; back, 256 reports all the
 *            flooder's, then its next report carries dropped_before.
 *       Afterwards the flooder gets 200 again once its policy allows it.
 *
 * Two deviations from the task's wording (299fbcc4 §3.2 (c)), because the
 * product cannot show it the literal way: a connection that sends nothing
 * is never reported under DENY with cubed connected (the runner reports a
 * refused request; only an expired lease is reported at the connection),
 * so each connection of (c1) sends a request; and the report queue is the
 * runner's, drained while cubed reads, so dropped_before is certain only
 * while cubed is gone, which (c2) adds, with the prober's lease long so its
 * egress goes on.
 *
 *   node packages/server/test/runner-vm-v13-test.ts target/debug/berth
 *
 * The environment is runner-vm-test.ts's: CUBE_TEST_BERTH_QEMU,
 * CUBE_TEST_BERTH_QEMU_IMG, CUBE_TEST_BERTH_KEEL, CUBE_TEST_BERTH_IMAGE (an
 * image keel calls ready, with perl), CUBE_TEST_BERTH_MKFS,
 * CUBE_TEST_BERTH_ACCEL, CUBE_TEST_BERTH_PULLED, CUBE_TEST_BERTH_GATEWAY and
 * CUBE_TEST_BERTH_TMP; without them it is skipped with a notice, and
 * CUBE_TEST_BERTH_VM=required makes that a failure. For a slow machine
 * (TCG) only: CUBE_TEST_V13_PROBE_MS bounds each probe instead of 5000 ms
 * (the run prints it), and CUBE_TEST_V13_GONE_MS keeps cubed away longer
 * than 75 s for (c2). On Linux (c1) records the host CPU berth and each QEMU
 * used during the flood. Loopback only; nothing outside its temporary
 * directory. Mocks are not runner acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fromJsonString } from "@bufbuild/protobuf";
import { Endpoint, EndpointAddr, EndpointId, SecretKey } from "@number0/iroh/index.js";
import { EgressPolicy_Default, EgressReportSchema, MachineStatus_Phase, OpenSchema, type EgressReport, type Machine } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { EgressPolicy, newPlaceholder, serveEgress } from "../src/egress-policy.ts";
import { GatewaySupervisor } from "../src/gateway.ts";
import { checkMachine, type CredentialRoute } from "../src/runner-credentials.ts";
import { fakeGithub } from "../../../scripts/fake-github.ts";
import { scanForSecret } from "./leak-scan.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { settleOperation, type Workspace } from "../src/workspace.ts";
import { DIAL_APP } from "./portal-dial.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const began = Date.now();
const note = (line: string) => console.log(`runner-vm-v13-test [${((Date.now() - began) / 1000).toFixed(1)}s]: ${line}`);

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
  console.error(`\nSKIP: V13 (two machines on one berth vm) did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cv13-")));
const directory = path.join(root, "m");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const node = "node-vm-v13";
const show = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === "bigint" ? String(x) : x);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the runner

/** Everything berth vm writes to stderr, for the token scan. */
let berthLog = "";
async function start(): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--accel", accel, "--image", image, "--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0"],
  // Its own process group, as in a terminal: a Ctrl-C reaches the whole group.
  { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", chunk => { berthLog += chunk; });
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
/** Processes whose command line names this test's runner directory (QEMU's do). */
function leftovers(): string {
  try { return execFileSync("pgrep", ["-f", directory], { encoding: "utf8" }).trim(); } catch { return ""; }
}

/** A command under its own lease, to its end: exit code and output. */
async function shell(workspace: Workspace, key: string, command: string, timeoutMs = 60000): Promise<{ exitCode: number | null; output: string }> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.exec(lease.token, key, { command, timeoutMs });
    const done = await settleOperation(workspace, lease.token, key);
    assert.equal(done.state, "succeeded", `${key}: ${JSON.stringify(done)}`);
    return { exitCode: done.state === "succeeded" ? done.exitCode : null, output: done.state === "succeeded" ? Buffer.from(done.output).toString("utf8") : "" };
  } finally { await workspace.release(lease.token).catch(() => {}); }
}
/** A command left running: started under a lease that is released at once. */
async function begin(workspace: Workspace, key: string, command: string, timeoutMs: number): Promise<void> {
  const lease = await workspace.lease({ owner: "pi" });
  try { await workspace.exec(lease.token, key, { command, timeoutMs }); } finally { await workspace.release(lease.token).catch(() => {}); }
}
/** The end of a command `begin` started: exit 0 and its output. */
async function finish(workspace: Workspace, key: string): Promise<string> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    const done = await settleOperation(workspace, lease.token, key);
    assert.ok(done.state === "succeeded" && done.exitCode === 0, `${key}: ${JSON.stringify(done)}`);
    return Buffer.from(done.output).toString("utf8");
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** cubed's end of the runner's report stream (runner-vm-test.ts's): its own
 * connection with the control key, opened before cubed's session, so the
 * runner writes its reports here (one writer at a time) and opens its
 * credential streams on the session (the newest connection). */
async function reportReader(address: string, peer: string) {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(SecretKey.fromBytes(Array.from(fs.readFileSync(controlKey))).toBytes());
  builder.alpns([]);
  builder.bindAddr("127.0.0.1:0");
  const endpoint = await builder.bind();
  const connection = await endpoint.connect(new EndpointAddr(EndpointId.fromBytes(Array.from(Buffer.from(peer, "hex"))), null, [address]),
    Array.from(Buffer.from("cubeyard/runner/4")));
  const received: EgressReport[] = [];
  let wake = () => {};
  let ended = false;
  void (async () => {
    try {
      const stream = await connection.acceptBi();
      const frame = async () => {
        const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
        return Buffer.from(await stream.recv.readExact(length)).toString("utf8");
      };
      const opened = fromJsonString(OpenSchema, await frame());
      assert.equal(opened.kind.case, "report", "the runner's stream is a report stream");
      for (;;) { received.push(fromJsonString(EgressReportSchema, await frame())); wake(); }
    } catch { ended = true; wake(); }
  })();
  const wait = () => new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 200); });
  return {
    /** The next `n` reports, in order. */
    async take(n: number, ms: number): Promise<EgressReport[]> {
      const deadline = Date.now() + ms;
      while (received.length < n) {
        if (ended) throw new Error(`the report stream ended after ${received.length} of ${n}`);
        if (Date.now() > deadline) throw new Error(`${received.length} of ${n} reports in ${ms} ms: ${show(received.slice(0, 5))}`);
        await wait();
      }
      return received.splice(0, n);
    },
    /** Every report until none came for `quietMs` (at most `ms` in all). */
    async quiet(quietMs: number, ms = 120000): Promise<EgressReport[]> {
      const deadline = Date.now() + ms;
      let count = -1;
      let since = Date.now();
      while (Date.now() - since < quietMs) {
        assert.ok(Date.now() < deadline, `reports still coming after ${ms} ms`);
        if (received.length !== count) { count = received.length; since = Date.now(); }
        await wait();
      }
      return received.splice(0);
    },
    async close() { connection.close(0n, []); await endpoint.close(); },
  };
}

const SESSION = /^[0-9a-f]{32}$/;
const MARKER = "dial-app: hello from v13b";
const SHARED_ADDRESS = "192.168.127.2";
/** Report reasons of one machine's refusals, and what dropped_before counts. */
const tally = (reports: EgressReport[]) => ({ count: reports.length, dropped: reports.reduce((sum, r) => sum + Number(r.droppedBefore), 0) });

if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
const runner = await start();
note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|machines|max machines):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 1 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });

// cubed's side: the egress policy (two machines, two threads, two
// placeholders), the gateway's credential proxy and the fake GitHub.
const ghToken = `ghs_v13${randomBytes(12).toString("hex")}`;
const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY || (() => {
  execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks"],
    { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
  return path.join(repo, "target/test-hooks/debug/cube-gateway");
})();
const logged: string[] = [];
const capture = (scope: string) => {
  const line = (level: string) => (message: string, fields?: object) => logged.push(`${scope} ${level} ${message} ${show(fields ?? {})}`);
  const logger = { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error"), child: () => logger };
  return logger as never;
};
const run = path.join(root, "run");
fs.mkdirSync(run, { mode: 0o700 });
const gatewayState = path.join(root, "gateway");
const github = await fakeGithub({ dir: path.join(root, "github"), token: ghToken });
const credentialSocket = path.join(run, "credential.sock");

interface Side { name: "A" | "B"; ref: { owner: string; id: string }; epoch: number; placeholder: string; boot: string }
const A: Side = { name: "A", ref: { owner: "thread-a", id: randomBytes(8).toString("hex") }, epoch: Date.now(), placeholder: newPlaceholder("github"), boot: "" };
const B: Side = { name: "B", ref: { owner: "thread-b", id: randomBytes(8).toString("hex") }, epoch: Date.now() + 1, placeholder: newPlaceholder("github"), boot: "" };
assert.notEqual(A.placeholder, B.placeholder);
const sides = [A, B];
const placeholders: Record<string, Record<string, string>> = { [A.ref.id]: { github: A.placeholder }, [B.ref.id]: { github: B.placeholder } };
const egress = new EgressPolicy({
  vms: { vm: vmId => { const side = sides.find(s => s.ref.id === vmId); return side ? { threadId: side.ref.owner, placeholders: placeholders[vmId]! } : null; } },
  secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => ghToken }], log: capture("egress"),
});
const decider = await serveEgress(path.join(run, "egress.sock"), egress);
const gateway = new GatewaySupervisor({ state: gatewayState, control: path.join(run, "gateway.sock"), decide: path.join(run, "egress.sock"),
  credential: credentialSocket, network: "loopback", binary: gatewayBin, log: capture("gateway"),
  extraArgs: ["--test-upstream", `github.com=127.0.0.1:${github.port}`, "--test-upstream", `api.github.com=127.0.0.1:${github.port}`, "--test-upstream-ca", github.ca] });
gateway.start();
const route: CredentialRoute = {
  // cubed's own check (registryCredentialRoute's), on what the test's "registry" holds: two threads, a machine each.
  refuse: (on, machine, fence) => {
    const side = sides.find(s => s.ref.id === machine.id);
    return checkMachine(side ? { ...side.ref, epoch: side.epoch } : null, on.nodeId, machine, fence);
  },
  socket: () => gateway.running ? credentialSocket : null,
};
const sessions: RunnerSession[] = [];
const leases = fs.mkdtempSync(path.join(os.tmpdir(), "runner-vm-v13-"));
const store = new LeaseStore(leases);
let reader: Awaited<ReturnType<typeof reportReader>> | undefined;
try {
  await gateway.ready();
  // The reader first (it holds the runner's report writer), then cubed's session.
  reader = await reportReader(runner.address, runner.peer);
  const connect = () => { const opened = new RunnerSession(loadSessionConfig(configPath).config, { credentials: route, log: capture("session") }); sessions.push(opened); return opened; };
  let session = connect();
  const hello = await session.hello();
  assert.equal(hello.runner?.network?.egress, true, "Runner.network.egress");
  assert.equal(hello.runner?.platform?.accelerator, accel);
  let workspaces = new Map<Side, VmWorkspace>();
  const reconnectWorkspaces = () => {
    workspaces = new Map(sides.map(side => [side, new VmWorkspace({ guest: session.guest(side.ref, () => side.epoch), leases: store, owner: "pi",
      binding: `runner-vm-v13-${side.name}:${process.pid}`, retryMs: 2000 })]));
  };
  reconnectWorkspaces();
  const ws = (side: Side) => workspaces.get(side)!;
  const sh = async (side: Side, key: string, command: string, timeoutMs = 60000) => {
    const done = await shell(ws(side), `${key}-${randomBytes(3).toString("hex")}`, command, timeoutMs);
    assert.equal(done.exitCode, 0, `${side.name} ${key}: ${done.output}`);
    return done.output.trim();
  };

  // Each machine's policy: public HTTP and HTTPS, the github credential rule
  // on the secret's hosts (cubed's policyFor), and the lease given.
  const allow = (side: Side, leaseSeconds: bigint) => ({ ...egress.policyFor({ vm: { placeholders: placeholders[side.ref.id]! } }), lease: { seconds: leaseSeconds, nanos: 0 } });
  const deny = (leaseSeconds: bigint) => ({ default: EgressPolicy_Default.DENY, denyHosts: [], rules: [], lease: { seconds: leaseSeconds, nanos: 0 } });
  const documents = (side: Side) => ({ hostname: Buffer.from(`cube-v13-${side.name.toLowerCase()}\n`), env: Buffer.from(`GH_TOKEN=${side.placeholder}\n`) });
  const startWith = async (side: Side, policy: object): Promise<Machine> =>
    await session.machine({ case: "machineStart", value: { ref: side.ref, fence: { epoch: BigInt(side.epoch) }, boot: { documents: documents(side), mac: "" }, policy: policy as never } });

  // ------------------------------------------------ two machines, both ready
  const size = { vcpus: 2, memoryMib: 1024, diskGib: 4 };
  for (const side of sides) {
    const created = await session.machine({ case: "machineCreate", value: { ref: side.ref, fence: { epoch: BigInt(side.epoch) }, spec: { source: { case: "base", value: true }, size } } });
    assert.equal(created.status?.phase, MachineStatus_Phase.STOPPED);
  }
  for (const side of sides) {
    const started = await startWith(side, allow(side, 3n));
    assert.equal(started.status?.phase, MachineStatus_Phase.RUNNING);
    side.boot = started.status!.bootId;
    assert.match(side.boot, /^[0-9a-f]{32}$/);
  }
  for (const side of sides) {
    const settled = await session.until(side.ref, machine => {
      const guest = machine.status?.guest;
      return !!guest && guest.connected && SESSION.test(guest.session) && (guest.ready || /lacks/.test(guest.reason));
    }, 300000);
    assert.equal(settled.status?.guest?.ready, true, `${side.name} is not ready: "${settled.status?.guest?.reason}" (V13 needs an image keel calls ready)`);
  }
  const both = await session.call({ case: "machineList", value: {} });
  assert.ok(both.case === "machines" && sides.every(side => both.value.items.some(m => m.ref?.id === side.ref.id && m.status?.phase === MachineStatus_Phase.RUNNING)), show(both));
  const argv = (side: Side) => (JSON.parse(fs.readFileSync(path.join(directory, side.ref.id, "argv.json"), "utf8")) as { args: string[] }).args;
  assert.ok(sides.every(side => argv(side).some(a => a.endsWith(`,accel=${accel}`))), "both machines run under the accelerator");
  note(`two machines on one runner, both RUNNING and ready: A ${A.ref.id} (boot ${A.boot}), B ${B.ref.id} (boot ${B.boot}); -sandbox in argv: ${sides.map(side => `${side.name} ${argv(side).includes("-sandbox") ? argv(side)[argv(side).indexOf("-sandbox") + 1] : "absent"}`).join(", ")}`);
  for (const side of sides) assert.equal(await sh(side, "v13-env", "echo \"$GH_TOKEN\""), side.placeholder, `${side.name}'s GH_TOKEN is its own placeholder`);

  // ------------------------------------------------ (a) placeholders
  const ask = async (side: Side, key: string, placeholder: string) => {
    const out = await sh(side, key, `curl -s -o /dev/null -D /tmp/v13-h -m 30 -w '%{http_code}' -H "Authorization: Bearer ${placeholder}" https://api.github.com/user; echo; `
      + "tr -d '\\r' < /tmp/v13-h | sed -n 's/^x-cube-denied: /denied: /Ip;s/^x-cube-error: /error: /Ip'");
    const [status = "", ...rest] = out.split("\n");
    return { status, denied: rest.find(l => l.startsWith("denied: "))?.slice(8) ?? "", error: rest.find(l => l.startsWith("error: "))?.slice(7) ?? "", out };
  };
  const DECIDE = "a secret placeholder does not belong to this thread";
  const BERTH = "a secret placeholder is only sent where a credential rule allows it";
  const seenBefore = github.seen.length;
  const own = async (side: Side) => {
    const answer = await ask(side, `v13a-own-${side.name}`, "$GH_TOKEN");
    assert.equal(answer.status, "200", `${side.name} with its own placeholder: ${answer.out}`);
    return answer;
  };
  const cross = async (from: Side, to: Side) => {
    const before = github.seen.length;
    const answer = await ask(from, `v13a-cross-${from.name}`, to.placeholder);
    assert.notEqual(answer.status, "200", `${from.name} sent ${to.name}'s placeholder and it went through: ${answer.out}`);
    const layer = answer.denied === DECIDE ? "cubed's decide (egress.sock, through the gateway's credential proxy)"
      : answer.denied === BERTH ? "berth, before cubed" : "";
    assert.ok(layer, `${from.name} sending ${to.name}'s placeholder: refused with neither known reason: ${answer.out}`);
    if (answer.denied === DECIDE) {
      assert.ok(logged.some(line => line.startsWith("egress info denied ") && line.includes(`"vm":"${from.ref.id}"`) && line.includes(`"reason":"${DECIDE}"`)),
        `cubed's decide logged the refusal for ${from.name}: ${logged.filter(l => l.includes("denied")).join("\n")}`);
    }
    assert.equal(github.seen.length, before, `${from.name}'s request with ${to.name}'s placeholder reached the fake GitHub`);
    return `${from.name} -> ${to.name}'s placeholder: ${answer.status}, "${answer.denied}", refused by ${layer}`;
  };
  await own(A);
  const crossBA = await cross(B, A);
  await own(B);
  const crossAB = await cross(A, B);
  const legitimate = github.seen.slice(seenBefore);
  assert.equal(legitimate.length, 2, `the fake GitHub saw exactly the two legitimate requests: ${show(legitimate)}`);
  assert.ok(legitimate.every(s => s.path === "/user" && s.auth === "token"), `both with the real token: ${show(legitimate)}`);
  note(`(a) A and B with their own placeholders: 200, the fake saw the token twice; ${crossBA}; ${crossAB}; nothing refused reached the fake`);

  // ------------------------------------------------ (b) LANs
  const addresses = async (side: Side) => (await sh(side, "v13b-addr", "awk '/\\|-- / {ip=$2} /32 host LOCAL/ {print ip}' /proc/net/fib_trie | sort -u | grep -v '^127\\.'")).split("\n");
  const [addressA, addressB] = [await addresses(A), await addresses(B)];
  assert.deepEqual(addressA, [SHARED_ADDRESS], `A's addresses: ${addressA}`);
  assert.deepEqual(addressB, [SHARED_ADDRESS], `B's addresses: ${addressB}`);
  const appLease = await ws(B).lease({ owner: "pi" });
  try { await ws(B).writeFile(appLease.token, `v13-app-${process.pid}`, "v13/dial-app.pl", fs.readFileSync(DIAL_APP), { createParents: true }); }
  finally { await ws(B).release(appLease.token); }
  const service = JSON.parse(await sh(B, "v13b-start", "cube service start v13b --port 8080 --cwd v13 --env CUBE_APP_STATE=/tmp --json -- perl dial-app.pl", 120000)) as { ok: boolean };
  assert.equal(service.ok, true, show(service));
  assert.equal(await sh(B, "v13b-local", "for i in $(seq 100); do curl -s -m 2 http://127.0.0.1:8080/ && break; sleep 0.2; done"), MARKER, "B's listener answers inside B");
  const reportsBefore = await reader.quiet(3000);
  assert.ok(reportsBefore.every(r => sides.some(side => r.ref?.id === side.ref.id)), show(reportsBefore));
  const fromA: string[] = [];
  for (const target of [SHARED_ADDRESS, "192.168.127.1"]) {
    const out = await sh(A, "v13b-cross", `curl -s -m 5 -o /tmp/v13-body -w '%{http_code} %{exitcode}' http://${target}:8080/; echo; cat /tmp/v13-body 2>/dev/null; true`);
    assert.ok(!out.includes(MARKER), `A reached B's listener at ${target}:8080: ${out}`);
    assert.match(out.split("\n")[0]!, /^000 (7|56)$/, `A to ${target}:8080 must be refused or reset: ${out}`);
    fromA.push(`${target}:8080 ${out.split("\n")[0]!.split(" ")[1] === "7" ? "refused" : "reset"}`);
  }
  // cubed's side: the runner's dial streams into each machine's own link.
  const dialGet = async (side: Side): Promise<string> => {
    const socket: Duplex = await session.dial(side.ref, side.epoch, 8080);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timer: NodeJS.Timeout | undefined;
    const ended = Promise.race([once(socket, "end"), once(socket, "close"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no end of the dial to ${side.name} in 15 s`)), 15000); })]);
    socket.write("GET / HTTP/1.1\r\nHost: v13\r\nConnection: close\r\n\r\n");
    try { await ended; } finally { clearTimeout(timer); socket.destroy(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const toA = await dialGet(A).then(answer => `answered: ${answer}`, (error: unknown) => error);
  assert.ok(toA instanceof RunnerError && toA.code === "UNAVAILABLE" && toA.reason === "dial_failed", `cubed's dial to A on 8080: ${toA instanceof Error ? `${toA.message}` : String(toA)}`);
  const toB = await dialGet(B).catch((error: unknown) => assert.fail(`cubed's dial to B on 8080 failed: ${error instanceof Error ? error.message : String(error)}`));
  assert.match(toB, /^HTTP\/1\.[01] 200 /, toB);
  assert.ok(toB.includes(MARKER), `cubed's dial to B answers B: ${toB}`);
  const reportsB2 = await reader.quiet(3000);
  assert.ok(reportsB2.every(r => r.ref?.id === A.ref.id && r.reason === "address"), `(b)'s reports, if any, are A's and address-class: ${show(reportsB2)}`);
  note(`(b) A and B both at ${SHARED_ADDRESS} on links of their own; with B listening on 8080, A got ${fromA.join(", ")} (never B's answer); cubed's dial to A: UNAVAILABLE/dial_failed, to B: "${MARKER}"; ${reportsB2.length} report(s) meanwhile${reportsB2.length ? ", A's, address-class" : ""}`);

  // ------------------------------------------------ (c) the flood
  const FLOOD = 400;
  // The task's bound on each probe is 5 s. CUBE_TEST_V13_PROBE_MS sets
  // another for a slow machine (TCG); the run says so and the gates leave it unset.
  const probeMs = Number(env.CUBE_TEST_V13_PROBE_MS ?? 5000);
  if (probeMs !== 5000) note(`NOTE: probes are bounded at ${probeMs} ms (CUBE_TEST_V13_PROBE_MS), not the task's 5000 ms`);
  const probes = `for i in $(seq 1 20); do echo "$(date +%s%3N) $(curl -s -o /dev/null -m ${Math.max(10, Math.ceil(2 * probeMs / 1000))} -w '%{http_code} %{time_total} %{exitcode} %{errormsg}' https://example.com/)"; sleep 0.25; done`;
  const parseProbes = (who: Side, text: string, label: string) => {
    const lines = text.trim().split("\n").map(line => line.split(" ")).map(([at, status, seconds, exit, ...error]) => ({ at: Number(at), status, seconds: Number(seconds), exit, error: error.join(" ") }));
    assert.equal(lines.length, 20, `${who.name}'s ${label}: ${text}`);
    return lines;
  };
  const judgeProbes = (who: Side, text: string, label: string) => {
    const lines = parseProbes(who, text, label);
    assert.ok(lines.every(p => p.status === "200" && p.seconds * 1000 < probeMs), `${who.name}'s ${label}: every probe 200 within ${probeMs} ms: ${text}`);
    return lines;
  };
  // Host CPU seconds of berth and each machine's QEMU (Linux /proc only):
  // whether a slow probe waited on the runner or on the host's CPUs.
  const cpu = (): Record<string, number> | null => {
    if (process.platform !== "linux") return null;
    const of = (pid: number) => { const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" "); return (Number(fields[11]) + Number(fields[12])) / 100; };
    const qemuPid = (side: Side) => (JSON.parse(fs.readFileSync(path.join(directory, side.ref.id, "machine.json"), "utf8")) as { boot: { pid: number } }).boot.pid;
    return { berth: of(runner.child.pid!), A: of(qemuPid(A)), B: of(qemuPid(B)) };
  };
  const used = (from: Record<string, number> | null, to: Record<string, number> | null, ms: number) => from && to
    ? `host CPU over ${(ms / 1000).toFixed(1)} s: ${Object.keys(to).map(k => `${k === "berth" ? "berth" : `QEMU ${k}`} ${(to[k]! - from[k]!).toFixed(1)} s`).join(", ")} (${os.cpus().length} CPUs)`
    : "host CPU not measured (not Linux)";
  const spread = (lines: Array<{ seconds: number }>) => {
    const sorted = lines.map(p => p.seconds).sort((x, y) => x - y);
    return `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(3)} s, slowest ${sorted.at(-1)!.toFixed(3)} s`;
  };
  const flood = async (flooder: Side, prober: Side) => {
    const tag = `${flooder.name}->${prober.name}`;
    // (c1) cubed connected: the flooder under DENY, the prober as before.
    assert.equal((await startWith(flooder, deny(3n))).status?.phase, MachineStatus_Phase.RUNNING);
    assert.equal((await startWith(prober, allow(prober, 3n))).status?.phase, MachineStatus_Phase.RUNNING);
    await reader!.quiet(3000);
    // The prober alone first: what its probes take on this machine without a flood (recorded, every one 200).
    const baseline = parseProbes(prober, await sh(prober, "v13c-baseline", probes, 300000), "probes before the flood");
    assert.ok(baseline.every(p => p.status === "200"), `${prober.name}'s probes before the flood: ${show(baseline)}`);
    note(`(c ${tag}) ${prober.name} alone, before the flood: 20 probes 200, ${spread(baseline)}`);
    const hold = [
      "rm -f /tmp/v13-flood.txt /tmp/v13-release; ok=0; refused=0",
      `for i in $(seq 1 ${FLOOD}); do`,
      "  if { exec {fd}<>/dev/tcp/203.0.113.1/80; } 2>/dev/null; then printf 'GET /v13-flood/%d HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n' \"$i\" >&$fd; ok=$((ok+1)); else refused=$((refused+1)); fi",
      "done",
      "echo \"ok=$ok refused=$refused\" > /tmp/v13-flood.txt",
      "for i in $(seq 1 1200); do [ -e /tmp/v13-release ] && break; sleep 0.5; done",
    ].join("\n");
    const [cpuFrom, cpuAt] = [cpu(), Date.now()];
    await begin(ws(flooder), `v13c-hold-${tag}`, hold, 900000);
    await begin(ws(prober), `v13c-probe1-${tag}`, probes, 300000);
    let counts = "";
    for (let i = 0; i < 300 && !counts; i++) {
      counts = await sh(flooder, "v13c-count", "cat /tmp/v13-flood.txt 2>/dev/null; true");
      if (!counts) await delay(1000);
    }
    const match = /^ok=(\d+) refused=(\d+)$/.exec(counts);
    assert.ok(match, `the flood's counts: ${counts}`);
    const [ok, refusedCount] = [Number(match[1]), Number(match[2])];
    assert.equal(ok + refusedCount, FLOOD);
    assert.ok(ok <= 256 && refusedCount > 0, `the flooder's link holds at most 256 flows: ${counts}`);
    // While the flooder's link is full: its own next connection is refused, the prober's go through.
    const self = await sh(flooder, "v13c-self", "curl -s -o /dev/null -m 5 -w '%{http_code} %{exitcode}' --connect-to ::203.0.113.1: http://example.com/; true");
    assert.match(self, /^000 (7|56)$/, `the flooder's own next connection while its link is full: ${self}`);
    const duringText = await finish(ws(prober), `v13c-probe1-${tag}`);
    const stormCpu = used(cpuFrom, cpu(), Date.now() - cpuAt);
    note(`(c1 ${tag}) the storm: ${stormCpu}`);
    const during = judgeProbes(prober, duringText, "probes during the flood");
    const held = judgeProbes(prober, await sh(prober, "v13c-probe2", probes, 300000), "probes while the flooder's link is full");
    await sh(flooder, "v13c-release", "touch /tmp/v13-release");
    await finish(ws(flooder), `v13c-hold-${tag}`);
    // Every accepted connection's refused request is reported, the flooder's, delivered or counted.
    const deadline = Date.now() + 60000;
    const got: EgressReport[] = [];
    while (tally(got).count + tally(got).dropped < ok && Date.now() < deadline) got.push(...await reader!.quiet(2000));
    got.push(...await reader!.quiet(3000));
    assert.ok(got.every(r => r.ref?.id === flooder.ref.id && r.ref?.owner === flooder.ref.owner), `every report is ${flooder.name}'s: ${show(got.filter(r => r.ref?.id !== flooder.ref.id).slice(0, 5))}`);
    assert.ok(got.every(r => r.reason === "policy" && r.host === "example.com"), show(got.slice(0, 3)));
    const { count, dropped } = tally(got);
    assert.equal(count + dropped, ok, `${count} reports delivered and ${dropped} counted dropped for ${ok} refused requests`);
    note(`(c1 ${tag}) cubed connected: ${flooder.name} opened ${ok} connections with a request each and ${refusedCount} more were refused by its full link (its own next connection too: ${self}); ${prober.name}'s 40 HTTPS probes all 200 within ${probeMs} ms (during the storm ${spread(during)}; while the link was full ${spread(held)}); ${count} reports delivered + ${dropped} dropped_before = ${ok}, all ${flooder.name}'s (policy, example.com)`);

    // (c2) cubed gone: the flooder's lease (3 s) runs out, the prober's (15 min) does not.
    assert.equal((await startWith(prober, allow(prober, 900n))).status?.phase, MachineStatus_Phase.RUNNING);
    const leaseMs = 3000;
    await begin(ws(flooder), `v13c-gone-${tag}`, `rm -f /tmp/v13-gone.txt; sleep 8; s=$(date +%s%3N); for i in $(seq 1 ${FLOOD}); do { exec 3<>/dev/tcp/203.0.113.1/80; } 2>/dev/null; exec 3>&-; done; echo "$s $(date +%s%3N)" > /tmp/v13-gone.txt`, 600000);
    await begin(ws(prober), `v13c-goneprobe-${tag}`, `rm -f /tmp/v13-goneprobe.txt; sleep 8; ${probes} > /tmp/v13-goneprobe.txt`, 600000);
    await delay(1000);
    await reader!.close();
    for (const s of sessions.splice(0)) await s.close();
    const lost = Date.now();
    await delay(Number(env.CUBE_TEST_V13_GONE_MS ?? 75000));
    reader = await reportReader(runner.address, runner.peer);
    session = connect();
    const returned = Date.now();
    await session.hello();
    reconnectWorkspaces();
    await finish(ws(flooder), `v13c-gone-${tag}`);
    await finish(ws(prober), `v13c-goneprobe-${tag}`);
    const [floodStart, floodEnd] = (await sh(flooder, "v13c-gone-at", "cat /tmp/v13-gone.txt")).split(" ").map(Number);
    assert.ok(floodStart! > lost + leaseMs && floodEnd! < returned, `the flood ran while ${flooder.name}'s lease was over and cubed away: ${floodStart! - lost}..${floodEnd! - lost} ms after cubed went, back at ${returned - lost}`);
    const gone = judgeProbes(prober, await sh(prober, "v13c-goneprobe-log", "cat /tmp/v13-goneprobe.txt"), "probes while cubed was away");
    assert.ok(gone.every(p => p.at > lost + leaseMs && p.at < returned), `${prober.name}'s probes ran after ${flooder.name}'s lease ran out, before cubed came back: ${show(gone.map(p => p.at - lost))}`);
    const queued = await reader.take(256, 30000);
    assert.ok(queued.every(r => r.ref?.id === flooder.ref.id && r.ref?.owner === flooder.ref.owner), `every queued report is ${flooder.name}'s: ${show(queued.filter(r => r.ref?.id !== flooder.ref.id).slice(0, 5))}`);
    assert.ok(queued.every(r => r.reason === "lease_expired" && r.host === "203.0.113.1:80" && r.droppedBefore === 0n), show(queued.slice(0, 3)));
    const next = await sh(flooder, "v13c-next", "curl -s -o /dev/null -m 20 -w '%{http_code}' --connect-to ::203.0.113.1: http://example.com/; true");
    assert.equal(next, "403", "the flooder's next request is refused by its policy");
    const [after] = await reader.take(1, 20000);
    assert.ok(after!.ref?.id === flooder.ref.id && after!.reason === "policy", show(after));
    assert.ok(after!.droppedBefore > 0n && 256n + after!.droppedBefore <= BigInt(FLOOD), `dropped_before ${after!.droppedBefore} on ${flooder.name}'s next report`);
    const rest = await reader.quiet(3000);
    assert.deepEqual(rest, [], `no more reports: ${show(rest)}`);
    // The flood poisoned nothing: allowed again, the flooder goes out again.
    assert.equal((await startWith(flooder, allow(flooder, 3n))).status?.phase, MachineStatus_Phase.RUNNING);
    assert.equal((await startWith(prober, allow(prober, 3n))).status?.phase, MachineStatus_Phase.RUNNING);
    assert.equal(await sh(flooder, "v13c-again", "curl -s -o /dev/null -m 20 -w '%{http_code}' https://example.com/; true"), "200", `${flooder.name} after its flood`);
    note(`(c2 ${tag}) cubed away ${returned - lost} ms: ${flooder.name}'s ${FLOOD} connections refused (lease_expired) ${floodStart! - lost}..${floodEnd! - lost} ms after; ${prober.name}'s 20 probes meanwhile all 200 within ${probeMs} ms (${spread(gone)}); back: 256 queued reports, all ${flooder.name}'s, then its next with dropped_before=${after!.droppedBefore}; ${flooder.name} allowed again: 200`);
  };
  await flood(A, B);
  await flood(B, A);

  // ------------------------------------------------ the end: still the same two boots
  for (const side of sides) {
    const now = await session.machine({ case: "machineGet", value: { ref: side.ref } });
    assert.equal(now.status?.phase, MachineStatus_Phase.RUNNING, `${side.name} still runs`);
    assert.equal(now.status?.bootId, side.boot, `${side.name} still on its first boot`);
  }
  // The token: nowhere in the runner's directory (both machines' state,
  // journals, logs and disks), the gateway's state, berth's output or a log.
  const scan = scanForSecret([directory, gatewayState], ghToken);
  assert.deepEqual(scan.matches, [], "the token is in the runner's directory or the gateway's state");
  assert.ok(scan.files > 0 && scan.skipped.every(s => s.kind === "socket"), `not scanned: ${show(scan.skipped)}`);
  assert.ok(sides.every(side => scan.skipped.some(s => s.path === path.join(directory, side.ref.id, "qmp.sock"))), "both running machines were scanned");
  assert.ok(!berthLog.includes(ghToken) && !logged.some(line => line.includes(ghToken)), "the token is in berth's output or a log");
  assert.ok(logged.some(line => line.startsWith("gateway ")), "the gateway's log was captured");
  note(`token scan: in no file of berth's --dir (both machines) or the gateway's state (${scan.files} files, ${scan.bytes} bytes read; ${scan.skipped.length} sockets not read), berth's output or the ${logged.length} log lines; A and B still RUNNING on boots ${A.boot} and ${B.boot}`);

  // Clean-up: both machines deleted, their QEMUs gone, the runner stopped, nothing left.
  for (const side of sides) {
    const deleted = await session.machine({ case: "machineDelete", value: { ref: side.ref, fence: { epoch: BigInt(side.epoch) }, retain: false } });
    assert.equal(deleted.status?.phase, MachineStatus_Phase.DELETED);
  }
  await reader.close();
  reader = undefined;
  for (const s of sessions.splice(0)) await s.close();
  await stop(runner.child);
  for (let i = 0; i < 100 && leftovers(); i++) await delay(100);
  assert.equal(leftovers(), "", "a QEMU or another process of this test's runner is left");
  console.log(`ok: V13 on berth vm (${accel}, probes within ${probeMs} ms): two machines at once kept apart: (a) placeholders, (b) LANs, (c) a flood from each, mirrored`);
} finally {
  await reader?.close().catch(() => {});
  await Promise.allSettled(sessions.map(s => s.close()));
  await stop(runner.child);
  await gateway.stop();
  await decider.close();
  github.close();
  store.close();
  fs.rmSync(leases, { recursive: true, force: true });
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
