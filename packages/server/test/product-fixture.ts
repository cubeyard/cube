/** Actual product HTTP server and published Pi storage over local guests
 * (the real guest helper under temporary roots); controlled model only. */
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import path from "node:path";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

const [state, machinesRoot, mode] = process.argv.slice(2);
const faux = fauxProvider({ models: mode === "removed-initial" ? [{ id: "faux-2" }] : mode === "removed-selected" ? [{ id: "faux-3" }] : [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array.from({ length: 10 }, () => async request => {
  if (mode === "hold") {
    process.send!({ type: "accepted" });
    await new Promise<void>(() => {});
  }
  const tool = request.messages.at(-1)?.role === "toolResult";
  if (tool) return fauxAssistantMessage("product recovered guest result: 93");
  return fauxAssistantMessage([fauxToolCall("bash", { command: "printf once >> product-count; printf 93" })], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state, models, machines: new LocalMachines(machinesRoot),
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
if (app.registry.runnerCount() === 0) {
  app.registry.enrollRunner({ nodeId: "node-product", environmentId: 1, threadId: "runner-product", configPath: "/private/product.json", configHash: "product" });
}
await new Promise<void>(resolve => app.server.listen(Number(process.env.CUBE_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("missing listener");
const ready = { type: "ready", url: `http://127.0.0.1:${address.port}`, model: faux.getModel().id, provider: faux.getModel().provider };
if (process.send) process.send(ready);
else console.log(JSON.stringify(ready));
