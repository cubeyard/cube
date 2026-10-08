/** Offline Workspace checks: the shared contract over VmWorkspace and the
 * real guest helper under a temporary root (local guest), both in process and
 * through the HTTP routes, plus the lease across processes. The same contract
 * runs against a real VM in smoke-node-adapter.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { WorkspaceError } from "../src/workspace.ts";
import { HttpWorkspace } from "../src/workspace-http.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import type { GuestTransport } from "../src/guest-ssh.ts";
import { LocalGuestTransport } from "./local-guest.ts";
import { serveWorkspace, workspaceContract } from "./workspace-contract.ts";

if (process.argv[2] === "hold") {
  // Child: hold a lease until killed.
  // Keep the store referenced: a collected lock connection would end the lease.
  const store = new LeaseStore(process.argv[3]);
  const lease = store.acquire("pi");
  process.send!({ epoch: lease.epoch });
  setInterval(() => store.holder(), 1000);
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-workspace-"));
  const guests: LocalGuestTransport[] = [];
  const stores: LeaseStore[] = [];
  const open = (name: string, owner: "pi" | "claude-code" = "pi", wrap?: (guest: GuestTransport) => GuestTransport) => {
    const guest = new LocalGuestTransport(path.join(root, name, "guest"));
    const leases = new LeaseStore(path.join(root, name, "thread"));
    guests.push(guest); stores.push(leases);
    return { guest, leases, workspace: new VmWorkspace({ guest: wrap ? wrap(guest) : guest, leases, owner, binding: `test-${name}`, retryMs: name === "gone" ? 3000 : 5000 }) };
  };
  try {
    await workspaceContract("VmWorkspace", open("direct").workspace, "pi");
    const served = await serveWorkspace(open("http", "claude-code").workspace);
    try { await workspaceContract("HttpWorkspace -> routes -> VmWorkspace", new HttpWorkspace({ url: served.url }), "claude-code"); }
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

    // A guest without the workspace capabilities is incompatible: no fallback.
    const old = open("old", "pi", guest => ({
      close: () => guest.close(),
      call: async (op, header, options) => {
        const answer = await guest.call(op, header, options);
        if (op === "hello") answer.header.capabilities = (answer.header.capabilities as string[]).filter(capability => capability !== "fs.write");
        return answer;
      },
    }));
    const oldLease = await old.workspace.lease({ owner: "pi" });
    await assert.rejects(old.workspace.writeFile(oldLease.token, "k", "a", Buffer.from("x")), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "OPERATION_UNSUPPORTED");
    assert.ok(!fs.existsSync(path.join(old.guest.workspace, "a")));
    // A helper from before absolute paths is asked for none; cubed updates it on attach.
    const older = open("older", "pi", guest => ({
      close: () => guest.close(),
      call: async (op, header, options) => {
        if (op !== "hello" && typeof header.path === "string" && header.path.startsWith("/")) throw new Error(`${op} ${header.path} reached the helper`);
        const answer = await guest.call(op, header, options);
        if (op === "hello") answer.header.capabilities = (answer.header.capabilities as string[]).filter(capability => capability !== "fs.absolute");
        return answer;
      },
    }));
    const olderLease = await older.workspace.lease({ owner: "pi" });
    await assert.rejects(older.workspace.writeFile(olderLease.token, "k", "/tmp/a", Buffer.from("x"), { createParents: true }), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "OPERATION_UNSUPPORTED" && /fs\.absolute/.test(error.message));
    await assert.rejects(older.workspace.readFile(olderLease.token, "/tmp/a"), (error: unknown) => error instanceof WorkspaceError && error.code === "OPERATION_UNSUPPORTED");
    assert.equal((await older.workspace.writeFile(olderLease.token, "k2", "a", Buffer.from("x"))).size, 1, "workspace paths still work");

    // Each thread's lease reaches only its own machine: another thread's
    // token is refused there, and a machine path lands in the writer's machine.
    const mine = open("mine"), theirs = open("theirs");
    const myLease = await mine.workspace.lease({ owner: "pi" });
    const theirLease = await theirs.workspace.lease({ owner: "pi" });
    await mine.workspace.writeFile(myLease.token, "m", "/home/agent/portal-runtime/start-portal.sh", Buffer.from("mine"), { createParents: true });
    for (const attempt of [
      () => theirs.workspace.readFile(myLease.token, "/home/agent/portal-runtime/start-portal.sh"),
      () => theirs.workspace.writeFile(myLease.token, "t", "/home/agent/portal-runtime/start-portal.sh", Buffer.from("stolen"), { createParents: true }),
      () => theirs.workspace.stat(myLease.token, "/tmp"),
    ]) await assert.rejects(attempt(), (error: unknown) => error instanceof WorkspaceError && error.code === "LEASE_STALE");
    assert.equal(fs.readFileSync(path.join(mine.guest.root, "home/agent/portal-runtime/start-portal.sh"), "utf8"), "mine");
    assert.ok(!fs.existsSync(path.join(theirs.guest.root, "home/agent/portal-runtime")), "nothing reached the other machine");
    await assert.rejects(theirs.workspace.readFile(theirLease.token, "/home/agent/portal-runtime/start-portal.sh"), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "NOT_FOUND", "the other machine has its own /home/agent");
    // Its own links into the other machine's (or the host's) files lead nowhere.
    fs.mkdirSync(path.join(theirs.guest.root, "tmp"), { recursive: true });
    fs.symlinkSync(mine.guest.root, path.join(theirs.guest.root, "tmp/neighbour"));
    await assert.rejects(theirs.workspace.readFile(theirLease.token, "/tmp/neighbour/home/agent/portal-runtime/start-portal.sh"), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "INVALID_REQUEST" && /leaves the machine/.test(error.message));

    // An unreachable machine: a read is unavailable, a mutation's outcome unknown.
    const gone = open("gone");
    const goneLease = await gone.workspace.lease({ owner: "pi" });
    await gone.workspace.capabilities();
    gone.guest.offline = true;
    await assert.rejects(gone.workspace.stat(goneLease.token, "."), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "NODE_UNAVAILABLE" && !error.completionUnknown);
    await assert.rejects(gone.workspace.writeFile(goneLease.token, "k", "a", Buffer.from("x")), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "COMPLETION_UNKNOWN" && error.completionUnknown);
    await assert.rejects(gone.workspace.exec(goneLease.token, "e", { command: "true", timeoutMs: 1000 }), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "COMPLETION_UNKNOWN");
    gone.guest.offline = false;
    assert.ok(!fs.existsSync(path.join(gone.guest.workspace, "a")));
    // A short outage (a gateway restart) is retried: every helper operation is idempotent by key.
    const calls = gone.guest.calls;
    gone.guest.offline = true;
    setTimeout(() => { gone.guest.offline = false; }, 700);
    assert.equal((await gone.workspace.writeFile(goneLease.token, "k2", "b", Buffer.from("y"))).size, 1);
    assert.ok(gone.guest.calls > calls + 1, "the write was retried");
    assert.equal(fs.readFileSync(path.join(gone.guest.workspace, "b"), "utf8"), "y");

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
    console.log("ok: workspace lease across processes and instances, routes, incompatible guest, older helper without absolute paths, thread machines apart, unreachable machine, retried outage");
  } finally {
    for (const guest of guests) guest.stop();
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
