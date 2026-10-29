/** cubed closed while a thread it accepted is still starting (a SIGTERM or
 * `cube update` just after a POST /api/threads or an OptChat spawn): the
 * start, which nothing awaits, is no failed try and never touches the closed
 * registry; the next cubed starts the thread. Before, the start's error
 * handling read the closed registry ("database is not open") and the
 * unhandled rejection exited cubed 1; one that failed while the close was
 * under way was recorded as a failed try. Real cubed over HTTP, local guests
 * whose start or preparation waits on the test, disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry, type Thread } from "../src/registry.ts";
import type { StartOptions } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-start-close-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const upstream = path.join(root, "upstream");
fs.mkdirSync(upstream);
git(upstream, "init", "-q", "--initial-branch=main");
fs.writeFileSync(path.join(upstream, "README"), "demo\n");
git(upstream, "add", "README");
git(upstream, "commit", "-qm", "base");

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

/** Local guests whose next start waits until the test lets it go (or fails
 * it); `closing` runs at the start of their close, inside cubed's. */
class HeldMachines extends LocalMachines {
  private letGo!: (error?: Error) => void;
  private begun!: () => void;
  readonly started = new Promise<void>(resolve => { this.begun = resolve; });
  private readonly held = new Promise<Error | undefined>(resolve => { this.letGo = resolve; });
  holding = true;
  closing: (() => Promise<void>) | null = null;
  go(error?: Error): void { this.letGo(error); }
  override async start(thread: Thread, options: StartOptions = {}): Promise<{ booted: boolean }> {
    if (this.holding) {
      this.begun();
      const error = await this.held;
      if (error) throw error;
    }
    return super.start(thread, options);
  }
  override async close(): Promise<void> {
    await this.closing?.();
    return super.close();
  }
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  for (const deadline = Date.now() + ms; !check(); await delay(25)) assert.ok(Date.now() < deadline, what);
}

/** A cubed on its own state with one runner and one project, and a thread
 * accepted over HTTP. */
async function accepted(name: string, machines: LocalMachines, hooks?: { preSetup: string }) {
  const state = path.join(root, name);
  const app = await createCubed({ state, models, machines, claude: null, gateway: null });
  app.registry.enrollRunner({ nodeId: `node-${name}`, threadId: `runner-${name}`, environmentId: 1, configPath: `/private/${name}.json`, configHash: name, protocol: 4, kind: "vm" });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  const post = async (route: string, body: unknown) => (await fetch(`http://127.0.0.1:${address.port}${route}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const { project } = await post("/api/projects", { name, repositories: [{ url: upstream }], ...hooks ? { hooks } : {} });
  assert.equal(project.status, "ready", JSON.stringify(project));
  const { id } = await post("/api/threads", { projectId: project.id, requestId: name, text: "hello", model }) as { id: string };
  assert.ok(id, "the thread is accepted");
  return { app, state, id };
}

/** What the closed cubed left: the thread still starting, no try failed,
 * no step failed; then the next cubed starts it, counting no failed try.
 * Its startup steps, as `name attempt state: detail`. */
async function recovers(state: string, id: string, machinesRoot: string): Promise<string[]> {
  const stored = new Registry(path.join(state, "registry.sqlite"));
  const left = stored.getThread(id)!;
  stored.close();
  assert.equal(left.workspaceState, "allocating", `still starting, not failed: ${left.workspaceError}`);
  assert.equal(left.workspaceError, null);
  assert.equal(left.retry, undefined, "no failed try counted");
  assert.deepEqual((left.vm?.steps ?? []).filter(step => step.state === "failed"), [], "no step failed");
  const next = await createCubed({ state, models, machines: new LocalMachines(machinesRoot), claude: null, gateway: null });
  try {
    await until("the next cubed starts the thread", () => {
      const thread = next.registry.getThread(id)!;
      assert.notEqual(thread.workspaceState, "failed", thread.workspaceError ?? "");
      return thread.workspaceState === "available" && !next.conversations.starting(id);
    });
    const thread = next.registry.getThread(id)!;
    assert.equal(thread.retry, undefined, "no failed try counted");
    return (thread.vm?.steps ?? []).map(step => `${step.name}${step.attempt ? ` ${step.attempt}` : ""} ${step.state}${step.state === "ok" ? "" : `: ${step.detail}`}`);
  } finally { await next.close(); }
}

try {
  // 1. The start goes on after the close closed every store: it ends
  //    quietly, it does not reject unhandled.
  {
    const machines = new HeldMachines(path.join(root, "machines-after"));
    const { app, state, id } = await accepted("after", machines);
    await machines.started;
    await app.close();
    assert.throws(() => app.registry.listProjects(), "the registry is closed");
    machines.go();
    await delay(500);
    assert.deepEqual(unhandled.map(String), [], "no unhandled rejection from the start");
    assert.deepEqual(await recovers(state, id, machines.root), ["model ok", "commits ok", "prepare 1 ok", "resume ok"]);
    console.log("ok: a start that goes on past cubed's close ends quietly; the next cubed starts the thread");
  }

  // 2. The start fails while the close is under way (its runner went with
  //    it), the registry still open: no failed try is recorded.
  {
    const machines = new HeldMachines(path.join(root, "machines-during"));
    const { app, state, id } = await accepted("during", machines);
    await machines.started;
    machines.closing = async () => {
      machines.go(new Error("the runner stopped with cubed"));
      await until("the start ends", () => !app.conversations.starting(id));
    };
    await app.close();
    assert.deepEqual(unhandled.map(String), []);
    assert.deepEqual(await recovers(state, id, machines.root), ["model ok", "commits ok", "prepare 1 ok", "resume ok"]);
    console.log("ok: a start that fails because cubed closes is no failed try");
  }

  // 3. The close stops the machine's preparation (its pre-setup is killed
  //    with the machine): the prepare step stays running, not failed, and
  //    the next start ends it as interrupted.
  {
    const machines = new HeldMachines(path.join(root, "machines-prepare"));
    machines.holding = false;
    const hold = path.join(root, "hold");
    fs.writeFileSync(hold, "");
    const preSetup = `echo waiting; while [ -e ${hold} ]; do sleep 0.05; done`;
    const { app, state, id } = await accepted("prepare", machines, { preSetup });
    for (const deadline = Date.now() + 30_000; ; await delay(25)) {
      const thread = app.registry.getThread(id)!;
      const log = thread.vm ? await machines.startupLog(thread).catch(() => null) : null;
      if (log?.hook === "pre-setup" && log.text.includes("waiting")) break;
      assert.ok(Date.now() < deadline, "the pre-setup runs");
    }
    // The threads' close (the local guests' close in it kills the hook); the
    // start meets it while the registry is still open, as it is in cubed
    // until the gateway and egress stopped. cubed's own close follows.
    await app.conversations.close();
    await until("the start ends", () => !app.conversations.starting(id));
    await app.close();
    assert.deepEqual(unhandled.map(String), []);
    fs.rmSync(hold);
    // The next cubed reads how the try ended in the machine (the local
    // guests' close killed its hook; a runner's machine would go on) and
    // tries again; the closed cubed recorded nothing of it. How the killed
    // hook reads (the command interrupted, or killed by a signal) is the
    // local guests'.
    const [modelStep, commitsStep, killed, ...rest] = await recovers(state, id, machines.root);
    assert.deepEqual([modelStep, commitsStep, ...rest], ["model ok", "commits ok", "prepare 2 ok", "resume ok"]);
    assert.match(killed, /^prepare 1 failed: .*(interrupted|killed by a signal).*; cube tries again$/);
    console.log("ok: a preparation cubed's close stopped is no failed step or try of the closed cubed's");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
