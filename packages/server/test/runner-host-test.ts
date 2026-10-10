/** Runner protocol 4 against the real `berth host`: cubed's
 * RunnerSession (one Iroh connection, call, watch and guest streams) and the
 * Workspace contract over RunnerGuestTransport into a host machine, which is
 * a directory under a temporary DIRECTORY on this host. Loopback only; the
 * machine is this host, unsandboxed, as the user running the test.
 *
 *   node packages/server/test/runner-host-test.ts target/debug/berth */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Code, MachineStatus_Phase, Runner_Kind } from "../src/gen/runner_pb.js";
import { RunnerError, RunnerSession, loadSessionConfig } from "../src/runner-session.ts";
import { GuestTransportError } from "../src/guest-ssh.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { workspaceContract } from "./workspace-contract.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-host-runner-"));
const directory = path.join(root, "machines");
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };

async function start(args: string[]): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["host", "--dir", directory, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child.once("exit", code => reject(new Error(`berth host exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  return { child, peer: field("peer"), address: field("listen").split(", ")[0]!, banner };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await once(child, "exit");
}

const node = "node-host-test";
let runner = await start(["--allow-peer", control.peerId, "--node-id", node, "--listen", "127.0.0.1:0", "--labels", "site=test"]);
const sessions: RunnerSession[] = [];
try {
  assert.match(runner.banner, /UNSANDBOXED/, "the runner says it is no sandbox");
  assert.match(runner.peer, /^[0-9a-f]{64}$/);
  const configPath = path.join(root, "runner.json");
  const writeConfig = (address: string, peer: string) => fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4,
    binding: { nodeId: node, threadId: node, environmentId: 1 }, controlKey, serverPeer: peer, network: "loopback", address }), { mode: 0o600 });
  writeConfig(runner.address, runner.peer);
  const open = () => { const session = new RunnerSession(loadSessionConfig(configPath).config); sessions.push(session); return session; };
  let session = open();

  // hello: everything about the runner, without a call of its own
  const hello = await session.hello();
  assert.equal(hello.protocol, 4);
  assert.equal(hello.runner?.kind, Runner_Kind.HOST);
  assert.equal(hello.runner?.nodeId, node);
  assert.equal(hello.runner?.platform?.os, process.platform === "darwin" ? "macos" : "linux");
  assert.equal(hello.runner?.platform?.accelerator, "none");
  assert.deepEqual(hello.runner?.labels, { site: "test" });
  assert.equal(hello.runner?.limits?.maxMachines, 8);
  assert.ok(hello.capabilities.includes("guest") && hello.capabilities.includes("watch"));

  // a wrong node id is refused at hello
  const wrongPath = path.join(root, "wrong.json");
  fs.writeFileSync(wrongPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: "node-other", threadId: "x", environmentId: 1 },
    controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });
  const wrong = new RunnerSession(loadSessionConfig(wrongPath).config);
  sessions.push(wrong);
  await assert.rejects(wrong.hello(), (error: unknown) => error instanceof RunnerError && error.code === "PERMISSION_DENIED" && error.reason === "wrong_node");

  // create, and readiness from the watch: the runner asks the guest itself
  const ref = { owner: "thread-1", id: randomBytes(8).toString("hex") };
  let epoch = Date.now();
  const created = await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) }, spec: { source: { case: "base", value: true } } } });
  assert.equal(created.status?.phase, MachineStatus_Phase.RUNNING);
  const machineDir = path.join(directory, ref.id);
  assert.ok(fs.statSync(path.join(machineDir, "bin", "cube-guest")).isFile(), "the machine gets the runner's helper");
  const ready = await session.until(ref, machine => machine.status?.guest?.ready === true, 30000);
  const guestInfo = ready.status!.guest!;
  assert.equal(guestInfo.connected, true);
  assert.match(guestInfo.build, /^[0-9a-f]{64}$/);
  assert.equal(guestInfo.os, process.platform === "darwin" ? "macos" : "linux");
  assert.equal(guestInfo.bootId, ready.status!.bootId, "the runner's run is the host machine's boot");
  assert.ok(guestInfo.capabilities.includes("fs.absolute"));
  assert.equal(guestInfo.limits?.maxReadBytes, 524288, "the helper's limits reach status.guest");
  // the same create again changes nothing; another owner may not take the id
  assert.equal((await session.machine({ case: "machineCreate", value: { ref, fence: { epoch: BigInt(epoch) } } })).ref?.id, ref.id);
  await assert.rejects(session.call({ case: "machineCreate", value: { ref: { owner: "thread-2", id: ref.id }, fence: { epoch: BigInt(epoch) } } }),
    (error: unknown) => error instanceof RunnerError && error.code === "ALREADY_EXISTS");

  // the Workspace contract over the guest stream, in the host machine
  const transport = session.guest(ref, () => epoch);
  const leases = new LeaseStore(path.join(root, "thread"));
  const workspace = new VmWorkspace({ guest: transport, leases, owner: "pi", binding: `host-${ref.id}` });
  const scratch = path.join(root, "scratch");
  await workspaceContract("VmWorkspace -> RunnerGuestTransport -> berth host", workspace, "pi",
    { machinePaths: run => [path.join(scratch, run, "portal-runtime", "start-portal.sh"), path.join(scratch, run, "screens", "shot.png")] });
  assert.ok(fs.readdirSync(path.join(machineDir, "workspace")).some(name => name.startsWith("contract-")), "the workspace is DIRECTORY/<id>/workspace");

  // a command runs as this user, with this user's environment
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.execOwn(lease.token, "host-env", { command: "id -un; printf '%s\\n' \"$HOME\" \"$CUBE_LOGS\"; command -v cube", timeoutMs: 10000 });
    const { settleOperation } = await import("../src/workspace.ts");
    const state = await settleOperation(workspace, lease.token, "host-env");
    assert.ok(state.state === "succeeded");
    const [user, home, logs, cube] = Buffer.from(state.output).toString("utf8").trim().split("\n");
    assert.equal(user, os.userInfo().username);
    assert.equal(home, os.homedir());
    assert.equal(logs, path.join(fs.realpathSync(machineDir), "logs"));
    assert.equal(cube, path.join(fs.realpathSync(machineDir), "bin", "cube"));
  } finally { await workspace.release(lease.token); }

  // fencing: an older epoch than the newest is refused, as a transport failure
  epoch += 10;
  await session.call({ case: "machineStart", value: { ref, fence: { epoch: BigInt(epoch) } } });
  await assert.rejects(session.guest(ref, () => epoch - 5).call("hello", {}), (error: unknown) =>
    error instanceof GuestTransportError && /stale_epoch|newer epoch/.test(error.message));

  // what a host runner does not do
  const unsupported: Array<Parameters<RunnerSession["call"]>[0]> = [{ case: "templateList", value: {} },
    { case: "machineDiscard", value: { ref, fence: { epoch: BigInt(epoch) } } }, { case: "machineDiagnose", value: { ref } }];
  for (const verb of unsupported) {
    await assert.rejects(session.call(verb), (error: unknown) => error instanceof RunnerError && error.code === "UNIMPLEMENTED", verb.case);
  }
  assert.equal(Code.UNIMPLEMENTED, 8);

  // a runner restart is a new boot; the machine is still there
  const firstBoot = ready.status!.bootId;
  await stop(runner.child);
  runner = await start(["--listen", "127.0.0.1:0"]);
  writeConfig(runner.address, runner.peer);
  session = open();
  const again = await session.until(ref, machine => machine.status?.guest?.ready === true && machine.status.bootId !== firstBoot, 30000);
  assert.equal(again.fenceEpoch, BigInt(epoch), "the fence survives a restart");
  assert.equal(again.status?.guest?.bootId, again.status?.bootId);
  assert.equal(again.status?.guest?.epoch, BigInt(lease.epoch), "status.guest has the newest lease epoch the guest saw");

  // delete keeps the directory: the machine is retained
  const deleted = await session.machine({ case: "machineDelete", value: { ref, fence: { epoch: BigInt(epoch) }, retain: false } });
  assert.equal(deleted.status?.phase, MachineStatus_Phase.RETAINED);
  assert.ok(fs.existsSync(path.join(machineDir, "workspace")), "a host runner never deletes a machine directory");
  await assert.rejects(session.guest(ref, () => epoch).call("hello", {}), GuestTransportError);
  console.log("ok: berth host over protocol 4: hello, watch readiness, create, Workspace contract, user environment, fencing, UNIMPLEMENTED, restart, retained delete");
} finally {
  await Promise.allSettled(sessions.map(session => session.close()));
  await stop(runner.child);
  // Commands the machine started run in their own process groups.
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
