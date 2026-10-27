/** Serves a seeded root (seed.ts) with the real cubed and the built UI on
 * loopback, the controlled model and local guests as in the seed. Every
 * HTTP request's time to headers, time to end and bytes go to
 * <root>/requests.jsonl (`label` from PERF_LABEL), so API costs can be
 * read apart from the browser's. SIGINT/SIGTERM close cubed cleanly (and
 * let `node --cpu-prof` write its profile).
 *
 *   node [--cpu-prof --cpu-prof-dir DIR] packages/server/test/perf/serve.ts <root> [port] [seed]
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openCubed } from "./lib.ts";

const root = path.resolve(process.argv[2] ?? "");
const port = Number(process.argv[3] ?? 7799);
const seed = Number(process.argv[4] ?? 20261023);
if (!process.argv[2] || !fs.existsSync(path.join(root, "state"))) { console.error("usage: serve.ts <seeded root> [port] [seed]"); process.exit(2); }

const t0 = performance.now();
const { app } = await openCubed(root, seed);
const opened = performance.now() - t0;
const out = fs.createWriteStream(path.join(root, "requests.jsonl"), { flags: "a" });
app.server.prependListener("request", (request, response) => {
  const start = performance.now();
  let headers = 0, bytes = 0;
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => typeof response;
  response.writeHead = ((...args: unknown[]) => { headers ||= performance.now() - start; return writeHead(...args); }) as typeof response.writeHead;
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  response.write = ((chunk: unknown, ...rest: unknown[]) => { if (chunk) bytes += Buffer.byteLength(chunk as string); return write(chunk, ...rest); }) as typeof response.write;
  const end = response.end.bind(response) as (...args: unknown[]) => typeof response;
  response.end = ((chunk?: unknown, ...rest: unknown[]) => { if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk as string); return end(chunk, ...rest); }) as typeof response.end;
  const done = () => out.write(`${JSON.stringify({ label: process.env.PERF_LABEL ?? "", at: Date.now(), method: request.method, url: request.url, status: response.statusCode,
    headersMs: Number(headers.toFixed(2)), totalMs: Number((performance.now() - start).toFixed(2)), bytes })}\n`);
  response.on("close", done);
});
await new Promise<void>(resolve => app.server.listen(port, "127.0.0.1", resolve));
console.log(JSON.stringify({ ready: `http://127.0.0.1:${port}`, openMs: Math.round(opened), listenMs: Math.round(performance.now() - t0), pid: process.pid }));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  app.server.closeAllConnections();
  await app.close().catch(error => console.error(error));
  out.end();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
