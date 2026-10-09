/** What a thread shows while its machine starts, through the product API:
 * the steps (`vm.steps` in /api/threads), a preparation try the kernel's OOM
 * killer stopped (its error, memory and the end of its log), the next try
 * after it, the log of the hook running now (/api/threads/<id>/startup-log,
 * read without a lease), the diagnostics text, and a project's machine size
 * (validated, captured by its new threads). Real cubed and local guests, faux
 * model, disposable state; ThreadVms's own steps (lookup, build, boot) run
 * in vm-prepare-test.ts and scripts/test-vm-templates.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { StartupStep } from "../src/registry.ts";
import { formatDiagnostics } from "../src/vm-diagnostics.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-startup-steps-"));
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const repository = path.join(root, "repo");
fs.mkdirSync(repository);
git(repository, ["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "demo\n");
git(repository, ["add", "-A"]);
git(repository, ["commit", "-qm", "base"]);

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 50 }, () => () => fauxAssistantMessage("thread done")));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: null, gateway: null });
app.registry.enrollRunner({ nodeId: "node-steps", environmentId: 1, threadId: "runner-steps", configPath: "/private/steps.json", configHash: "steps", maxActiveVms: 2 });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const send = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
};
async function until<T>(read: () => Promise<T> | T, check: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + 90_000; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${String(JSON.stringify(value)).slice(0, 2000)}`);
    await delay(50);
  }
  return value;
}

try {
  // The first try stands in for a unit the OOM killer stopped: the local
  // guest's cgroup files say so and the hook kills its process group. The
  // second waits for the test, so its log can be read while it runs.
  const preSetup = [
    "if [ ! -e ../once ]; then touch ../once; mkdir -p ../cgroup; echo 3758096384 > ../cgroup/memory.peak",
    "  printf 'oom 1\\noom_kill 1\\n' > ../cgroup/memory.events; echo 'MemTotal: 4013504 kB' > ../meminfo",
    "  echo 'building the services'; echo 'token=hunter2'; kill -9 0; fi",
    "rm -rf ../cgroup; echo 'second try: waiting'; while [ ! -e ../go ]; do sleep 0.05; done; echo 'second try: done'",
  ].join("\n");

  // A project's machine size: validated, read back with cubed's defaults.
  const created = await send("/api/projects", { name: "steps", repositories: [{ url: repository, base: "main" }], hooks: { preSetup }, machine: { memoryMiB: 512 } });
  assert.equal(created.status, 409);
  assert.match(created.json.error, /machine\.memoryMiB must be a whole number from 1024 to 262144/);
  const project = (await send("/api/projects", { name: "steps", repositories: [{ url: repository, base: "main" }], hooks: { preSetup }, machine: { memoryMiB: 8192 } })).json.project;
  assert.equal(project.status, "ready", JSON.stringify(project));
  assert.deepEqual(project.machine, { memoryMiB: 8192 });
  assert.deepEqual(project.machineDefaults, { vcpus: 2, memoryMiB: 4096 });
  const renamed = (await send(`/api/projects/${project.id}`, { name: "steps", repositories: [{ url: repository, base: "main" }], hooks: { preSetup } }, "PUT")).json.project;
  assert.deepEqual(renamed.machine, { memoryMiB: 8192 }, "a save without machine keeps it");
  console.log("ok: a project's machine size is validated, kept when not given, and read back with cubed's defaults");

  const thread = (await send("/api/threads", { projectId: project.id, requestId: "one", text: "hello", model: { provider: faux.getModel().provider, id: faux.getModel().id } })).json;
  const row = async () => ((await send("/api/threads")).json.threads as Array<any>).find(candidate => candidate.id === thread.id);
  assert.deepEqual((await row()).allocation.machine, { memoryMiB: 8192 }, "the thread keeps the size it was created with");
  const steps = async () => ((await row()).vm?.steps ?? []) as StartupStep[];

  // The first try fails, saying why, with the command's memory and its log.
  const first = await until(steps, list => list.some(step => step.name === "prepare" && step.state === "failed"), "the first try fails");
  const failed = first.find(step => step.name === "prepare")!;
  assert.equal(failed.attempt, 1);
  assert.equal(failed.detail, "pre-setup was stopped: the machine ran out of memory (this command used up to 3.5 GB; the machine has 3.8 GB); cube tries again");
  assert.deepEqual(failed.memory, { peakBytes: 3758096384, totalBytes: 4013504 * 1024, oomKills: 1 });
  assert.equal(failed.log, "building the services\ntoken=[redacted]", "the killed hook's log, from the machine, redacted");
  console.log("ok: a try the OOM killer stopped is a failed step with its memory and the end of its log");

  // The next try (the recovery loop's, here at once) runs; its log is read while it runs.
  void app.conversations.activate(thread.id);
  const running = await until(steps, list => list.some(step => step.name === "prepare" && step.attempt === 2 && step.state === "running"), "the second try runs");
  assert.equal(running.at(-1)!.detail, "checkout, pre-setup and .agents/setup");
  const live = await until(async () => (await send(`/api/threads/${thread.id}/startup-log`)).json.log, log => !!log?.text?.includes("waiting"), "the live log");
  assert.deepEqual(live, { machine: "thread", hook: "pre-setup", text: "second try: waiting\n", bytes: 20, truncated: false });
  fs.writeFileSync(path.join(machines.guest(app.registry.getThread(thread.id)!).root, "go"), "");
  await until(async () => (await row()).state, state => state === "ready", "the thread is ready");
  const shown = (await steps()).map(step => `${step.name}${step.attempt ? ` ${step.attempt}` : ""} ${step.state}: ${step.detail}`);
  assert.deepEqual(shown, [
    "prepare 1 failed: pre-setup was stopped: the machine ran out of memory (this command used up to 3.5 GB; the machine has 3.8 GB); cube tries again",
    "prepare 2 ok: pre-setup ok, setup absent",
    "resume ok: pre-resume absent, resume absent",
  ]);
  assert.deepEqual((await send(`/api/threads/${thread.id}/startup-log`)).json.log, { machine: "thread", hook: null, text: "", bytes: 0, truncated: false }, "nothing runs now");
  console.log("ok: the next try runs and its hook's log is read live; the steps read in order");

  // OptChat's diagnose reads the same steps.
  const text = formatDiagnostics((await send(`/api/threads/${thread.id}/diagnostics`)).json.diagnostics);
  assert.match(text, /\n {2}\S+ prepare 1 failed after [\d.]+ s: pre-setup was stopped: the machine ran out of memory .*; memory peak 3\.5 of 3\.8 GiB, 1 process killed for want of memory\n/);
  assert.match(text, /\npreparation tries: 2\n/);
  console.log("ok: diagnostics show the steps, the memory and the tries");
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("startup steps: ok");
