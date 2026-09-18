/** Actual product HTTP server, published Pi storage and real runner; controlled model only. */
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { IrohExecutionNodeClient } from "../src/iroh-node.ts";

const [state, configPath, mode] = process.argv.slice(2);
const faux = fauxProvider({ models: mode === "removed-initial" ? [{ id: "faux-2" }] : mode === "removed-selected" ? [{ id: "faux-3" }] : [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array.from({ length: 10 }, () => async request => {
  if (mode === "hold") {
    process.send!({ type: "accepted" });
    await new Promise<void>(() => {});
  }
  const tool = request.messages.at(-1)?.role === "toolResult";
  if (tool) return fauxAssistantMessage(mode === "jev" ? "jev observed the compact tool context" : "product recovered runner result: 93");
  const command = mode === "jev"
    ? "i=1; while [ $i -le 220 ]; do if [ $i -eq 111 ]; then printf 'line %s ERROR acceptance marker\\n' \"$i\"; else printf 'line %s ordinary acceptance output with repeated detail\\n' \"$i\"; fi; i=$((i+1)); done"
    : "printf once >> product-count; printf 93";
  return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state, models });
if (app.registry.runnerCount() === 0) {
  const runner = new IrohExecutionNodeClient({ configPath });
  app.registry.enrollRunner({ ...runner.binding, configPath, configHash: runner.configHash });
}
await new Promise<void>(resolve => app.server.listen(Number(process.env.CUBE_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("missing listener");
const ready = { type: "ready", url: `http://127.0.0.1:${address.port}`, model: faux.getModel().id, provider: faux.getModel().provider };
if (process.send) process.send(ready);
else console.log(JSON.stringify(ready));
