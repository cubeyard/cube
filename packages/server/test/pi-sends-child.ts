/** Test only: a cubed that dies while a model request is out. It opens the
 * chat (`chat`: its turn's request is held; `compactor`: a summary's answer
 * is held) or a thread agent (`thread`) on `directory` with a faux model,
 * sends one message, and when the request it holds reaches the provider
 * writes `signal`; the parent then SIGKILLs it, a real crash: no close, no
 * grace, nothing flushed by cube.
 *
 *   node pi-sends-child.ts <chat|compactor|thread> <directory> <signal> */
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { openAgent } from "../src/durable-agent.ts";
import { OptChat } from "../src/optchat.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";
import { CHAT_LIMITS, threadsStub } from "./pi-sends-fixture.ts";

const [kind, directory, signal] = process.argv.slice(2) as ["chat" | "compactor" | "thread", string, string];
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  const compaction = request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat"));
  if (kind === "thread" || (kind === "chat" && !compaction) || (kind === "compactor" && compaction)) {
    fs.writeFileSync(signal, compaction ? "compaction" : "turn");
    await new Promise(() => {});
  }
  return fauxAssistantMessage(compaction ? `summary ${"s".repeat(20)}` : "reply");
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

if (kind === "thread") {
  const files = path.join(path.dirname(directory), "workspace");
  fs.mkdirSync(files, { recursive: true });
  const guest = new LocalGuestTransport(path.dirname(files));
  const agent = await openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }), models, model });
  await agent.conversation.submit({ type: "input", content: "first", requestId: "first" }, BACKGROUND_CONTEXT);
} else {
  const chat = await OptChat.open({ directory, models, model: async () => model, threads: threadsStub, limits: CHAT_LIMITS });
  await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
}
// Held open until the parent kills it.
setInterval(() => {}, 1 << 30);
