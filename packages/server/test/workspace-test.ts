/** Offline Workspace checks: the shared contract over a fake runner, both in
 * process and through the HTTP routes, plus the lease across processes. The
 * same contract runs against the real runner in smoke-node-adapter.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { RunnerWorkspace, WorkspaceError } from "../src/workspace.ts";
import { HttpWorkspace } from "../src/workspace-http.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { FakeRunner } from "./workspace-fake-runner.ts";
import { serveWorkspace, workspaceContract } from "./workspace-contract.ts";

if (process.argv[2] === "hold") {
  // Child: hold a lease until killed.
  const lease = new LeaseStore(process.argv[3]).acquire("pi");
  process.send!({ epoch: lease.epoch });
  setInterval(() => {}, 1000);
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-workspace-"));
  const runners: FakeRunner[] = [];
  const stores: LeaseStore[] = [];
  const open = (name: string, owner: "pi" | "claude-code" = "pi") => {
    fs.mkdirSync(path.join(root, name, "workspace"), { recursive: true });
    const runner = new FakeRunner(path.join(root, name, "workspace"));
    const leases = new LeaseStore(path.join(root, name, "thread"));
    runners.push(runner); stores.push(leases);
    return { runner, leases, workspace: new RunnerWorkspace({ runner, leases, owner }) };
  };
  try {
    await workspaceContract("RunnerWorkspace", open("direct").workspace, "pi");
    const served = await serveWorkspace(open("http", "claude-code").workspace);
    try { await workspaceContract("HttpWorkspace -> routes -> RunnerWorkspace", new HttpWorkspace({ url: served.url }), "claude-code"); }
    finally { await served.close(); }

    // The routes are a thin transport: the token is the authorization.
    const routed = open("routes", "claude-code");
    const server = await serveWorkspace(routed.workspace);
    try {
      const noToken = await fetch(`${server.url}/stat?path=.`);
      assert.equal(noToken.status, 401);
      assert.equal((await noToken.json()).code, "LEASE_STALE");
      const lease = await (await fetch(`${server.url}/lease`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: "claude-code" }) })).json();
      assert.ok(lease.expiresAt > Date.now(), "remote holders always heartbeat");
      assert.equal((await fetch(`${server.url}/nonsense`, { headers: { authorization: `Bearer ${lease.token}` } })).status, 404);
      const bad = await fetch(`${server.url}/file`, { method: "PUT", headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "k", path: "a", content: "not base64!" }) });
      assert.equal(bad.status, 400);
      const reachable = new HttpWorkspace({ url: "http://127.0.0.1:1/workspace" });
      await assert.rejects(reachable.writeFile(lease.token, "k", "a", Buffer.from("x")), (error: unknown) =>
        error instanceof WorkspaceError && error.code === "NODE_UNAVAILABLE" && error.completionUnknown);
    } finally { await server.close(); }

    // A runner without the workspace capabilities is incompatible: no fallback.
    const old = open("old");
    old.runner.capabilities = old.runner.capabilities.filter(capability => capability !== "fs.write");
    const oldLease = await old.workspace.lease({ owner: "pi" });
    await assert.rejects(old.workspace.writeFile(oldLease.token, "k", "a", Buffer.from("x")), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "OPERATION_UNSUPPORTED");
    assert.ok(!fs.existsSync(path.join(old.runner.root, "a")));

    // One writable owner across processes and instances; process death
    // releases the lease at once and the next holder gets a newer epoch.
    const directory = path.join(root, "shared");
    const child = fork(import.meta.filename, ["hold", directory], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const [{ epoch: childEpoch }] = await once(child, "message") as [{ epoch: number }];
    const contender = new LeaseStore(directory);
    stores.push(contender);
    assert.throws(() => contender.acquire("pi"), (error: unknown) => error instanceof WorkspaceError && error.code === "LEASE_HELD");
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    const taken = contender.acquire("pi");
    assert.ok(taken.epoch > childEpoch);
    const sibling = new LeaseStore(directory);
    stores.push(sibling);
    assert.throws(() => sibling.acquire("pi"), (error: unknown) => error instanceof WorkspaceError && error.code === "LEASE_HELD", "a second instance in the same process is refused");
    contender.release(taken.token);
    const next = sibling.acquire("pi");
    assert.ok(next.epoch > taken.epoch);
    sibling.release(next.token);
    assert.throws(() => sibling.acquire("claude-code"), (error: unknown) => error instanceof WorkspaceError && error.code === "CONFLICT", "the owner is fixed for the thread");
    console.log("ok: workspace lease across processes and instances, routes, incompatible runner");
  } finally {
    for (const runner of runners) runner.close();
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
