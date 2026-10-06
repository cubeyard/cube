/** The cost of one live render of a long Pi thread (each watch frame renders the whole transcript). */
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createModels as aiModels } from "@earendil-works/pi-ai";
import { openStorage } from "../src/durable-agent.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";


const context = BACKGROUND_CONTEXT;
const dir = fs.mkdtempSync("/workspace/packages/server/.bench/render-");
fs.copyFileSync("/workspace/packages/server/.bench/data/pi/pi.sqlite", path.join(dir, "pi.sqlite"));
const storage = await openStorage(path.join(dir, "pi.sqlite"));
const harness = await Harness.open(storage, { models: aiModels(), registry: createRegistry() }, context);
const conversation = await harness.root(context);
const events = new PiThreadEvents({ agent: { conversation, storage } as never, owner: () => null, failure: () => null });
for (let k = 0; k < 5; k++) {
  const s = performance.now();
  const transcript = await events.read();
  console.log(`render ${(performance.now() - s).toFixed(0)} ms, ${transcript.events.length} events`);
}
await harness.close(context);
fs.rmSync(dir, { recursive: true, force: true });
