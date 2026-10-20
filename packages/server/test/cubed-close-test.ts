/** cubed's close is bounded (G1): with a thread agent whose close never
 * ends (a request that never comes back), and a command (an OptChat tell or
 * archive cut off) that never ends, `createCubed`'s close still ends within
 * CLOSE_MS, under the supervisor's SIGKILL 30 s after its SIGTERM, with the
 * registry closed. The stuck parts are stand-ins put into a real cubed on
 * disposable state; no runner, VM or provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { CLOSE_MS, createCubed } from "../src/index.ts";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-cubed-close-"));
const app = await createCubed({ state, models: createModels(), claude: null, gateway: null });
const conversations = app.conversations as unknown as { agents: Map<string, Promise<unknown>>; commands: Map<string, Promise<unknown>> };
const never = new Promise<void>(() => {});
const calls: string[] = [];
conversations.agents.set("stuck", Promise.resolve({
  hold() { calls.push("hold"); },
  async close() { calls.push("close"); return never; },
  harness: { snapshot: async () => undefined, usage: async () => ({ models: {}, tools: {} }) },
}));
conversations.commands.set("stuck", never);
const started = Date.now();
await app.close();
const took = Date.now() - started;
assert.ok(took < CLOSE_MS + 1_000, `the close ends within its bound (${took} ms)`);
assert.ok(took < 30_000, "under the supervisor's SIGKILL");
assert.deepEqual(calls, ["hold", "close"], "the agent was held, then closed");
assert.throws(() => app.registry.listProjects(), "the registry is closed");
assert.ok(!fs.existsSync(path.join(state, "run", "workspace.sock")), "the workspace socket is gone");
fs.rmSync(state, { recursive: true, force: true });
console.log(`ok: cubed's close with a stuck thread agent and a stuck command ends in ${took} ms (bound ${CLOSE_MS} ms), its stores closed`);
