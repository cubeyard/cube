// cubed's runner adapter with a real guest: the TypeScript protocol-3 client
// (in-process Iroh) against the real cube-runner, cubed's supervision of the
// real cube-gateway, its egress policy, ThreadVms booting a real Debian VM,
// and the Workspace contract over VmWorkspace (system OpenSSH through
// `cube-gateway dial`) in process and through the HTTP routes. Disposable
// state under $TMPDIR (/tmp); every process started is stopped. No model is contacted.
//
//   node scripts/smoke-node-adapter.ts <cube-runner> <cube-gateway> <image.qcow2>
//
// CUBE_SMOKE_KEEP=1 keeps the work directory.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { EgressPolicy, serveEgress, type SecretSource } from "../packages/server/src/egress-policy.ts";
import { GatewaySupervisor } from "../packages/server/src/gateway.ts";
import { IrohNodeError, IrohRunnerClient } from "../packages/server/src/iroh-node.ts";
import { Registry } from "../packages/server/src/registry.ts";
import { ThreadVms, releaseCheck } from "../packages/server/src/vm.ts";
import { VmWorkspace } from "../packages/server/src/vm-workspace.ts";
import { HttpWorkspace } from "../packages/server/src/workspace-http.ts";
import { LeaseStore } from "../packages/server/src/workspace-lease.ts";
import { settleOperation, type Workspace } from "../packages/server/src/workspace.ts";
import { serveWorkspace, workspaceContract } from "../packages/server/test/workspace-contract.ts";

const [runnerBin, gatewayBin, image] = process.argv.slice(2).map(p => path.resolve(p));
if (!runnerBin || !gatewayBin || !image) throw new Error("usage: smoke-node-adapter.ts <cube-runner> <cube-gateway> <image.qcow2>");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-adapter-"));
fs.chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const fakeToken = "ghs_adapter-smoke-fake-token-0123456789";

async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  const lines = readline.createInterface({ input: child.stdout! });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", code => reject(new Error(`process exited (${code}) before its ready line`)));
  });
  return JSON.parse(line);
}
async function startRunner(listen = "127.0.0.1:0"): Promise<{ child: ChildProcess; ready: Record<string, unknown> }> {
  const child = spawn(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"),
    "--listen", listen], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.pipe(fs.createWriteStream(path.join(work, "runner.log"), { flags: "a" }));
  children.push(child);
  return { child, ready: await firstLine(child) };
}
async function run(workspace: Workspace, token: string, key: string, command: string): Promise<{ code: number | null; output: string }> {
  await workspace.exec(token, key, { command, timeoutMs: 120000 });
  const state = await settleOperation(workspace, token, key);
  assert.equal(state.state, "succeeded", JSON.stringify(state));
  if (state.state !== "succeeded") throw new Error("unreachable");
  return { code: state.exitCode, output: Buffer.from(state.output).toString("utf8").trim() };
}

let gateway: GatewaySupervisor | undefined;
let vms: ThreadVms | undefined;
let egress: { close(): Promise<void> } | undefined;
let registry: Registry | undefined;
let runner: ChildProcess | undefined;
try {
  const peerOf = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;
  const controlPeer = peerOf(path.join(work, "control.key"));
  peerOf(path.join(work, "runner.key"));
  execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"), "--image", image,
    "--allow-peer", controlPeer, "--node-id", "node-adapter", "--thread-id", "install-adapter", "--env", "1",
    "--max-vcpus", "2", "--max-memory-mib", "2048", "--max-disk-gib", "16"], { stdio: "ignore" });
  const first = await startRunner();
  runner = first.child;
  fs.writeFileSync(path.join(work, "runner.json"), JSON.stringify({ version: 2, binding: { nodeId: "node-adapter", threadId: "install-adapter", environmentId: 1 },
    controlKey: path.join(work, "control.key"), serverPeer: first.ready.peerId, address: (first.ready.addresses as string[])[0], network: "loopback" }), { mode: 0o600 });

  // The protocol-3 client in process: hello, status, a version-1 config refused.
  const client = new IrohRunnerClient({ configPath: path.join(work, "runner.json") });
  const described = await client.describe();
  assert.deepEqual(described.capabilities, ["node.hello", "node.status", "vm.allocate", "vm.start", "vm.stop", "vm.inspect", "vm.release", "vm.discard"]);
  assert.match(described.baseImageSha256, /^[0-9a-f]{64}$/);
  assert.equal(described.platform, "linux-x86_64");
  assert.equal((await client.health()).activeVms, 0);
  fs.writeFileSync(path.join(work, "v1.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(work, "runner.json"), "utf8")), version: 1, intentDirectory: work }), { mode: 0o600 });
  assert.throws(() => new IrohRunnerClient({ configPath: path.join(work, "v1.json") }), /re-enroll the runner/);
  await assert.rejects(client.vmInspect({ threadId: "t-none", vmId: "0000000000000000" }), (error: unknown) => error instanceof IrohNodeError && error.code === "NOT_FOUND");
  log(`runner ${described.softwareVersion} on ${described.platform}; protocol-3 client ok`);

  // cubed's side: registry, egress policy, supervised gateway, thread VMs.
  const state = path.join(work, "cubed");
  const runDir = path.join(state, "run");
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  registry = new Registry(path.join(state, "registry.sqlite"));
  registry.saveProject({ id: "empty", name: "empty", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ ...client.binding, configPath: path.join(work, "runner.json"), configHash: client.configHash });
  const github: SecretSource = { name: "github", hosts: ["github.com", "api.github.com"], value: async () => fakeToken };
  const decisions: string[] = [];
  const policy = new EgressPolicy({ vms: { vm: vmId => { const thread = registry!.threadByVm(vmId); return thread?.vm ? { threadId: thread.id, placeholders: thread.vm.placeholders } : null; } },
    secrets: [github], log: { ...quiet, info: (msg: string, fields?: object) => decisions.push(`${msg} ${JSON.stringify(fields)}`) } });
  egress = await serveEgress(path.join(runDir, "egress.sock"), policy);
  gateway = new GatewaySupervisor({ state: path.join(state, "gateway"), control: path.join(runDir, "gateway.sock"), decide: path.join(runDir, "egress.sock"),
    network: "loopback", binary: gatewayBin, log: quiet });
  gateway.start();
  const { hello } = await gateway.ready();
  log(`gateway ${hello.version} ready, peer ${hello.peer.slice(0, 12)}`);
  vms = new ThreadVms({ registry, threads: path.join(state, "threads"), run: runDir, gateway, sizes: { vcpus: 2, memoryMiB: 2048, diskGiB: 8 }, log: quiet });
  const thread = registry.createThread("empty", "adapter", { provider: "faux", id: "faux" }, "adapter smoke");
  await vms.start(thread);
  log("thread machine booted; guest helper ready over ssh through the gateway");
  if (process.env.CUBE_SMOKE_PAUSE) {
    // Debugging: run commands in the guest through the workspace while this file exists.
    const pause = process.env.CUBE_SMOKE_PAUSE;
    const debug = new VmWorkspace({ guest: vms.guest(thread), leases: new LeaseStore(path.join(work, "lease-debug")), owner: "pi", binding: "adapter:debug" });
    const debugLease = await debug.lease({ owner: "pi" });
    fs.writeFileSync(pause, "");
    let index = 0;
    while (fs.existsSync(pause)) {
      const command = fs.readFileSync(pause, "utf8").trim();
      if (command) {
        fs.writeFileSync(pause, "");
        try { fs.writeFileSync(`${pause}.out`, (await run(debug, debugLease.token, `debug-${index++}`, command)).output); }
        catch (error) { fs.writeFileSync(`${pause}.out`, String(error)); }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await debug.release(debugLease.token);
  }
  assert.equal((await client.health()).activeVms, 1);

  // The Workspace contract over the real VM, in process and over HTTP.
  const workspace = (name: string) => new VmWorkspace({ guest: vms!.guest(thread), leases: new LeaseStore(path.join(work, `lease-${name}`)), owner: "pi", binding: `adapter:${name}` });
  await workspaceContract("real VM: VmWorkspace", workspace("direct"), "pi");
  const served = await serveWorkspace(workspace("http"));
  try { await workspaceContract("real VM: HttpWorkspace -> routes -> VmWorkspace", new HttpWorkspace({ url: served.url }), "pi"); }
  finally { await served.close(); }

  // Egress from the guest: only HTTP/HTTPS to public addresses, decided by cubed.
  const probes = workspace("probes");
  const lease = await probes.lease({ owner: "pi" });
  const whoami = await run(probes, lease.token, "whoami", "id -un; pwd; test -n \"$GH_TOKEN\" && echo placeholder-set");
  assert.equal(whoami.output, "agent\n/workspace\nplaceholder-set", "commands run as agent in /workspace with the placeholder");
  const status = (url: string, extra = "") => `curl -s -o /dev/null -m 15 ${extra} -w '%{http_code}' ${url} || true`;
  const internet = (await run(probes, lease.token, "public", status("https://example.com/"))).output;
  if (internet === "200") log("guest https://example.com: 200 through interception");
  else log(`NOTICE: guest https://example.com answered ${internet || "nothing"} (no upstream internet?); public egress unverified here`);
  for (const [key, url] of [["gateway-ip", "http://10.77.0.1/"], ["metadata", "http://169.254.169.254/"], ["lan", "http://192.168.0.1/"], ["loopback-host", "http://127.0.0.1.nip.io/"]]) {
    const answer = (await run(probes, lease.token, `deny-${key}`, status(url))).output;
    assert.ok(answer === "403" || answer === "000", `${url} must not be reached from the guest (got ${answer})`);
  }
  const ssh = await run(probes, lease.token, "tcp-22", "timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/22' 2>/dev/null && echo open || echo refused");
  assert.equal(ssh.output, "refused", "TCP other than 80/443 is refused");
  const misuse = await run(probes, lease.token, "placeholder-elsewhere", status("https://example.com/", "-H \"Authorization: Bearer $GH_TOKEN\""));
  assert.ok(misuse.output === "403" || internet !== "200", `the GitHub placeholder sent to example.com is denied (got ${misuse.output})`);
  if (internet === "200") assert.ok(decisions.some(line => line.includes("not allowed for example.com")), decisions.join("\n"));
  log("egress: gateway, metadata, LAN and port 22 refused; a placeholder sent elsewhere denied");

  // Runner SIGKILL: QEMU goes with it; the next start boots the same disk.
  await run(probes, lease.token, "marker", "echo kept > marker && sync");
  await probes.release(lease.token);
  runner!.kill("SIGKILL");
  await new Promise(resolve => runner!.once("exit", resolve));
  // The same address: the runner config names it.
  runner = (await startRunner((first.ready.addresses as string[])[0])).child;
  const record = (await client.vmInspect({ threadId: thread.id, vmId: thread.vm!.vmId })).vm;
  assert.equal(record.state, "stopped");
  assert.equal(record.interrupted, true);
  await vms.start(thread);
  const again = workspace("after-kill");
  const after = await again.lease({ owner: "pi" });
  assert.equal(Buffer.from((await again.readFile(after.token, "marker")).content).toString(), "kept\n", "/workspace survived the runner SIGKILL");
  await again.release(after.token);
  log("runner SIGKILL: machine interrupted, booted again from the same disk");

  // Archive: the release check sees the changed workspace; the disk is retained.
  const check = await releaseCheck(workspace("release"), "pi", thread.allocation);
  assert.equal(check.clean, false);
  assert.match(check.reason, /not empty/);
  assert.deepEqual(await vms.release(thread, true), { retained: true });
  const health = await client.health();
  assert.equal(health.activeVms, 0);
  assert.equal(health.retainedVms, 1);
  log(`archive: release check "${check.reason}", disk retained (${(health.retainedBytes / 1e6).toFixed(0)} MB)`);
  console.log(`smoke-node-adapter: PASS in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} catch (error) {
  console.error("smoke-node-adapter: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  await vms?.close();
  await gateway?.stop();
  await egress?.close();
  registry?.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 2000));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (process.env.CUBE_SMOKE_KEEP === "1") console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
