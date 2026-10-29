/** What a Pi thread's request carries when its memory (thread-memory.ts)
 * could not be read at its first request and is captured later: Pi rendered
 * the "cannot be read" text into its baseline, and the capture is then one
 * patch of the memory section alone, written once; later requests add none.
 * The patch is a later system entry: a model that takes later system
 * messages natively gets it in place, after the cached prefix; for any other
 * model pi-ai folds every system message into the leading prompt
 * (getCurrentSystemMessage), so the patch changes the prefix and the whole
 * conversation is written to the cache again, once. thread-memory.ts keeps
 * this to a Pi thread whose own wait (60 s) ran out or whose OptChat open
 * failed: another thread giving up does not cut it short. Offline: faux
 * model, local guest. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { openAgent, type Agent } from "../src/durable-agent.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-memory-"));
const files = path.join(root, "workspace");
const directory = path.join(root, "thread");
fs.mkdirSync(files, { recursive: true });
const guest = new LocalGuestTransport(path.dirname(files));
const leases = new LeaseStore(directory);
const workspace = new VmWorkspace({ guest, leases, owner: "pi", binding: guest.binding });
const TRANSIENT = "Chat memory: …\nThe chat cannot be read right now (OptChat is still opening); the next request tries again, and memory_zoom reads it once OptChat is open.";
const CAPTURED = "Chat memory: …\nThe view below is the chat through message 0 (…), captured … when this thread started.\n<chat>\n0+1|user: plan the release\n</chat>";
let memory = TRANSIENT;

/** Each request's system entries: the sections each one sets, in order. */
const requests: Array<Array<Record<string, string | null>>> = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 10 }, () => request => {
  requests.push(request.messages.filter((message: Message) => message.role === "system").map(message => (message as { sections?: Record<string, string | null> }).sections ?? {}));
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const agent: Agent = await openAgent({ directory, binding: guest.binding, workspace, models, model: { provider: faux.getModel().provider, id: faux.getModel().id },
  hostTools: () => ({ tools: [], note: "", memory: async () => memory }) });
const turn = async (content: string) => {
  const submission = await agent.conversation.submit({ type: "input", content, requestId: content }, context);
  assert.equal((await submission.wait(context)).status, "done");
};
const memoryWrites = (entries: Array<Record<string, string | null>>) => entries.filter(sections => "memory" in sections).map(sections => sections.memory);

try {
  await turn("first");
  assert.deepEqual(memoryWrites(requests[0]!), [TRANSIENT], "the first request's baseline holds the transient text");
  memory = CAPTURED;
  await turn("second");
  assert.deepEqual(memoryWrites(requests[1]!), [TRANSIENT, CAPTURED], "the capture is one patch after the baseline");
  assert.deepEqual(requests[1]!.at(-1), { memory: CAPTURED }, "the patch sets the memory section alone");
  assert.equal(requests[1]![0]!.preamble, requests[0]![0]!.preamble, "the baseline before it is unchanged");
  await turn("third");
  assert.deepEqual(memoryWrites(requests[2]!), [TRANSIENT, CAPTURED], "and later requests add no patch");
  console.log("ok: memory captured after a transient first request: the baseline keeps the transient text, one patch of the memory section alone follows, once");
} finally {
  await agent.close();
  guest.stop();
  leases.close();
  fs.rmSync(root, { recursive: true, force: true });
}
