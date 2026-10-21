/** cubed's close drains a thread's request out (G1, T5 of review cdc0e7c9):
 * a real cubed (createCubed, local guests: the real guest helper under a
 * temporary root, not a VM) with a Pi thread whose provider has its
 * request and answers 1.5 s later. cubed's close (Conversations.close →
 * the agent's drain) waits for that answer, so after a reopen on the same
 * state it is stored whole, sent once, and not counted as a turn without a
 * usage report. Faux model; no provider. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-cubed-drain-"));
const state = path.join(root, "state"), machines = path.join(root, "machines");
fs.mkdirSync(state); fs.mkdirSync(machines);
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const work = path.join(root, "repository"); fs.mkdirSync(work);
git(work, ["init", "-q", "--initial-branch=develop"]); fs.writeFileSync(path.join(work, "README"), "drain\n"); git(work, ["add", "README"]); git(work, ["commit", "-qm", "drain"]);
const remote = path.join(root, "remote.git"); git(root, ["clone", "-q", "--bare", work, remote]);

const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
/** Each request's last user text, when the provider has it. */
const received: string[] = [];
let answerMs = 0;
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 4, max: 8 } });
faux.setResponses(Array.from({ length: 50 }, () => async (request, options) => {
  const user = textOf(request.messages.findLast(message => message.role === "user")!);
  received.push(user);
  if (answerMs) await delay(answerMs, null, { signal: options?.signal }).catch(() => {});
  if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
  return fauxAssistantMessage(`answer to ${user}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const open = async () => {
  const app = await createCubed({ state, models, machines: new LocalMachines(machines), claude: null, gateway: null });
  if (app.registry.runnerCount() === 0) {
    app.registry.enrollRunner({ nodeId: "node-drain", environmentId: 1, threadId: "runner-drain", configPath: "/private/drain.json", configHash: "drain", protocol: 4, kind: "vm" });
  }
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
};
async function until<T>(what: string, check: () => Promise<T | false | undefined>, ms = 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    assert.ok(Date.now() < deadline, `waiting for ${what}`);
    await delay(50);
  }
}

let { app, base } = await open();
const post = async (route: string, body: unknown) => { const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`); return response.json(); };
const history = async (id: string) => (await fetch(`${base}/api/threads/${id}/history`)).json() as Promise<{ status: { state: string; error: string | null }; events: Array<{ type: string; text?: string }> }>;
try {
  const project = (await post("/api/projects", { name: "drain", repositories: [{ url: remote, base: "develop" }] })).project.id as string;
  const { id } = await post("/api/threads", { projectId: project, requestId: "drain-first", text: "first", model: { provider: faux.getModel().provider, id: faux.getModel().id } });
  await until("the first turn", async () => (await history(id)).status.state === "completed");
  answerMs = 1_500;
  await post(`/api/threads/${id}/prompt`, { text: "slow", requestId: "drain-slow" });
  await until("the provider has the slow request", async () => received.includes("slow"));
  const closing = Date.now();
  await app.close();
  const closeMs = Date.now() - closing;
  assert.ok(closeMs >= 1_000, `the close waited for the answer (${closeMs} ms)`);
  answerMs = 0;
  ({ app, base } = await open());
  const done = await until("the slow turn, stored", async () => { const h = await history(id); return h.status.state === "completed" && h.events.some(event => event.text === "answer to slow") && h; });
  assert.ok(done);
  await delay(500);
  assert.equal(received.filter(user => user === "slow").length, 1, "the slow request was sent once");
  const report = await (await fetch(`${base}/api/usage`)).json() as { totals: { unknownTurns: number } };
  assert.equal(report.totals.unknownTurns, 0, "nothing counted as a turn without a usage report");
  console.log(`ok: cubed's close drained a thread's request answered 1.5 s later (close ${closeMs} ms): stored after the reopen, sent once, not counted`);
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
