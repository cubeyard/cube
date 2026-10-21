/** The one Workspace contract suite. It runs against VmWorkspace and
 * against HttpWorkspace -> routes -> VmWorkspace, offline over the guest
 * helper under a temporary root (workspace-test.ts); the same Workspace runs
 * over a real `berth host` in runner-host-test.ts. */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceRoute } from "../src/workspace-http.ts";
import { settleOperation, WORKSPACE_CAPABILITIES, WorkspaceError, type Workspace, type WorkspaceLimits, type WorkspaceOwner } from "../src/workspace.ts";
import type { GuestPortal, GuestService } from "../src/vm-workspace.ts";

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof WorkspaceError, `expected WorkspaceError ${expected}, got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  return true;
};

/** `machinePaths(run)`: absolute paths outside the workspace that the
 * agent may write (default: a VM's /home/agent and /tmp). */
export async function workspaceContract(name: string, workspace: Workspace, owner: WorkspaceOwner,
  options: { machinePaths?: (run: string) => string[] } = {}): Promise<void> {
  // Guest journals keep every key and file; keep each run's identities fresh.
  const run = `contract-${randomUUID()}`;
  const dir = run;
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

  // capabilities and limits
  const capabilities = await workspace.capabilities();
  for (const capability of WORKSPACE_CAPABILITIES) assert.ok(capabilities.includes(capability), `${name}: ${capability}`);
  const limits = await checkLimits(name, workspace);
  const token = await leaseContract(workspace, owner, run, dir);

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

    // paths: never with `..`; a relative one is in the workspace, an absolute
    // one anywhere in the thread's machine but its kernel and device filesystems
    for (const outside of ["../outside", `${dir}/../../outside`, "/tmp/../etc/passwd"]) {
      await assert.rejects(workspace.readFile(token, outside), code("INVALID_REQUEST"), outside);
      await assert.rejects(workspace.stat(token, outside), code("INVALID_REQUEST"), outside);
      await assert.rejects(workspace.writeFile(token, `${run}-outside`, outside, Buffer.from("x")), code("INVALID_REQUEST"), outside);
    }
    assert.ok(capabilities.includes("fs.absolute"), `${name}: fs.absolute`);
    await workspace.writeFile(token, `${run}-abs`, `/workspace/${dir}/abs.txt`, Buffer.from("abs\n"));
    assert.equal(text((await workspace.readFile(token, `${dir}/abs.txt`)).content), "abs\n", "/workspace is the workspace");
    for (const machine of options.machinePaths?.(run) ?? [`/home/agent/${run}/portal-runtime/start-portal.sh`, `/tmp/${run}/screens/shot.png`]) {
      const placed = await workspace.writeFile(token, `${run}-m1-${machine}`, machine, Buffer.from("machine\n"), { createParents: true });
      assert.equal(text((await workspace.readFile(token, machine)).content), "machine\n", machine);
      assert.equal((await workspace.stat(token, machine)).sha256, placed.sha256, machine);
      await workspace.writeFile(token, `${run}-m2-${machine}`, machine, Buffer.from("edited\n"), { expectedSha: placed.sha256 });
      await assert.rejects(workspace.writeFile(token, `${run}-m3-${machine}`, machine, Buffer.from("stale\n"), { expectedSha: placed.sha256 }), code("PRECONDITION_FAILED"), machine);
      assert.equal(text((await workspace.readFile(token, machine)).content), "edited\n", machine);
    }
    await assert.rejects(workspace.readFile(token, `/tmp/${run}/missing`), code("NOT_FOUND"));
    for (const pseudo of ["/proc/self/status", "/sys/kernel/hostname", "/dev/null"]) {
      await assert.rejects(workspace.readFile(token, pseudo), code("INVALID_REQUEST"), pseudo);
      await assert.rejects(workspace.writeFile(token, `${run}-pseudo-${pseudo}`, pseudo, Buffer.from("x")), code("INVALID_REQUEST"), pseudo);
    }
    await assert.rejects(workspace.stat(token, `${dir}/missing`), code("NOT_FOUND"));
    await assert.rejects(workspace.readFile(token, `${dir}/missing`), code("NOT_FOUND"));

    // limits
    await assert.rejects(workspace.writeFile(token, `${run}-big`, `${dir}/big`, Buffer.alloc(limits.maxWriteBytes + 1)), code("INVALID_REQUEST"));
    await assert.rejects(workspace.readFile(token, path, { limit: limits.maxReadBytes + 1 }), code("INVALID_REQUEST"));
    await execContract(workspace, token, run, dir, limits, {
      read: async path => text((await workspace.readFile(token, path)).content),
      missing: async path => { await assert.rejects(workspace.stat(token, path), code("NOT_FOUND"), path); },
      writeKey: `${run}-w1`,
    });
  } finally {
    await workspace.release(token);
  }
  console.log(`ok: workspace contract (${name}): lease conflict and expiry, repeated key, expectedSha, cancel, limits, workspace and machine paths`);
}

async function checkLimits(name: string, workspace: Workspace): Promise<WorkspaceLimits> {
  const limits = await workspace.limits();
  for (const key of ["maxCommandBytes", "maxPathBytes", "maxExecTimeoutMs", "maxOutputBytes", "outputPageBytes", "maxReadBytes", "maxWriteBytes"] as const) {
    assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0, `${name}: limit ${key}`);
  }
  assert.ok(limits.maxExecTimeoutMs > 60000, "commands may run longer than 60 seconds");
  return limits;
}

/** Lease conflict, renewal, release and the epoch; returns a held lease's token. */
async function leaseContract(workspace: Workspace, owner: WorkspaceOwner, run: string, dir: string): Promise<string> {
  const other: WorkspaceOwner = owner === "pi" ? "claude-code" : "pi";
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
  return token;
}

/** How the exec part reads a workspace file's text and checks that a path
 * does not exist. `writeKey` is a key a file write used. */
interface ContractFiles { read(path: string): Promise<string>; missing(path: string): Promise<void>; writeKey?: string }

/** Commands: cwd, limits, a key that runs once, paged output, real cancellation. */
async function execContract(workspace: Workspace, token: string, run: string, dir: string, limits: WorkspaceLimits, files: ContractFiles): Promise<void> {
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
  await assert.rejects(workspace.exec(token, `${run}-cwd`, { command: "touch must-not-run", cwd: "..", timeoutMs: 1000 }), code("INVALID_REQUEST"));
  await assert.rejects(workspace.exec(token, `${run}-cwd-abs`, { command: "touch must-not-run", cwd: "/tmp", timeoutMs: 1000 }), code("INVALID_REQUEST"), "a command's cwd stays in the workspace");
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
  assert.equal(await files.read(`${dir}/count`), "once", "a repeated key never runs again");
  await assert.rejects(workspace.exec(token, `${run}-e1`, { ...spec, command: "touch must-not-run" }), code("CONFLICT"));
  if (files.writeKey) await assert.rejects(workspace.exec(token, files.writeKey, spec), code("CONFLICT"), "a write key cannot become a command");
  await assert.rejects(workspace.operation(token, `${run}-never`), code("NOT_FOUND"));
  await files.missing("must-not-run");
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
  await files.missing(`${dir}/not-cancelled`);
}

/** What cubed reads of a machine's services (VmWorkspace). */
export interface ServiceGuest { services(probe?: boolean): Promise<GuestService[]>; configurePortal(portal: GuestPortal): Promise<void> }

/** A web server in Perl (perl-base is in every Debian image): says where it
 * listens and logs each request line. */
const SERVICE_SCRIPT = `use IO::Socket::INET;
$| = 1;
$SIG{PIPE} = "IGNORE";
my $s = IO::Socket::INET->new(LocalAddr => "$ENV{HOST}:$ENV{PORT}", Listen => 5, ReuseAddr => 1) or die "listen: $!\\n";
print "listening on $ENV{PORT} as $ENV{CUBE_SERVICE}\\n";
while (my $c = $s->accept) {
  my $line = <$c>;
  print "got $line" if defined $line;
  while (my $h = <$c>) { last if $h =~ /^\\r?\\n$/ }
  print $c "HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\nhello from $ENV{CUBE_SERVICE}\\n";
  close $c;
}
`;

/** The service part: `cube service` as the agent runs it in the machine
 * (start, logs, status, open, stop) and what cubed reads of it (`services`,
 * `portal`). `cube` is how a command names the machine's cube command. */
export async function workspaceServicesContract(name: string, workspace: Workspace, guest: ServiceGuest, owner: WorkspaceOwner,
  options: { cube?: string } = {}): Promise<void> {
  const cube = options.cube ?? "cube";
  const run = `services-${randomUUID()}`;
  const service = `c${run.slice(9, 17)}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const template = "http://{name}-0123456789.100-64-0-1.sslip.io:7780/";
  const token = (await workspace.lease({ owner })).token;
  let step = 0;
  const sh = async (command: string) => {
    const key = `${run}-${step++}`;
    await workspace.exec(token, key, { command, timeoutMs: 120000 });
    const result = await settleOperation(workspace, token, key, { intervalMs: 100 });
    assert.ok(result.state === "succeeded", `${command}: ${JSON.stringify(result)}`);
    return { code: result.exitCode, output: Buffer.from(result.output).toString("utf8") };
  };
  const listed = async () => (await guest.services(true)).find(item => item.name === service);
  try {
    await workspace.writeFile(token, `${run}-script`, `${run}/server.pl`, Buffer.from(SERVICE_SCRIPT), { createParents: true });
    await guest.configurePortal({ urlTemplate: template });
    const url = template.replace("{name}", service);

    const started = await sh(`${cube} service start ${service} --port ${port} --cwd ${run} --json -- perl server.pl`);
    assert.equal(started.code, 0, started.output);
    const view = JSON.parse(started.output.trim());
    assert.equal(view.ok, true, started.output);
    assert.equal(view.url, url);
    assert.match(String(view.http), /^HTTP\/1\.0 200/);
    assert.equal(view.kind, "command");
    assert.deepEqual([view.name, view.port, view.command], [service, port, "perl server.pl"]);
    const entry = await listed();
    assert.ok(entry, `${name}: services lists ${service}`);
    assert.deepEqual([entry.port, entry.kind, entry.state, entry.listening, entry.url], [port, "command", "active", true, url]);
    const logs = await sh(`${cube} service logs ${service}`);
    assert.equal(logs.code, 0, logs.output);
    assert.ok(logs.output.includes(`listening on ${port} as ${service}`), logs.output);
    assert.ok(logs.output.includes("got GET / HTTP/1.1"), logs.output);
    const status = JSON.parse((await sh(`${cube} service status ${service} --json`)).output);
    assert.deepEqual([status.state, status.listening], ["active", true]);
    const taken = await sh(`${cube} service start other-${service} --port ${port} -- true`);
    assert.equal(taken.code, 2);
    assert.ok(taken.output.includes(`already service ${service}`), taken.output);

    // A server cube service does not run: registered, not healthy, no logs here.
    const opened = await sh(`${cube} service open x${service} --port ${port + 1} --wait 0 --json`);
    assert.equal(opened.code, 1, opened.output);
    assert.deepEqual([JSON.parse(opened.output).kind, JSON.parse(opened.output).ok], ["external", false]);
    assert.equal((await guest.services()).find(item => item.name === `x${service}`)?.kind, "external");
    assert.equal((await sh(`${cube} service logs x${service}`)).code, 2);
    assert.equal((await sh(`${cube} service stop x${service}`)).output.trim(), `service x${service} stopped`);

    // Without a portal, a service's URL says why.
    await guest.configurePortal({ reason: "this cube installation has no portal" });
    assert.equal((await listed())?.url, null);
    assert.ok((await sh(`${cube} service status ${service}`)).output.includes("url: none (this cube installation has no portal)"));
    await assert.rejects(guest.configurePortal({ urlTemplate: "http://evil/{name}" }), code("INVALID_REQUEST"));

    const stopped = await sh(`${cube} service stop ${service}`);
    assert.deepEqual([stopped.code, stopped.output.trim()], [0, `service ${service} stopped`]);
    assert.equal(await listed(), undefined);
    const closed = await sh(`for i in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null || { echo closed; exit 0; }; sleep 0.1; done; echo open`);
    assert.equal(closed.output.trim(), "closed", "a stopped service no longer listens");
    assert.equal((await sh(`${cube} service stop ${service}`)).output.trim(), `no service ${service}`);
  } finally {
    await workspace.release(token);
  }
  console.log(`ok: services contract (${name}): start, services, logs, status, a taken port, open, portal, stop`);
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
