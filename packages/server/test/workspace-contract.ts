/** The one Workspace contract suite. It runs against VmWorkspace and
 * against HttpWorkspace -> routes -> VmWorkspace, offline over the guest
 * helper under a temporary root (workspace-test.ts) and over a real VM
 * through the runner and the gateway (smoke-node-adapter.ts). */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceRoute } from "../src/workspace-http.ts";
import { settleOperation, WORKSPACE_CAPABILITIES, WorkspaceError, type Workspace, type WorkspaceOwner } from "../src/workspace.ts";

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof WorkspaceError, `expected WorkspaceError ${expected}, got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  return true;
};

export async function workspaceContract(name: string, workspace: Workspace, owner: WorkspaceOwner): Promise<void> {
  const other: WorkspaceOwner = owner === "pi" ? "claude-code" : "pi";
  // Guest journals keep every key and file; keep each run's identities fresh.
  const run = `contract-${randomUUID()}`;
  const dir = run;
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

  // capabilities and limits
  const capabilities = await workspace.capabilities();
  for (const capability of WORKSPACE_CAPABILITIES) assert.ok(capabilities.includes(capability), `${name}: ${capability}`);
  const limits = await workspace.limits();
  for (const key of ["maxCommandBytes", "maxPathBytes", "maxExecTimeoutMs", "maxOutputBytes", "outputPageBytes", "maxReadBytes", "maxWriteBytes"] as const) {
    assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0, `${name}: limit ${key}`);
  }
  assert.ok(limits.maxExecTimeoutMs > 60000, "commands may run longer than 60 seconds");

  // lease conflict, renewal, release and the epoch
  await assert.rejects(workspace.lease({ owner: other }), code("CONFLICT"), "the agent is fixed for the thread");
  await assert.rejects(workspace.lease({ owner, ttlMs: 10 }), code("INVALID_REQUEST"));
  const first = await workspace.lease({ owner });
  assert.equal(first.owner, owner);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(first.epoch) && first.epoch >= 1);
  await assert.rejects(workspace.lease({ owner }), code("LEASE_HELD"), "one writable owner");
  for (const token of ["0".repeat(64), "not-a-token", ""]) {
    await assert.rejects(workspace.stat(token, "."), code("LEASE_STALE"));
    await assert.rejects(workspace.writeFile(token, `${run}-forged`, `${dir}/forged`, Buffer.from("x"), { createParents: true }), code("LEASE_STALE"));
  }
  const renewed = await workspace.lease({ token: first.token });
  assert.equal(renewed.epoch, first.epoch);
  assert.equal(renewed.token, first.token);
  await workspace.release(first.token);
  await assert.rejects(workspace.release(first.token), code("LEASE_STALE"));
  await assert.rejects(workspace.exec(first.token, `${run}-released`, { command: "touch must-not-run", timeoutMs: 1000 }), code("LEASE_STALE"));
  const timed = await workspace.lease({ owner, ttlMs: 1000 });
  assert.ok(timed.epoch > first.epoch, "every new holder gets a newer epoch");
  assert.ok(typeof timed.expiresAt === "number" && timed.expiresAt > Date.now());
  await delay(1200);
  await assert.rejects(workspace.stat(timed.token, "."), code("LEASE_STALE"), "a missed heartbeat ends the lease");
  await assert.rejects(workspace.lease({ token: timed.token }), code("LEASE_STALE"));
  const lease = await workspace.lease({ owner });
  assert.ok(lease.epoch > timed.epoch);
  const token = lease.token;

  try {
    // files, repeated keys and expectedSha
    const path = `${dir}/notes/a.txt`;
    const written = await workspace.writeFile(token, `${run}-w1`, path, Buffer.from("hello\n"), { createParents: true });
    assert.equal(written.size, 6);
    const read = await workspace.readFile(token, path);
    assert.equal(text(read.content), "hello\n");
    assert.equal(read.sha256, written.sha256);
    assert.equal(read.eof, true);
    const part = await workspace.readFile(token, path, { offset: 1, limit: 3 });
    assert.equal(text(part.content), "ell");
    assert.equal(part.size, 6);
    const stat = await workspace.stat(token, path);
    assert.equal(stat.kind, "file");
    assert.equal(stat.sha256, written.sha256);
    const changed = await workspace.writeFile(token, `${run}-w2`, path, Buffer.from("changed\n"), { expectedSha: written.sha256 });
    assert.deepEqual(await workspace.writeFile(token, `${run}-w1`, path, Buffer.from("hello\n"), { createParents: true }), written, "a repeated key returns the original result");
    assert.equal(text((await workspace.readFile(token, path)).content), "changed\n", "a repeated key is never executed again");
    await assert.rejects(workspace.writeFile(token, `${run}-w1`, path, Buffer.from("other\n"), { createParents: true }), code("CONFLICT"));
    await assert.rejects(workspace.writeFile(token, `${run}-w3`, path, Buffer.from("stale\n"), { expectedSha: written.sha256 }), code("PRECONDITION_FAILED"));
    await assert.rejects(workspace.writeFile(token, `${run}-w3`, path, Buffer.from("stale\n"), { expectedSha: written.sha256 }), code("PRECONDITION_FAILED"), "a failed key replays its failure");
    await workspace.writeFile(token, `${run}-w4`, path, Buffer.from("edited\n"), { expectedSha: changed.sha256 });
    assert.equal(text((await workspace.readFile(token, path)).content), "edited\n");

    // paths outside the workspace
    for (const outside of ["../outside", `${dir}/../../outside`, "/etc/passwd"]) {
      await assert.rejects(workspace.readFile(token, outside), code("INVALID_REQUEST"), outside);
      await assert.rejects(workspace.stat(token, outside), code("INVALID_REQUEST"), outside);
      await assert.rejects(workspace.writeFile(token, `${run}-outside`, outside, Buffer.from("x")), code("INVALID_REQUEST"), outside);
    }
    await assert.rejects(workspace.exec(token, `${run}-cwd`, { command: "touch must-not-run", cwd: "..", timeoutMs: 1000 }), code("INVALID_REQUEST"));
    await assert.rejects(workspace.stat(token, `${dir}/missing`), code("NOT_FOUND"));
    await assert.rejects(workspace.readFile(token, `${dir}/missing`), code("NOT_FOUND"));

    // limits
    await assert.rejects(workspace.writeFile(token, `${run}-big`, `${dir}/big`, Buffer.alloc(limits.maxWriteBytes + 1)), code("INVALID_REQUEST"));
    await assert.rejects(workspace.readFile(token, path, { limit: limits.maxReadBytes + 1 }), code("INVALID_REQUEST"));
    await assert.rejects(workspace.exec(token, `${run}-slow`, { command: "true", timeoutMs: limits.maxExecTimeoutMs + 1 }), code("INVALID_REQUEST"));
    await assert.rejects(workspace.exec(token, `${run}-long`, { command: "x".repeat(limits.maxCommandBytes + 1), timeoutMs: 1000 }), code("INVALID_REQUEST"));
    await assert.rejects(workspace.exec(token, "bad key", { command: "true", timeoutMs: 1000 }), code("INVALID_REQUEST"));

    // exec under a key, repeated key, paged output
    const spec = { command: `printf once >> ${dir}/count; printf hello`, timeoutMs: 10000 };
    await workspace.exec(token, `${run}-e1`, spec);
    const result = await settleOperation(workspace, token, `${run}-e1`);
    assert.equal(result.state, "succeeded");
    assert.ok(result.state === "succeeded");
    assert.equal(text(result.output), "hello");
    assert.equal(result.exitCode, 0);
    const again = await workspace.exec(token, `${run}-e1`, spec);
    assert.equal(again.state, "succeeded");
    assert.equal(text((await workspace.readFile(token, `${dir}/count`)).content), "once", "a repeated key never runs again");
    await assert.rejects(workspace.exec(token, `${run}-e1`, { ...spec, command: "touch must-not-run" }), code("CONFLICT"));
    await assert.rejects(workspace.exec(token, `${run}-w1`, spec), code("CONFLICT"), "a write key cannot become a command");
    await assert.rejects(workspace.operation(token, `${run}-never`), code("NOT_FOUND"));
    await assert.rejects(workspace.stat(token, "must-not-run"), code("NOT_FOUND"));
    const bytes = 150000;
    await workspace.exec(token, `${run}-paged`, { command: `head -c ${bytes} /dev/zero | tr '\\0' b`, timeoutMs: 10000 });
    const paged = await settleOperation(workspace, token, `${run}-paged`);
    assert.ok(paged.state === "succeeded");
    assert.equal(paged.output.length, bytes);
    assert.ok(paged.output.every(byte => byte === 98));
    const page = await workspace.operation(token, `${run}-paged`, { cursor: limits.outputPageBytes });
    assert.ok(page.state === "succeeded" && page.outputOffset === limits.outputPageBytes);

    // real cancellation
    await workspace.exec(token, `${run}-cancel`, { command: `sleep 30; touch ${dir}/not-cancelled`, timeoutMs: limits.maxExecTimeoutMs });
    await workspace.cancel(token, `${run}-cancel`);
    const cancelled = await settleOperation(workspace, token, `${run}-cancel`, { intervalMs: 50 });
    assert.deepEqual(cancelled, { key: `${run}-cancel`, state: "failed", error: "CANCELLED", completionUnknown: false });
    await assert.rejects(workspace.stat(token, `${dir}/not-cancelled`), code("NOT_FOUND"));
  } finally {
    await workspace.release(token);
  }
  console.log(`ok: workspace contract (${name}): lease conflict and expiry, repeated key, expectedSha, cancel, limits, paths outside the workspace`);
}

/** A bare HTTP server over the workspace routes, as cubed mounts them. */
export async function serveWorkspace(workspace: Workspace): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    assert.equal(parts.shift(), "workspace");
    const result = await workspaceRoute(workspace, { method: request.method!, parts, query: url.searchParams, headers: request.headers, body: raw ? JSON.parse(raw) : {} });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/workspace`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
