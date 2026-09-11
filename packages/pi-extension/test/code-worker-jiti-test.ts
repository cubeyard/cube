/**
 * The QuickJS worker must load the way pi actually loads this extension.
 * pi does not `import` the extension: it transpiles it with jiti
 * (pi-coding-agent/dist/core/extensions/loader.js), so `import.meta.url`
 * inside code-mode.ts — the URL the worker path is resolved against — is
 * whatever jiti gives it. Running runCodeMode from a plain node ESM test
 * cannot catch a worker that fails to resolve or start under jiti; this can.
 *
 *   node packages/pi-extension/test/code-worker-jiti-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// jiti is pi's own dependency, not ours: resolve it from pi, which pnpm's
// strict layout guarantees can see it. A failure here means pi changed how
// it loads extensions — worth failing on, not skipping.
const fromPi = createRequire(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const jitiManifest = fromPi.resolve("jiti/package.json");
// Exactly the entry pi imports (`from "jiti/static"`), read from jiti's own
// export map so a moved file fails loudly here instead of silently at runtime.
const jitiStatic = JSON.parse(fs.readFileSync(jitiManifest, "utf8")).exports["./static"].import;
const { createJiti } = await import(pathToFileURL(path.join(path.dirname(jitiManifest), jitiStatic)).href);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cube-jiti-"));
// Wake goes through cubed; the extension must reach a ready thread before exec.
const cubed = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"status":"ready"}');
});
await new Promise<void>((resolve) => cubed.listen(0, "127.0.0.1", resolve));
const address = cubed.address();
assert.ok(address && typeof address !== "string");

const settings = {
  CUBE_NAME: "t-jiti", CUBE_BACKEND: "mock", CUBE_HOST_WORKSPACE: workspace,
  CUBE_THREAD_ID: "t-jiti", CUBED_URL: `http://127.0.0.1:${address.port}`,
};
const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
try {
  Object.assign(process.env, settings);
  const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
  const extension = await jiti.import(
    path.join(import.meta.dirname, "..", "src", "index.ts"),
    { default: true },
  ) as (pi: unknown) => void;
  assert.equal(typeof extension, "function", "jiti must yield the extension factory");

  const tools = new Map<string, any>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, registerCommand() {} } as any);
  const code = tools.get("code");
  assert.ok(code, "the code tool must be registered");

  const result = await code.execute("test", {
    source: 'const r = await cube.exec("printf hello-from-quickjs"); return r.output + "|" + r.exitCode;',
  });
  const text = result.content.map((chunk: { text: string }) => chunk.text).join("");
  assert.ok(!result.isError, `code mode failed under jiti: ${text}`);
  assert.match(text, /hello-from-quickjs\|0/);
  console.log("1 ok: the QuickJS worker starts and reaches the cube when pi loads the extension with jiti");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  cubed.closeAllConnections();
  await new Promise<void>((resolve) => cubed.close(() => resolve()));
  fs.rmSync(workspace, { recursive: true, force: true });
}
console.log("ALL PASS");
