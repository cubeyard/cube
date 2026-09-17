/** Process-crash fixture using production session/tool code and a real runner.
 * Only the model is controlled; no credentials or paid requests are involved. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openAgent } from "../src/durable-agent.ts";
import { IrohExecutionNodeClient } from "../src/iroh-node.ts";

const [directory, configPath, mode, boundary] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const checkpoint = async (name: string) => {
  if (mode !== "create" || boundary !== name) return;
  process.send!({ type: "checkpoint", name });
  await new Promise<void>(() => {});
};
const runner = new IrohExecutionNodeClient({ configPath });
const execute = runner.resumeExec.bind(runner);
runner.resumeExec = async (...args) => {
  const result = await execute(...args);
  fs.appendFileSync(path.join(directory, "attempts"), `${result.operationId}\n`);
  await checkpoint("tool-result-gap");
  return result;
};
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array.from({ length: 4 }, () => request => {
  const result = request.messages.findLast(message => message.role === "toolResult");
  if (result) {
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "74\n[exit=0; exited]" }]);
    return fauxAssistantMessage("verified runner result: 74");
  }
  return fauxAssistantMessage([
    { type: "text", text: "checking runner output" },
    fauxToolCall("bash", { command: `printf once >> ${boundary}-count; printf 74` }, { id: "provider-call" }),
  ], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const options = { directory, runner, models, model: faux.getModel() };
if (mode === "contend") {
  await assert.rejects(openAgent(options), /already has a writable owner/);
  process.send!({ type: "blocked" });
  process.exit(0);
}
let agent = await openAgent(options);
if (mode === "inspect") {
  await agent.close();
  const changedPath = path.join(directory, "changed-runner.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.binding.threadId = "different-thread";
  fs.writeFileSync(changedPath, JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(openAgent({ ...options, runner: new IrohExecutionNodeClient({ configPath: changedPath }) }), /runner binding changed/);
  fs.unlinkSync(changedPath);
  // Clean close and failed reopen must both relinquish the writer lock.
  agent = await openAgent(options);
}
agent.harness.hooks.on("before_request", async () => {
  const watch = await agent.lane.watch(context);
  watch.unsubscribe();
  if (watch.snapshot.transcript.some(entry => entry.type === "message" && entry.message.role === "toolResult")) await checkpoint("after-tool");
  return undefined;
});
let streamed = 0;
agent.harness.events.on("message_update", async event => {
  if (event.event.type !== "text_delta" || mode !== "create" || boundary !== "model-stream") return;
  streamed += event.event.delta.length;
  if (streamed >= 8) {
    const watch = await agent.lane.watch(context);
    watch.unsubscribe();
    await checkpoint("model-stream");
  }
});
let operationId: string | undefined;
if (mode === "create") {
  const accepted = await agent.lane.accept({ kind: "prompt", prompt: "Calculate 7 times ten plus 4 with bash." }, context);
  assert(accepted.ok);
  operationId = accepted.value.operationId;
} else if (mode === "recover") {
  assert.equal(agent.open.length, 1);
  operationId = agent.open[0].operationId;
} else assert.equal(agent.open.length, 0);
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === "/events") {
      const watch = await agent.lane.watch(context);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: watch.snapshot })}\n\n`);
      watch.start(event => { response.write(`data: ${JSON.stringify(event)}\n\n`); });
      response.on("close", () => watch.unsubscribe());
    } else if (request.url === "/snapshot") {
      const watch = await agent.lane.watch(context);
      watch.unsubscribe();
      response.end(JSON.stringify(watch.snapshot));
    } else if (request.url === "/drive" && operationId) {
      response.writeHead(202).end();
      await checkpoint("accepted");
      const result = await agent.lane.drive({ operationId, waitForRetry: true }, context);
      assert(result.ok);
      assert.equal(result.value.kind, "settled");
      process.send!({ type: "done" });
    } else response.writeHead(404).end();
  })().catch(error => {
    process.send!({ type: "failure", error: String(error.stack ?? error) });
    response.destroy();
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
process.send!({ type: "ready", url: `http://127.0.0.1:${address.port}`, operationId });
