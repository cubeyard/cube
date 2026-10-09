/** The real cubed and OptChat over a controlled model, for the browser
 * tests: streamed text, a tool call ("use the date tool"), a provider
 * failure ("please fail"). `renderMs` slows each frame of Pi's transcript
 * as a long chat's render is slow. Offline and disposable. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Models } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";
import { LocalMachines } from "./local-guest.ts";
import type { SkillSource } from "../src/skills.ts";

export async function startChatHost(options: { renderMs?: number; models?: string[]; setup?: boolean; skillSource?: SkillSource } = {}): Promise<{ url: string; models: Models; close(): Promise<void> }> {
  if (options.renderMs) {
    const prototype = PiThreadEvents.prototype as unknown as { render: (...args: unknown[]) => Promise<unknown> };
    const render = prototype.render;
    prototype.render = async function (this: unknown, ...args: unknown[]) {
      const result = await render.apply(this, args);
      await delay(options.renderMs);
      return result;
    };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-chat-"));
  const faux = fauxProvider({ tokensPerSecond: 60, tokenSize: { min: 2, max: 4 }, ...options.models ? { models: options.models.map(id => ({ id })) } : {} });
  const said = (message: unknown) => JSON.stringify(message) ?? "";
  faux.setResponses(Array.from({ length: 100 }, () => async request => {
    if (said(request.messages.find(message => message.role === "system")).includes("You write the memory of OptChat")) return fauxAssistantMessage("a summary");
    await delay(200);
    const last = request.messages.at(-1)!;
    if (last.role === "toolResult") return fauxAssistantMessage("the date tool answered, and this answer streams in over several frames");
    // The turn's message is the last block; the ones before it are the chat's view.
    const asked = last.role !== "user" ? "" : typeof last.content === "string" ? last.content : last.content.flatMap(part => part.type === "text" ? [part.text] : []).at(-1) ?? "";
    if (asked.includes("please fail")) throw new Error("the provider refused");
    if (asked.includes("use the date tool")) return fauxAssistantMessage([{ type: "text", text: "checking the date" }, fauxToolCall("date", {}, { id: `call-${Date.now()}` })], { stopReason: "toolUse" });
    return fauxAssistantMessage("hello, this reply streams in token by token so the reader watches it arrive");
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null,
    ...options.skillSource ? { skillSource: options.skillSource } : {} });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // `setup`: leave the first-run setup to the test.
  if (!options.setup) await fetch(`${url}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return {
    url,
    models,
    async close() {
      app.server.closeAllConnections();
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
