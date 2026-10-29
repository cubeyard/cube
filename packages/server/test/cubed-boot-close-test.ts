/** cubed closed while its boot round is still recovering a thread (a
 * SIGTERM during boot, or a test that reopens cubed and closes it): the
 * close ends, bounded, with its stores closed, and the round that goes on
 * after them neither rejects unhandled nor reports failures. Before, the
 * round's `void conversations.boot()` met a closed registry ("database is
 * not open") and the process exited 1. Offline: local guests whose start
 * waits on the test, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { Thread } from "../src/registry.ts";
import type { StartOptions } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-boot-close-"));
const state = path.join(root, "state");
fs.mkdirSync(state);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

/** A start that waits until the test lets it go. */
class HeldMachines extends LocalMachines {
  private letGo!: () => void;
  private begun!: () => void;
  readonly started = new Promise<void>(resolve => { this.begun = resolve; });
  private readonly held = new Promise<void>(resolve => { this.letGo = resolve; });
  go(): void { this.letGo(); }
  override async start(thread: Thread, options: StartOptions = {}): Promise<{ booted: boolean }> {
    this.begun();
    await this.held;
    return super.start(thread, options);
  }
}

try {
  // A thread on record, never started: the next cubed's boot starts it.
  const first = await createCubed({ state, models, claude: null, gateway: null, machines: new LocalMachines(path.join(root, "machines")) });
  first.registry.enrollRunner({ nodeId: "node-r", threadId: "r", environmentId: 1, configPath: "/private/r.json", configHash: "r", protocol: 4, kind: "vm" });
  first.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  first.registry.createThread("p", "t", model, "hello", "pi", { runnerId: "r" });
  await first.close();

  const machines = new HeldMachines(path.join(root, "machines"));
  const app = await createCubed({ state, models, claude: null, gateway: null, machines });
  await machines.started;
  const started = Date.now();
  await app.close();
  const took = Date.now() - started;
  assert.throws(() => app.registry.listProjects(), "the registry is closed");
  assert.ok(took < 10_000, `the close is bounded (${took} ms)`);
  // The boot round goes on after the stores closed.
  machines.go();
  await delay(500);
  assert.deepEqual(unhandled.map(String), [], "no unhandled rejection from the boot round");
  console.log(`ok: cubed closed during its boot round ends in ${took} ms; the round that goes on past it fails quietly, never unhandled`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
