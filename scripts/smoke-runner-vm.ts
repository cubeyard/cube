// Runner acceptance with a real guest: the real cube-runner (protocol 3),
// the real cube-gateway and a Debian genericcloud VM under QEMU/KVM, all
// over Iroh loopback. No mocks; disposable state under $TMPDIR (/tmp); every process
// this script starts is stopped. An allow-all decision server stands in for
// cubed's egress policy (cubed's side is the SERVER work package).
//
//   node scripts/smoke-runner-vm.ts <cube-runner> <cube-gateway> <image.qcow2>
//
// Set CUBE_SMOKE_KEEP=1 to keep the work directory for inspection.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

const [runnerBin, gatewayBin, image] = process.argv.slice(2).map((p) => path.resolve(p));
if (!runnerBin || !gatewayBin || !image) throw new Error("usage: smoke-runner-vm.ts <cube-runner> <cube-gateway> <image.qcow2>");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-rvm-"));
fs.chmodSync(work, 0o700);
const run = path.join(work, "run");
fs.mkdirSync(run, { mode: 0o700 });
const node = "node-smoke";
const children: ChildProcess[] = [];
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

function start(file: string, args: string[], name: string, stdin: "pipe" | "ignore" = "ignore"): ChildProcess {
  const child = spawn(file, args, { stdio: [stdin, "pipe", "pipe"] });
  const out = fs.createWriteStream(path.join(work, `${name}.log`), { flags: "a" });
  child.stderr!.pipe(out);
  children.push(child);
  return child;
}

async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  const lines = readline.createInterface({ input: child.stdout! });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`process exited (${code}) before its ready line`)));
  });
  return JSON.parse(line);
}

function unixRequest(socket: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, method, path: url, headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

const keygen = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;

let runnerReady: Record<string, any> = {};
function call(request: Record<string, unknown>, expectError = false): any {
  try {
    const out = execFileSync(runnerBin, ["call", "--key", path.join(work, "control.key"), "--peer", runnerReady.peerId,
      "--address", runnerReady.addresses[0], "--expect-node", node, "--request", JSON.stringify(request)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const response = JSON.parse(out);
    assert.equal(expectError, false, `expected an error for ${request.method}, got ${out}`);
    return response;
  } catch (error: any) {
    if (!expectError || !error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}
const vmCall = (request: Record<string, unknown>) => call(request).vm;

async function startRunner(): Promise<ChildProcess> {
  // One machine: this smoke checks the bound (CAPACITY_EXCEEDED) whatever `auto` gives the host.
  const child = start(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", path.join(work, "state"), "--max-active-vms", "1"], "runner");
  runnerReady = await firstLine(child);
  return child;
}

function ssh(command: string, args: { timeout?: number } = {}): string {
  return execFileSync("ssh", ["-F", "none", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", path.join(work, "id_client"),
    "-o", `UserKnownHostsFile=${path.join(work, "known_hosts")}`, "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=cube-vm-${vmId}`,
    "-o", `ProxyCommand=${gatewayBin} dial --control ${path.join(run, "gateway.sock")} --vm ${vmId} --port 22`,
    "-o", "ConnectTimeout=20", "-o", "LogLevel=ERROR", "cube@cube-vm", command], { encoding: "utf8", timeout: (args.timeout ?? 60) * 1000 });
}

const vmId = randomBytes(8).toString("hex");
const otherVm = randomBytes(8).toString("hex");
const mac = "02:" + createHash("sha256").update(vmId).digest().subarray(0, 5).toString("hex").match(/../g)!.join(":");
const thread = "t-smoke";
const token = () => randomBytes(32).toString("hex");

try {
  // Allow-all decision server (cubed's policy is not part of this smoke).
  const decided: string[] = [];
  const decide = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => { decided.push(JSON.parse(body).host); response.end('{"allow":true}'); });
  });
  await new Promise<void>((resolve) => decide.listen(path.join(run, "egress.sock"), resolve));

  const gateway = start(gatewayBin, ["serve", "--state", path.join(work, "gateway"), "--control", path.join(run, "gateway.sock"),
    "--decide", path.join(run, "egress.sock"), "--network", "loopback"], "gateway", "pipe");
  const gatewayReady = await firstLine(gateway);
  const gatewayPeer = gatewayReady.peer as string;
  const hello = await unixRequest(path.join(run, "gateway.sock"), "GET", "/v1/hello");
  const caPem: string = hello.json.caPem;
  log(`gateway ${gatewayPeer.slice(0, 12)} ready`);

  const control = keygen(path.join(work, "control.key"));
  keygen(path.join(work, "runner.key"));
  const init = JSON.parse(execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", path.join(work, "state"),
    "--image", image, "--allow-peer", control, "--node-id", node, "--thread-id", "t-install", "--env", "1",
    "--max-vcpus", "2", "--max-memory-mib", "2048", "--max-disk-gib", "16"], { encoding: "utf8" }));
  log(`runner initialized, base image ${init.baseImageSha256.slice(0, 12)}`);
  let runner = await startRunner();
  assert.equal(runnerReady.protocolVersion, 3);
  assert.equal(runnerReady.lifecycle, "ready");
  const runnerHello = JSON.parse(execFileSync(runnerBin, ["hello", "--key", path.join(work, "control.key"), "--peer", runnerReady.peerId,
    "--address", runnerReady.addresses[0], "--expect-node", node], { encoding: "utf8" }));
  assert.deepEqual(runnerHello.capabilities, ["node.hello", "node.status", "vm.allocate", "vm.start", "vm.stop", "vm.inspect", "vm.release", "vm.discard",
    "vm.publish", "template.list", "template.remove", "vm.diagnose"]);
  assert.equal(runnerHello.baseImageSha256, init.baseImageSha256);

  // Guest identity: cubed generates and pins the host key (SERVER does this for real).
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(work, "id_client")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(work, "host_ed25519")]);
  const hostPub = fs.readFileSync(path.join(work, "host_ed25519.pub"), "utf8").trim();
  fs.writeFileSync(path.join(work, "known_hosts"), `cube-vm-${vmId} ${hostPub.split(" ").slice(0, 2).join(" ")}\n`);
  const indent = (text: string, spaces: number) => text.trimEnd().split("\n").map((line) => " ".repeat(spaces) + line).join("\n");
  const userData = `#cloud-config
ssh_pwauth: false
users:
  - name: cube
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: [${JSON.stringify(fs.readFileSync(path.join(work, "id_client.pub"), "utf8").trim())}]
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
${indent(fs.readFileSync(path.join(work, "host_ed25519"), "utf8"), 4)}
  ed25519_public: ${hostPub}
ca_certs:
  trusted:
    - |
${indent(caPem, 6)}
`;
  const seed = { metaData: `instance-id: ${vmId}\nlocal-hostname: cube-${vmId.slice(0, 8)}\n`, userData,
    networkConfig: "version: 2\nethernets:\n  nic:\n    match: {name: \"e*\"}\n    dhcp4: true\n" };
  assert.ok(!userData.includes(fs.readFileSync(path.join(work, "control.key")).toString("hex")));

  // Allocation: idempotent, bounded.
  const allocate = { method: "vm.allocate", threadId: thread, vmId, epoch: 1, diskGiB: 8 };
  const allocated = vmCall(allocate);
  assert.equal(allocated.state, "allocated");
  assert.deepEqual(vmCall(allocate), allocated);
  assert.equal(call({ ...allocate, diskGiB: 9 }, true).code, "CONFLICT");
  assert.equal(call({ method: "vm.allocate", threadId: "t-other", vmId: otherVm, epoch: 1, diskGiB: 8 }, true).code, "CAPACITY_EXCEEDED");

  // Boot from the FAT seed; the gateway dials the runner for frames.
  let frameToken = token();
  const startRequest = (epoch: number, frame: string) => ({ method: "vm.start", threadId: thread, vmId, epoch, vcpus: 2, memoryMiB: 2048, mac, seed,
    gateway: { peer: gatewayPeer, frameToken: frame } });
  const attach = (frame: string, vm = vmId, runnerPeer = runnerReady.peerId, socket = path.join(run, "gateway.sock")) =>
    unixRequest(socket, "PUT", `/v1/vms/${vm}`, { threadId: thread, runner: { peer: runnerPeer, network: "loopback", address: runnerReady.addresses[0] }, frameToken: frame, mac });
  const vmStatus = async (vm = vmId, socket = path.join(run, "gateway.sock")) => (await unixRequest(socket, "GET", `/v1/vms/${vm}`)).json;
  let record = vmCall(startRequest(1, frameToken));
  assert.ok(["starting", "running"].includes(record.state), JSON.stringify(record));
  assert.equal(call({ method: "vm.stop", threadId: thread, vmId, epoch: 0 }, true).code, "INVALID_REQUEST");
  assert.equal((await attach(frameToken)).status < 300, true);
  const leased = await until("a DHCP lease through the pump", 240, async () => ((await vmStatus()).leased ? true : undefined));
  log(`guest leased ${(await vmStatus()).guestIp}`);
  const consoleTail = await until("cloud-init to finish (console)", 420, () => {
    const inspected = call({ method: "vm.inspect", threadId: thread, vmId });
    return /Cloud-init v\. .* finished at/.test(inspected.consoleTail ?? "") ? inspected.consoleTail as string : undefined;
  });
  assert.ok(leased);
  log(`cloud-init finished: ${consoleTail.match(/Cloud-init v\. .* finished at[^\n]*/)![0].trim()}`);
  // The self-updater's idle check reads the journal the running runner owns.
  const busy = JSON.parse(execFileSync(runnerBin, ["idle", "--state", path.join(work, "state")], { encoding: "utf8" }));
  assert.deepEqual(busy, { activeVms: 1, idle: false });
  await until("sshd through cube-gateway dial", 120, () => { try { return ssh("echo ready").trim() === "ready" ? true : undefined; } catch { return undefined; } });
  ssh("echo kept-on-disk > ~/marker && sync");
  log("ssh through the gateway works; host key pinned");

  // Frame channel authorization with the real gateway.
  await attach(token());
  const wrongToken = await until("wrong token refused", 30, async () => {
    const status = await vmStatus();
    return status.link !== "up" && /frame token does not match/.test(status.lastError ?? "") ? status.lastError : undefined;
  });
  await attach(token(), otherVm);
  const wrongVm = await until("wrong vm refused", 30, async () => {
    const status = await vmStatus(otherVm);
    return /no running vm/.test(status.lastError ?? "") ? status.lastError : undefined;
  });
  await unixRequest(path.join(run, "gateway.sock"), "DELETE", `/v1/vms/${otherVm}`);
  const rogue = start(gatewayBin, ["serve", "--state", path.join(work, "rogue"), "--control", path.join(run, "rogue.sock"),
    "--decide", path.join(run, "egress.sock"), "--network", "loopback"], "rogue", "pipe");
  await firstLine(rogue);
  await attach(frameToken, vmId, runnerReady.peerId, path.join(run, "rogue.sock"));
  const wrongPeer = await until("foreign gateway refused", 30, async () => {
    const status = await vmStatus(vmId, path.join(run, "rogue.sock"));
    return status.link !== "up" && status.lastError ? status.lastError : undefined;
  });
  rogue.stdin!.end();
  log(`refused: token (${wrongToken}); vm (${wrongVm}); peer (${wrongPeer})`);
  await attach(frameToken);
  await until("link back up with the right token", 30, async () => ((await vmStatus()).link === "up" ? true : undefined));

  // A newer start rotates the token and drops the old frame connection.
  const oldToken = frameToken;
  frameToken = token();
  record = vmCall(startRequest(2, frameToken));
  assert.equal(record.state, "running");
  await until("old frame connection dropped", 30, async () => ((await vmStatus()).link !== "up" ? true : undefined));
  await attach(oldToken);
  await until("old token refused after rotation", 30, async () => (/frame token does not match/.test((await vmStatus()).lastError ?? "") ? true : undefined));
  await attach(frameToken);
  await until("link up with the new token", 30, async () => ((await vmStatus()).link === "up" ? true : undefined));
  assert.equal(ssh("cat ~/marker").trim(), "kept-on-disk");
  log("token rotation dropped the old channel; ssh back");

  // Socket check: during guest traffic the runner holds only UDP (Iroh) and unix sockets.
  let traffic = "skipped (no upstream internet)";
  const transfer = spawn("ssh", ["-F", "none", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", path.join(work, "id_client"),
    "-o", `UserKnownHostsFile=${path.join(work, "known_hosts")}`, "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=cube-vm-${vmId}`,
    "-o", `ProxyCommand=${gatewayBin} dial --control ${path.join(run, "gateway.sock")} --vm ${vmId} --port 22`, "-o", "LogLevel=ERROR",
    "cube@cube-vm", `curl -sS -m 90 -o /dev/null -w '%{http_code} %{size_download} %{speed_download}\\n' ${process.env.CUBE_SMOKE_DOWNLOAD ?? "https://nbg1-speed.hetzner.com/100MB.bin"} || true`],
  { stdio: ["ignore", "pipe", "pipe"] });
  const transferDone = new Promise((resolve) => transfer.once("exit", resolve));
  let transferOut = "";
  transfer.stdout!.on("data", (chunk) => (transferOut += chunk));
  transfer.stderr!.on("data", (chunk) => (transferOut += chunk));
  let exited = false;
  void transferDone.then(() => (exited = true));
  const kinds = new Set<string>();
  let samples = 0;
  let sockets: string[] = [];
  do {
    sockets = execFileSync("ss", ["-H", "-tuxanp"], { encoding: "utf8" }).split("\n").filter((line) => line.includes(`pid=${runner.pid},`));
    for (const line of sockets) kinds.add(line.split(/\s+/)[0]);
    samples++;
    await sleep(500);
  } while (!exited);
  assert.ok(kinds.size > 0, "ss shows the runner's sockets");
  for (const kind of kinds) assert.ok(["udp", "u_dgr", "u_str", "u_seq"].includes(kind), `runner holds a ${kind} socket: ${sockets.join("\n")}`);
  if (!/^200 /m.test(transferOut)) log(`guest download did not succeed: ${transferOut.trim()}`);
  if (/^200 /m.test(transferOut)) traffic = transferOut.trim().split("\n").filter((l) => l.startsWith("200 ")).map((l) => `${(Number(l.split(" ")[2]) / 1e6).toFixed(1)} MB/s`).join(", ");
  log(`runner sockets during guest traffic (${samples} samples): ${[...kinds].join(", ")}; download ${traffic}`);

  // Runner SIGKILL: QEMU goes with it (PDEATHSIG); restart records stopped/interrupted.
  const qemuPid = () => { try { return execFileSync("pgrep", ["-f", `guest=${vmId}`], { encoding: "utf8" }).trim(); } catch { return ""; } };
  assert.ok(qemuPid(), "qemu is running");
  runner.kill("SIGKILL");
  await until("qemu gone after runner SIGKILL", 15, () => (qemuPid() ? undefined : true));
  runner = await startRunner();
  record = call({ method: "vm.inspect", threadId: thread, vmId }).vm;
  assert.equal(record.state, "stopped");
  assert.equal(record.interrupted, true);
  log("runner SIGKILL: qemu gone, restart recorded stopped/interrupted");
  frameToken = token();
  record = vmCall(startRequest(3, frameToken));
  assert.ok(["starting", "running"].includes(record.state));
  await attach(frameToken);
  await until("lease after reboot", 240, async () => ((await vmStatus()).link === "up" && (await vmStatus()).leased ? true : undefined));
  await until("sshd after reboot", 240, () => { try { return ssh("cat ~/marker").trim() === "kept-on-disk" ? true : undefined; } catch { return undefined; } });
  record = call({ method: "vm.inspect", threadId: thread, vmId }).vm;
  assert.equal(record.interrupted, false);
  log("the same disk booted again; /home/cube/marker intact");
  assert.equal(call({ method: "vm.stop", threadId: thread, vmId, epoch: 2 }, true).code, "LEASE_STALE");

  // Stop powers the guest down; release keeps or deletes the disk.
  vmCall({ method: "vm.stop", threadId: thread, vmId, epoch: 3 });
  record = await until("guest power-down", 60, () => { const vm = call({ method: "vm.inspect", threadId: thread, vmId }).vm; return vm.state === "stopped" ? vm : undefined; });
  assert.equal(record.interrupted, false, "ACPI power-down was clean");
  vmCall({ method: "vm.release", threadId: thread, vmId, epoch: 3, retain: true });
  record = await until("retained", 30, () => { const vm = call({ method: "vm.inspect", threadId: thread, vmId }).vm; return vm.state === "retained" ? vm : undefined; });
  assert.ok(fs.existsSync(path.join(work, "state/vms/1/disk.qcow2")));
  let status = call({ method: "node.status" }).status;
  assert.equal(status.retainedVms, 1);
  assert.ok(status.retainedBytes > 0);
  assert.equal(status.activeVms, 0);
  vmCall({ method: "vm.allocate", threadId: "t-other", vmId: otherVm, epoch: 1, diskGiB: 8 });
  assert.ok(fs.existsSync(path.join(work, "state/vms/2/disk.qcow2")));
  vmCall({ method: "vm.release", threadId: "t-other", vmId: otherVm, epoch: 1, retain: false });
  record = call({ method: "vm.inspect", threadId: "t-other", vmId: otherVm }).vm;
  assert.equal(record.state, "released");
  assert.equal(fs.existsSync(path.join(work, "state/vms/2")), false, "retain:false deletes the vm directory");
  status = call({ method: "node.status" }).status;
  assert.equal(status.retainedVms, 1);
  log(`release: retained ${(status.retainedBytes / 1e6).toFixed(0)} MB kept, clean release deleted`);
  assert.deepEqual(JSON.parse(execFileSync(runnerBin, ["idle", "--state", path.join(work, "state")], { encoding: "utf8" })),
    { activeVms: 0, idle: true }, "released machines leave the runner idle for self-update");
  assert.ok(decided.length > 0 || traffic.startsWith("skipped"), "guest https went through the decision server");

  runner.kill("SIGTERM");
  await new Promise((resolve) => runner.once("exit", resolve));
  console.log(`smoke-runner-vm: PASS in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} catch (error) {
  console.error("smoke-runner-vm: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  }
  await sleep(1500);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { execFileSync("pkill", ["-f", `guest=${vmId}`]); } catch { /* none left */ }
  if (process.env.CUBE_SMOKE_KEEP === "1") console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
