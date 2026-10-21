/** cubed's close is bounded (G1). Every part that can hang is made to: the
 * chat's own close, the thread machines' close, a thread agent whose drain
 * and close never end (a request that never comes back), and a command (an
 * OptChat tell or archive cut off). `createCubed`'s close still ends within
 * CLOSE_MS, under the supervisor's SIGKILL 30 s after its SIGTERM, with the
 * registry closed, and the threads got at most their share. The stuck parts
 * are stand-ins in a real cubed on disposable state, with a faux model so
 * the chat opens; no runner, VM or provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { THREADS_CLOSE_MS } from "../src/conversation.ts";
import { CLOSE_MS, createCubed } from "../src/index.ts";
import { OptChat } from "../src/optchat.ts";

// The budget the supervisor's 30 s bound rests on.
assert.equal(CLOSE_MS, 25_000);
assert.equal(THREADS_CLOSE_MS, 9_000);
const never = new Promise<void>(() => {});
const calls: string[] = [];
// The chat's close never ends (it bounds itself at 14 s; here it does not).
OptChat.prototype.close = async function () { calls.push("optchat"); return never; };
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-cubed-close-"));
const app = await createCubed({ state, models, claude: null, gateway: null });
const conversations = app.conversations as unknown as { agents: Map<string, Promise<unknown>>; commands: Map<string, Promise<unknown>>; machines: { close(): Promise<void> }; close(ms?: number): Promise<void> };
// The chat opens in the background; give it time to, so its close is the stuck one.
await new Promise(resolve => setTimeout(resolve, 1000));
conversations.machines.close = async () => { calls.push("machines"); return never; };
conversations.agents.set("stuck", Promise.resolve({
  async drain() { calls.push("drain"); return never; },
  async close() { calls.push("close"); return never; },
  harness: { snapshot: async () => undefined, usage: async () => ({ models: {}, tools: {} }) },
}));
conversations.commands.set("stuck", never);
const close = conversations.close.bind(conversations);
let threadsMs = -1;
conversations.close = (ms?: number) => { threadsMs = ms ?? -1; return close(ms); };
const started = Date.now();
await app.close();
const took = Date.now() - started;
assert.ok(took < CLOSE_MS + 1_000, `the close ends within its bound (${took} ms)`);
assert.ok(took < 30_000, "under the supervisor's SIGKILL");
assert.ok(calls.includes("optchat"), `the chat's close was the stuck one: ${calls.join(", ")}`);
assert.deepEqual(calls.filter(call => call !== "optchat"), ["machines", "drain", "close"], "the machines, then the agent's drain and close, each bounded");
assert.ok(threadsMs >= 0 && threadsMs <= THREADS_CLOSE_MS, `the threads got at most their share (${threadsMs} ms)`);
assert.throws(() => app.registry.listProjects(), "the registry is closed");
assert.ok(!fs.existsSync(path.join(state, "run", "workspace.sock")), "the workspace socket is gone");
fs.rmSync(state, { recursive: true, force: true });
console.log(`ok: cubed's close with the chat, the machines, a thread agent and a command all stuck ends in ${took} ms (bound ${CLOSE_MS} ms; the threads ${threadsMs} ms of ${THREADS_CLOSE_MS}), its stores closed`);
