/** Process-crash fixture using production session/tool code over a local
 * guest (the real guest helper under a temporary root). Only the model is
 * controlled; no credentials or paid requests are involved. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ToolTask, watchEvents, type SubmissionId } from "@earendil-works/pi-durable";
import { openAgent } from "../src/durable-agent.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const [directory, guestRoot, mode, boundary] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const REQUEST = "smoke-prompt";
const checkpoint = async (name: string) => {
  if (mode !== "create" || boundary !== name) return;
  process.send!({ type: "checkpoint", name });
  await new Promise<void>(() => {});
};
const guest = new LocalGuestTransport(guestRoot);
const workspace = new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding });
const exec = workspace.exec.bind(workspace);
workspace.exec = async (...args) => {
  const result = await exec(...args);
  fs.appendFileSync(path.join(directory, "attempts"), `${args[1]}\n`);
  return result;
};
// Recovery starts when the agent opens; the model waits for /drive so the
// event stream observes the recovered run.
let drive!: () => void;
const driven = mode === "recover" ? new Promise<void>(resolve => { drive = resolve; }) : Promise.resolve();
const faux = fauxProvider({ tokensPerSecond: boundary === "model-stream" ? 40 : 1000, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array.from({ length: 4 }, () => async request => {
  await driven;
  const result = request.messages.findLast(message => message.role === "toolResult");
  if (result) {
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: "74\n[exit=0; exited]" }]);
    return fauxAssistantMessage("verified guest result: 74");
  }
  await checkpoint("accepted");
  return fauxAssistantMessage([
    { type: "text", text: "checking guest output" },
    fauxToolCall("bash", { command: `printf once >> ${boundary}-count; printf 74` }, { id: "provider-call" }),
  ], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const boundaries = defineExtension({
  name: "boundaries",
  hooks: [
    hook(ToolTask, { afterTool: async () => { await checkpoint("tool-result-gap"); return undefined; } }),
    hook(GenerationTask, { beforeRequest: async request => {
      if (request.messages.some(message => message.role === "toolResult")) await checkpoint("after-tool");
      return undefined;
    } }),
  ],
});
const options = { directory, binding: guest.binding, workspace, models, model: { provider: faux.getModel().provider, id: faux.getModel().id }, extensions: [boundaries] };
if (mode === "contend") {
  await assert.rejects(openAgent(options), /already has a writable owner/);
  process.send!({ type: "blocked" });
  process.exit(0);
}
let agent = await openAgent(options);
if (mode === "inspect") {
  await agent.close();
  await assert.rejects(openAgent({ ...options, binding: `${guest.binding}:different` }), /thread machine binding changed/);
  // Clean close and failed reopen must both relinquish the lease.
  agent = await openAgent(options);
}
const { conversation, harness } = agent;
if (mode === "create" && boundary === "model-stream") {
  const watch = await conversation.watch(context);
  watch.start(async value => {
    const partial = (value.docs["pi.live"] as { generation?: { message?: { content: Array<{ type: string; text?: string }> } } }).generation?.message;
    if ((partial?.content.find(part => part.type === "text")?.text?.length ?? 0) >= 8) await checkpoint("model-stream");
  });
}
const submitted = await conversation.commit(tx => tx.submissionByRequest(conversation.id, REQUEST), context);
if (mode === "create") assert.equal(submitted, undefined);
else if (mode === "recover") assert.equal(submitted?.status, "placed");
else assert.equal(submitted?.status, "done");
let submission: SubmissionId | undefined = submitted?.id;
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === "/events") {
      const stream = await watchEvents(harness, conversation.id, context);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: stream.snapshot })}\n\n`);
      stream.start(async events => { for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`); });
      response.on("close", () => { void stream.stop(); });
    } else if (request.url === "/snapshot") {
      const watch = await conversation.watch(context);
      await watch.stop();
      response.end(JSON.stringify(watch.value));
    } else if (request.url === "/drive") {
      if (mode === "create") submission = (await conversation.submit({ type: "input", content: "Calculate 7 times ten plus 4 with bash.", requestId: REQUEST }, context)).id;
      response.writeHead(200).end(JSON.stringify({ submission }));
      drive?.();
      const settled = await (await harness.submission(submission!, context))!.wait(context);
      assert.equal(settled.status, "done");
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
process.send!({ type: "ready", url: `http://127.0.0.1:${address.port}`, submission });
