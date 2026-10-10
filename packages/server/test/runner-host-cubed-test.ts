/** cubed with a real `cube-runner host` (protocol 4) beside a protocol-3
 * pool: enrollment, OptChat's spawn naming the host runner, the thread's
 * checkout and hooks in a directory on this host, a thread started without
 * a runner never landing there, a pinned thread waiting while its runner
 * is down, and archive keeping the directory. The protocol-3 runner is a
 * local guest (no VM); the host runner is real, on loopback, unsandboxed,
 * in a temporary directory.
 *
 *   node packages/server/test/runner-host-cubed-test.ts target/debug/cube-runner */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { describeRunners, observeRunners } from "../src/runner-observe.ts";
import { enrollRunner } from "../src/runner-enroll.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { ProtocolMachines, runnerHealth } from "../src/runner-select.ts";
import { LocalMachines } from "./local-guest.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/cube-runner");
assert.ok(fs.existsSync(binary), `${binary}: build cube-runner first`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-host-cubed-"));
const directory = path.join(root, "host");
const state = path.join(root, "state");
const node = "node-host-e2e";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const repository = path.join(root, "repo");
fs.mkdirSync(path.join(repository, ".agents"), { recursive: true });
git(repository, ["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "demo\n");
fs.writeFileSync(path.join(repository, ".agents", "setup"), "#!/bin/sh\necho setup ran in \"$PWD\"\n", { mode: 0o755 });
git(repository, ["add", "-A"]);
git(repository, ["commit", "-qm", "base"]);

let listen = "127.0.0.1:0";
async function start(first: boolean): Promise<{ child: ChildProcess; peer: string; address: string }> {
  const args = ["host", "--dir", directory, "--listen", listen, ...(first ? ["--allow-peer", control.peerId, "--node-id", node] : [])];
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child.once("exit", code => reject(new Error(`cube-runner host exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  return { child, peer: field("peer"), address: field("listen").split(", ")[0]! };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await once(child, "exit");
}

let runner = await start(true);
// The same address after a restart: the enrolled config names it.
listen = runner.address;
const configPath = path.join(root, "host-runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 7 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const local = new LocalMachines(path.join(root, "local"));
const app = await createCubed({ state, models, claude: null, gateway: null,
  machines: (registry, threads) => new ProtocolMachines({ registry, p3: local, p4: new RunnerMachines({ registry, threads }) }) });
try {
  // enrollment: the host runner by its hello; a protocol-3 pool runner beside it
  const enrolled = await enrollRunner({ state, configPath });
  assert.equal(enrolled.profile, "host-runner");
  assert.equal(enrolled.maxActiveVms, 8);
  assert.match(enrolled.next, /by name/);
  app.registry.enrollRunner({ nodeId: "node-pool", environmentId: 1, threadId: "runner-pool", configPath: "/private/pool.json", configHash: "pool", maxActiveVms: 4 });
  const admitted = app.registry.getRunner(node)!;
  assert.equal(admitted.protocol, 4);
  assert.equal(admitted.kind, "host");
  const health = await runnerHealth(admitted);
  assert.equal(health.protocolVersion, 4);
  assert.equal(health.kind, "host");
  assert.equal(health.maxActiveVms, 8);
  app.registry.recordRunnerProbe(node, { health });
  const overview = describeRunners(observeRunners(app.registry, 60_000));
  assert.match(overview, /HOST runner \(cube-runner host, protocol 4\): UNSANDBOXED/);
  assert.match(overview, /pool: 4 of 4 slots free across 1 runners/, "a host runner is not in the pool");

  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await fetch(`${url}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const project = (await (await fetch(`${url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "terra", repositories: [{ url: repository, base: "main" }] }) })).json() as { project: { id: string; status: string } }).project;
  assert.equal(project.status, "ready");
  const threads = cubeThreads({ registry: app.registry, conversations: app.conversations,
    catalog: async () => [{ provider: faux.getModel().provider, id: faux.getModel().id }],
    runners: () => observeRunners(app.registry, 60_000),
    latestCommits: async () => {
      const current = app.registry.getProject(project.id)!;
      return { projectRevision: current.revision, repositories: current.repositories.map(r => ({ url: r.url, base: r.resolvedBase!, baseOid: r.baseOid! })) };
    } });
  const until = async (what: string, check: () => boolean, ms = 60000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await delay(100);
    }
  };

  // spawn naming the host runner: the thread is there, pinned, and its machine is a directory
  const hosted = await threads.spawn({ project: "terra", task: "say hi", runner: node }, "req-host");
  const thread = app.registry.getThread(hosted.id)!;
  assert.equal(thread.runnerId, node);
  assert.equal(thread.pinned, true);
  await until("the host thread's machine is ready", () => app.registry.getThread(hosted.id)?.workspaceState === "available");
  const machine = path.join(directory, thread.vm!.vmId);
  assert.equal(fs.readFileSync(path.join(machine, "workspace", "README"), "utf8"), "demo\n", "the pinned commit is checked out in DIRECTORY/<id>/workspace");
  assert.match(fs.readFileSync(path.join(machine, "logs", "setup.log"), "utf8"), new RegExp(`setup ran in ${fs.realpathSync(machine)}/workspace`));
  assert.match(fs.readFileSync(path.join(machine, "logs", "setup.status"), "utf8"), /^ok /);
  const steps = app.registry.getThread(hosted.id)!.vm!.steps!.map(step => `${step.name}:${step.state}`);
  assert.ok(steps.includes("boot:ok") && steps.includes("prepare:ok") && steps.includes("resume:ok"), steps.join(", "));

  // spawn without a runner: the pool, never the host runner
  const pooled = await threads.spawn({ project: "terra", task: "pool" }, "req-pool");
  assert.equal(app.registry.getThread(pooled.id)!.runnerId, "runner-pool");
  assert.equal(app.registry.getThread(pooled.id)!.pinned, undefined);
  await assert.rejects(threads.spawn({ project: "terra", task: "x", runner: "node-missing" }, "req-missing"), /no runner node-missing/);

  // the host runner stops: a new thread named to it waits, and stays there
  await stop(runner.child);
  const waiting = await threads.spawn({ project: "terra", task: "wait", runner: node }, "req-wait");
  await until("the thread waits for its runner", () => /waiting for runner node-host-e2e: it does not answer/.test(app.conversations.waiting(waiting.id) ?? ""));
  assert.equal(app.registry.getThread(waiting.id)!.runnerId, node, "a pinned thread never moves");
  runner = await start(false);
  void app.conversations.activate(waiting.id);
  await until("the waiting thread starts once its runner is back", () => app.registry.getThread(waiting.id)?.workspaceState === "available");

  // archive: the host runner keeps the directory, so the machine is retained
  let archived: { ok?: boolean; retained?: boolean; error?: string } = {};
  for (let tries = 0; tries < 100 && !archived.ok; tries++) {
    archived = await (await fetch(`${url}/api/threads/${hosted.id}`, { method: "DELETE" })).json() as typeof archived;
    if (!archived.ok) await delay(200);
  }
  assert.equal(archived.retained, true, JSON.stringify(archived));
  assert.ok(fs.existsSync(path.join(machine, "workspace", "README")), "archive never deletes a host machine's directory");
  console.log("ok: cubed with cube-runner host: enrollment, spawn by runner name, checkout and hooks in the host directory, pool threads elsewhere, a pinned thread waits, archive retains");
} finally {
  app.server.closeAllConnections();
  await app.close();
  await local.close();
  await stop(runner.child);
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  fs.rmSync(root, { recursive: true, force: true });
}
