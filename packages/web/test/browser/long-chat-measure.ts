/** Measures a long chat in a real browser: the bytes the page is sent
 * (history, stream frames, older pages) and how long it takes to show the
 * newest message and a live update. Not a test: it prints numbers. A
 * synthetic chat of TURNS turns (default 1000) is served the way cubed
 * serves it, windowed when the page asks for a window, whole when it does
 * not, so the same script measures a UI built before and after paging.
 *
 *   pnpm build && node packages/web/test/browser/long-chat-measure.ts [runs]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import type { ThreadEvent, ThreadTranscript } from "../../src/lib/types.ts";

const DIST = path.resolve(import.meta.dirname, "../../dist");
const TURNS = Number(process.env.TURNS ?? 1000);
const RUNS = Number(process.argv[2] ?? 3);
const window = await import("../../../server/src/transcript-window.ts").catch(() => null);

const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ["thread", "runner", "gateway", "machine", "review", "merge", "commit", "the", "a", "and"][(i * 7 + seed) % 10]).join(" ");
const events: ThreadEvent[] = [];
for (let turn = 0; turn < TURNS; turn++) {
  const id = turn * 10 + 1;
  events.push({ type: "user-message", id: `${id}.0`, text: `turn ${turn}: ${words(30, turn)}` });
  events.push({ type: "tool-call", id: `${id + 1}.0.0`, callId: `c${turn}`, name: "history", input: { id: `t${turn}` }, final: true });
  events.push({ type: "tool-result", id: `${id + 2}.0`, callId: `c${turn}`, name: "history", output: words(250, turn), isError: false, final: true });
  events.push({ type: "assistant-text", id: `${id + 3}.0.0`, text: `answer ${turn}: ${words(200, turn)}\n\n- ${words(12, turn)}\n- ${words(12, turn + 1)}`, reasoning: false, final: true });
}
let transcript: ThreadTranscript = { agent: "pi", owner: null, status: { state: "completed", run: "r", error: null }, events };

const sent: Array<{ what: string; bytes: number }> = [];
const streams = new Set<{ response: http.ServerResponse; from: number | null }>();
const body = (value: unknown) => JSON.stringify(value);
function frameFor(query: URLSearchParams): { text: string; from: number | null } {
  if (!window || ![...query.keys()].length) return { text: body(transcript), from: null };
  const shown = window.windowOf(transcript, window.windowQuery(query));
  return { text: body(shown), from: shown.start ?? 0 };
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url!, "http://host");
  const json = (text: string, what: string) => { sent.push({ what, bytes: Buffer.byteLength(text) }); response.writeHead(200, { "content-type": "application/json" }); response.end(text); };
  if (!url.pathname.startsWith("/api/")) {
    const file = path.join(DIST, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end(); return; }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[path.extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(fs.readFileSync(file));
    return;
  }
  const model = { provider: "faux", id: "faux-1" };
  switch (url.pathname) {
    case "/api/state": return json(body({ auth: { state: "ok", provider: "faux", credentialType: "api" }, onboardingComplete: true }), "state");
    case "/api/threads": return json(body({ threads: [] }), "threads");
    case "/api/projects": return json(body({ projects: [] }), "projects");
    case "/api/optchat/model": return json(body({ models: [model], selected: model, images: { supported: true, reason: null } }), "model");
    case "/api/optchat/threads": return json(body({ threads: [], archived: { shown: 0, total: 0 }, unknown: 0 }), "overview");
    case "/api/optchat/view": return json(body({ view: "<chat>\n</chat>", messages: 0, failure: null }), "view");
    case "/api/optchat/history": {
      if (window && url.searchParams.has("before")) return json(body(window.olderPage(transcript, window.pageQuery(url.searchParams))), "older page");
      return json(frameFor(url.searchParams).text, "history");
    }
    case "/api/optchat/stream": {
      const { text, from } = frameFor(url.searchParams);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sent.push({ what: "first frame", bytes: Buffer.byteLength(text) });
      response.write(`data: ${text}\n\n`);
      const stream = { response, from };
      streams.add(stream);
      response.on("close", () => streams.delete(stream));
      return;
    }
    default: response.writeHead(404); response.end("{}");
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Appends one agent message and sends it to every stream, as cubed would. */
function append(text: string): number {
  transcript = { ...transcript, events: [...transcript.events, { type: "assistant-text", id: `${transcript.events.length * 10 + 1}.0.0`, text, reasoning: false, final: true }] };
  let bytes = 0;
  for (const stream of streams) {
    const shown = stream.from === null || !window ? transcript : window.windowOf(transcript, { from: stream.from });
    const text = body(shown);
    bytes = Buffer.byteLength(text);
    stream.response.write(`data: ${text}\n\n`);
  }
  return bytes;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const browser = await chromium.launch();
const loads: number[] = [], updates: number[] = [], rows: number[] = [], frameBytes: number[] = [];
let firstBytes: Array<{ what: string; bytes: number }> = [];
for (let run = 0; run < RUNS; run++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  sent.length = 0;
  const started = Date.now();
  await page.goto(`${base}/#/chat`);
  await page.getByText(`answer ${TURNS - 1}:`).waitFor({ timeout: 120_000 });
  loads.push(Date.now() - started);
  rows.push(await page.locator(".conversation-message, .tool-strip").count());
  if (run === 0) firstBytes = sent.filter(item => ["history", "first frame"].includes(item.what));
  for (let update = 0; update < 5; update++) {
    const marker = `live update ${run}.${update}`;
    const at = Date.now();
    frameBytes.push(append(marker));
    await page.getByText(marker).waitFor({ timeout: 60_000 });
    updates.push(Date.now() - at);
  }
  await page.close();
}
await browser.close();
for (const stream of streams) stream.response.destroy();
server.close();

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(JSON.stringify({
  build: window ? "windowed server, this UI" : "whole transcript",
  turns: TURNS, events: events.length, wholeTranscript: kb(Buffer.byteLength(body({ ...transcript, events }))),
  runs: RUNS,
  initial: firstBytes.map(item => `${item.what} ${kb(item.bytes)}`),
  liveFrame: `median ${kb(median(frameBytes))} (n=${frameBytes.length})`,
  loadToNewestMs: { median: median(loads), all: loads },
  updateToPaintMs: { median: median(updates), min: Math.min(...updates), max: Math.max(...updates), n: updates.length },
  renderedRows: rows,
}, null, 2));
