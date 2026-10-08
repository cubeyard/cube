/** The settings page's compactor choice through cubed's HTTP routes: saved
 * in the state directory, checked against the available models, used by
 * the next node the compactor writes (one being written keeps its model),
 * kept over a restart, reset to the chat's model, passed over when no
 * provider offers it, and below CUBED_OPTCHAT_COMPACTOR. Faux models,
 * disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-settings-"));
const state = path.join(root, "state");
const file = path.join(state, "settings.json");
/** Each compactor call's model, in order. */
const calls: string[] = [];
let gate: Promise<void> | null = null;
const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-chat" }, { id: "faux-cheap" }, { id: "faux-other" }] });
faux.setResponses(Array.from({ length: 500 }, () => async (request, _options, _state, model) => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) {
    calls.push(model.id);
    if (gate) await gate;
    return fauxAssistantMessage(`line by ${model.id}`);
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const chatModel = { provider: "faux", id: "faux-chat" };
const cheap = { provider: "faux", id: "faux-cheap" };
const other = { provider: "faux", id: "faux-other" };

async function start() {
  const app = await createCubed({ state, models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
    return { status: response.status, body: await response.json() };
  };
  // The chat opens in the background; the settings name its model once it has.
  await call("/api/optchat/view");
  return { app, call, close: async () => { app.server.closeAllConnections(); await app.close(); } };
}

/** A message too long for one line: the compactor writes its node. */
let sent = 0;
async function long(call: Awaited<ReturnType<typeof start>>["call"]): Promise<void> {
  const before = calls.length;
  sent++;
  assert.equal((await call("/api/optchat/prompt", "POST", { text: `message ${sent}: ${"words to fold ".repeat(60)}`, requestId: `settings-${sent}` })).status, 200);
  for (let i = 0; calls.length === before; i++) { assert.ok(i < 400, "the compactor is called"); await delay(25); }
}
async function settled(call: Awaited<ReturnType<typeof start>>["call"], text: string): Promise<void> {
  for (let i = 0; !(await call("/api/optchat/view")).body.view.includes(text); i++) { assert.ok(i < 400, `the view holds ${text}`); await delay(25); }
}

try {
  let host = await start();
  // Fresh: nothing saved, the compactor follows the chat.
  let view = (await host.call("/api/settings")).body;
  assert.deepEqual(view.chat, chatModel);
  assert.deepEqual(view.models, [chatModel, cheap, other]);
  assert.deepEqual(view.compactor, { saved: null, environment: null, source: "chat", model: chatModel, unavailable: null });
  assert.equal(view.error, null);
  assert.equal(fs.existsSync(file), false, "reading saves nothing");

  // Invalid input saves nothing.
  for (const [body, status] of [[{}, 400], [{ model: "faux/faux-cheap" }, 400], [{ model: { provider: "faux" } }, 400], [{ model: cheap, extra: 1 }, 400],
    [{ model: { ...cheap, more: true } }, 400], [{ model: [] }, 400], [{ model: { provider: "faux", id: "faux-missing" } }, 422], [{ model: { provider: "claude-code", id: "opus" } }, 422]] as const) {
    const answer = await host.call("/api/settings/compactor", "PUT", body);
    assert.equal(answer.status, status, JSON.stringify(body));
    assert.equal(typeof answer.body.error, "string");
  }
  assert.equal(fs.existsSync(file), false, "a refused choice saves nothing");
  assert.equal((await host.call("/api/settings/nonsense")).status, 404);

  // Unset: the chat's model writes the nodes.
  await long(host.call);
  assert.equal(calls.at(-1), "faux-chat");

  // A saved model is used by the next node, without a restart.
  view = (await host.call("/api/settings/compactor", "PUT", { model: cheap })).body;
  assert.deepEqual(view.compactor, { saved: cheap, environment: null, source: "saved", model: cheap, unavailable: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, optchat: { compactor: cheap } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await long(host.call);
  assert.equal(calls.at(-1), "faux-cheap");

  // A node being written keeps its model when the choice changes.
  let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  await long(host.call);
  assert.equal(calls.at(-1), "faux-cheap");
  view = (await host.call("/api/settings/compactor", "PUT", { model: other })).body;
  assert.equal(view.compactor.source, "saved");
  const held = calls.length;
  release();
  gate = null;
  await settled(host.call, `line by faux-cheap`);
  assert.ok(!calls.slice(held).includes("faux-cheap"), "the held node was not asked again");
  await long(host.call);
  assert.equal(calls.at(-1), "faux-other", "the next node uses the new choice");
  await settled(host.call, "line by faux-other");

  // Kept over a restart.
  await host.close();
  host = await start();
  view = (await host.call("/api/settings")).body;
  assert.deepEqual(view.compactor.saved, other);
  assert.equal(view.compactor.source, "saved");
  await long(host.call);
  assert.equal(calls.at(-1), "faux-other");

  // A catalog that cannot be read: the saved model still writes, and the page still answers.
  const getAvailable = models.getAvailable.bind(models);
  models.getAvailable = async () => { throw new Error("credential store unreadable"); };
  try {
    view = (await host.call("/api/settings")).body;
    assert.match(view.error, /the models could not be listed: credential store unreadable/);
    assert.equal(view.models, null, "not listed, not empty");
    assert.deepEqual(view.compactor, { saved: other, environment: null, source: "saved", model: other, unavailable: null });
    await long(host.call);
    assert.equal(calls.at(-1), "faux-other");
  } finally { models.getAvailable = getAvailable; }
  assert.equal((await host.call("/api/settings")).body.error, null);

  // Reset: the chat's model again.
  view = (await host.call("/api/settings/compactor", "PUT", { model: null })).body;
  assert.deepEqual(view.compactor, { saved: null, environment: null, source: "chat", model: chatModel, unavailable: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, optchat: { compactor: null } });
  await long(host.call);
  assert.equal(calls.at(-1), "faux-chat");
  await host.close();

  // A saved model no provider offers now: the chat's model writes, and the page says so.
  fs.writeFileSync(file, JSON.stringify({ version: 1, optchat: { compactor: { provider: "gone", id: "gone-1" } } }));
  host = await start();
  view = (await host.call("/api/settings")).body;
  assert.deepEqual(view.compactor, { saved: { provider: "gone", id: "gone-1" }, environment: null, source: "chat", model: chatModel, unavailable: { provider: "gone", id: "gone-1" } });
  await long(host.call);
  assert.equal(calls.at(-1), "faux-chat");
  await host.close();

  // An unreadable file: the defaults, said; a save replaces it.
  fs.writeFileSync(file, "{not json");
  host = await start();
  view = (await host.call("/api/settings")).body;
  assert.match(view.error, /settings\.json could not be read/);
  assert.equal(view.compactor.saved, null);
  view = (await host.call("/api/settings/compactor", "PUT", { model: cheap })).body;
  assert.equal(view.error, null);
  assert.deepEqual(view.compactor.saved, cheap);
  await host.close();

  // CUBED_OPTCHAT_COMPACTOR wins over the saved choice; a save is kept for later, the file never takes the variable.
  process.env.CUBED_OPTCHAT_COMPACTOR = "faux/faux-other";
  try {
    host = await start();
    view = (await host.call("/api/settings")).body;
    assert.deepEqual(view.compactor, { saved: cheap, environment: { value: "faux/faux-other", error: null }, source: "environment", model: other, unavailable: null });
    await long(host.call);
    assert.equal(calls.at(-1), "faux-other");
    view = (await host.call("/api/settings/compactor", "PUT", { model: null })).body;
    assert.equal(view.compactor.source, "environment");
    assert.deepEqual(view.compactor.model, other);
    await long(host.call);
    assert.equal(calls.at(-1), "faux-other", "the variable still wins");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, optchat: { compactor: null } });
    await host.close();
    process.env.CUBED_OPTCHAT_COMPACTOR = "no-slash";
    host = await start();
    view = (await host.call("/api/settings")).body;
    assert.deepEqual(view.compactor.environment, { value: "no-slash", error: "CUBED_OPTCHAT_COMPACTOR must be provider/model" });
    assert.equal(view.compactor.model, null);
    assert.equal(view.chat, null, "the chat is unavailable");
    await host.close();
  } finally {
    delete process.env.CUBED_OPTCHAT_COMPACTOR;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("settings: ok");
