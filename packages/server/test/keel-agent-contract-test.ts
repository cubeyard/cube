/** The Workspace contract (leases, files, commands, services, hooks) against keel's
 * cube-agent in a real keel machine, over protocol 4's DaemonFrame. keel-agent-check
 * (packages/keel/agent-check) boots the machine, applies its setup and runs
 * this file with CUBE_AGENT_BRIDGE: a Unix socket where each connection is
 * one guest operation (`OP\n` + the request bytes, then EOF; the answer is
 * `ok\n` + the agent's bytes, or `error JSON\n` with the agent's refusal, as
 * a runner answers a `guest` stream in `StreamAnswer`). Not offline: it
 * needs QEMU, a keel kernel and base. VmWorkspace and the lease are cubed's
 * own, unchanged. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { decodeGuestAnswer, encodeGuestRequest, GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp, type GuestTransport } from "../src/guest-ssh.ts";
import { resumeWorkspace } from "../src/vm.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { workspaceContract, workspaceServicesContract } from "./workspace-contract.ts";

class BridgeGuestTransport implements GuestTransport {
  readonly socket: string;
  constructor(socket: string) { this.socket = socket; }
  call(op: GuestOp, header: Record<string, unknown>, options: GuestCallOptions = {}): Promise<GuestAnswer> {
    return new Promise((resolve, reject) => {
      const connection = net.connect(this.socket);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { connection.destroy(); reject(new GuestTransportError("the guest did not answer in time")); }, options.timeoutMs ?? 60000);
      connection.on("data", (chunk: Buffer) => chunks.push(chunk));
      connection.on("error", error => { clearTimeout(timer); reject(new GuestTransportError(error.message, { cause: error })); });
      connection.on("end", () => {
        clearTimeout(timer);
        const reply = Buffer.concat(chunks);
        const end = reply.indexOf(10);
        const status = reply.subarray(0, end).toString("utf8");
        if (status === "ok") { try { resolve(decodeGuestAnswer(reply.subarray(end + 1))); } catch (error) { reject(error); } return; }
        reject(new GuestTransportError(`the agent refused: ${status.replace(/^error /, "")}`));
      });
      connection.end(Buffer.concat([Buffer.from(`${op}\n`), encodeGuestRequest(header, options.body)]));
    });
  }
  async close(): Promise<void> {}
}

const socket = process.env.CUBE_AGENT_BRIDGE;
if (!socket) {
  console.error("keel-agent-contract-test: run by keel-agent-check, which sets CUBE_AGENT_BRIDGE");
  process.exit(2);
}
const leases = fs.mkdtempSync(path.join(os.tmpdir(), "keel-agent-contract-"));
const store = new LeaseStore(leases);
try {
  const workspace = new VmWorkspace({ guest: new BridgeGuestTransport(socket), leases: store, owner: "pi", binding: `keel-agent-check:${process.pid}`, retryMs: 2000 });
  await workspaceContract("VmWorkspace -> DaemonFrame -> cube-agent", workspace, "pi");
  await workspaceServicesContract("VmWorkspace -> DaemonFrame -> cube-agent", workspace, workspace, "pi");
  // The hooks: cubed's own resume script, as a command, runs the project's
  // pre-resume hook, which the agent wrote to /etc/cube/hooks from the boot
  // document (keel-agent-check sends one; there is no .agents/resume); once
  // per boot. The agent reports the outcome in hello, as cube-guest does.
  const transport = new BridgeGuestTransport(socket);
  const first = await resumeWorkspace(workspace, "pi");
  const again = await resumeWorkspace(workspace, "pi");
  assert.equal(first.already, false);
  assert.equal(first.hooks["pre-resume"]?.status, "ok", JSON.stringify(first));
  assert.equal(first.hooks.resume?.status, "absent", JSON.stringify(first));
  assert.equal(again.already, true, "the resume hooks run once per boot");
  const hello = await transport.call("hello", {});
  assert.deepEqual(hello.header.hooks, { "pre-resume": "ok", resume: "absent" });
  console.log("ok: hooks (VmWorkspace -> DaemonFrame -> cube-agent): cubed's resume script runs the project's pre-resume hook once per boot; hello reports the outcomes");
} finally {
  store.close();
  fs.rmSync(leases, { recursive: true, force: true });
}
