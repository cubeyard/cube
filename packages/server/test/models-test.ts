import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelRuntime, preferredModel } from "../src/models.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-models-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
try {
  fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture-not-secret",
    models: ["first", "second"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "second" }));
  const runtime = await createModelRuntime();
  const models = (await runtime.getAvailable()).filter(model => model.provider === "fixture").map(({ provider, id }) => ({ provider, id }));
  assert.equal(models.length, 2);
  assert.deepEqual(preferredModel(models), { provider: "fixture", id: "second" });
  assert.deepEqual(preferredModel(models.slice(0, 1)), { provider: "fixture", id: "first" });
  assert.equal(preferredModel([]), null);
  console.log("ok: host-only model catalog, configured default and unavailable default; no model request");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
