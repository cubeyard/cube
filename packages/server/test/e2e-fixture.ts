/** A disposable cubed for scripts/test-vm-e2e.ts: the real product server
 * with real thread VMs (runner, gateway, egress policy from the environment),
 * a faux model and a fake `claude`. No model service is contacted.
 *
 * The faux model is scripted by the prompt: `tool {"name":…,"args":{…}}` makes
 * it call that tool; after a tool result it answers `result: <output>`; any
 * other prompt is answered `ok`. */
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";

const [state] = process.argv.slice(2);
const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 4, max: 8 } });
faux.setResponses(Array.from({ length: 500 }, () => async (request: { messages: Array<{ role: string; content: unknown }> }) => {
  const last = request.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`result: ${text(last.content)}`);
  const prompt = text(last?.content).trim();
  if (prompt.startsWith("tool ")) {
    const { name, args } = JSON.parse(prompt.slice(5)) as { name: string; args: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state, models, claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
await new Promise<void>(resolve => app.server.listen(Number(process.env.CUBE_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("missing listener");
process.send!({ type: "ready", url: `http://127.0.0.1:${address.port}`, port: address.port, provider: faux.getModel().provider, model: faux.getModel().id });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
