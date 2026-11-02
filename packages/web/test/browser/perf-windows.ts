/** perf-windows: how long a cube window takes to load while other windows
 * of the same browser are open. Launches the isolated verify-cube host
 * (packages/server/test/verify-host.ts: real cubed, faux model, local guest,
 * disposable state), seeds a bounded history (archived thread rows and
 * OptChat turns), opens N background windows in one browser context (one
 * profile, as a user's windows share one), then loads a fresh probe window
 * and times it. Prints JSON: per scenario the probe's time to a usable chat,
 * each probe request's queueing and server wait, cubed's handler times and
 * event-loop delay, and the request rate the idle windows cause.
 *
 *   node packages/web/test/browser/perf-windows.ts [--windows 0,2,4,5,6,8] [--runs 5]
 *     [--archived 300] [--turns 40] [--route chat|thread] [--timeout MS] [--hidden]
 *     [--separate] [--active BYTES] [--strace] [--out FILE]
 *
 * --separate: each background window in a browser context of its own (its
 * own connections, as other browsers or devices have), so the host serves
 * every window's stream. --active BYTES: while the windows are measured, the
 * thread runs a tool whose output is BYTES long and the faux model streams
 * it back. --strace: count cubed's fsync/fdatasync calls and their time
 * during the measured window (needs strace and sudo).
 *
 * --hidden: the background windows say they are hidden (background tabs),
 * emulated by overriding `document.hidden`, as headless Chromium shows
 * every page.
 *
 * Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chromium, type Page } from "playwright";
import { startVerifyHost } from "../../../server/test/verify-host.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1] ?? fallback; };
const windowCounts = flag("--windows", "0,2,4,5,6,8").split(",").map(Number);
const runs = Number(flag("--runs", "5"));
const archived = Number(flag("--archived", "300"));
const turns = Number(flag("--turns", "40"));
const route = flag("--route", "chat");
const out = flag("--out", "");
const timeout = Number(flag("--timeout", "20000"));
const hideBackground = argv.includes("--hidden");
const separate = argv.includes("--separate");
const active = Number(flag("--active", "0"));
const traceSyncs = argv.includes("--strace");

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
};
const summary = (values: number[]) => ({ n: values.length, p50: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) });

const host = await startVerifyHost({ scratch: path.join(os.tmpdir(), `perf-windows-${Date.now()}`) });
const post = async (route: string, body: unknown) => {
  const response = await fetch(`${host.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, `${route}: ${response.status} ${text}`);
  return JSON.parse(text);
};
const get = async (route: string) => (await fetch(`${host.url}${route}`)).json();

type Handled = { at: number; route: string; ms: number; stream: boolean };
let handled: Handled[] = [];
let frames = 0, frameBytes = 0;
host.server.prependListener("request", (request: IncomingMessage, response: ServerResponse) => {
  const started = performance.now();
  const route = (request.url ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");
  const stream = route.includes("/stream");
  if (stream) {
    const write = response.write.bind(response) as (chunk: unknown, ...rest: unknown[]) => boolean;
    response.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string" && chunk.startsWith("data:")) { frames++; frameBytes += chunk.length; }
      return write(chunk, ...rest);
    }) as typeof response.write;
  }
  response.on("finish", () => handled.push({ at: started, route, ms: performance.now() - started, stream }));
});

try {
  const project = (await post("/api/projects", { name: "demo", repositories: [{ url: host.repository, base: "main" }] })).project;
  const thread = (await post("/api/threads", { projectId: project.id, requestId: randomUUID(), model: host.model, text: "hello" })).id as string;
  const settled = async (base: string) => {
    for (let i = 0; i < 300; i++) {
      const transcript = await get(`${base}/history?tail=1`);
      if (transcript.status && transcript.status.state !== "working" && transcript.events?.length) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${base} did not settle`);
  };
  await settled(`/api/threads/${thread}`);
  for (let i = 0; i < turns; i++) {
    await post("/api/optchat/prompt", { text: `turn ${i}: ${"synthetic history line. ".repeat(20)}`, model: host.model, requestId: randomUUID() });
    await settled("/api/optchat");
  }
  // Archived rows: copies of the real thread's row, as a long-lived install keeps hundreds.
  const db = new DatabaseSync(path.join(host.state, "registry.sqlite"), { timeout: 5000 });
  const row = db.prepare("SELECT project_id, runner_id, data FROM thread WHERE id=?").get(thread) as { project_id: string; runner_id: string; data: string };
  const insert = db.prepare("INSERT INTO thread VALUES (?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < archived; i++) {
    const id = randomUUID();
    insert.run(id, row.project_id, row.runner_id, JSON.stringify({ ...JSON.parse(row.data), id, archived: true, title: `archived synthetic ${i}`, createdAt: Date.now() - i * 60000 }));
  }
  db.exec("COMMIT");
  db.close();

  const target = route === "thread" ? `#/t/${thread}` : "#/chat";
  const ready = async (page: Page) => {
    const deadline = Date.now() + timeout;
    await page.locator(".composer textarea").first().waitFor({ state: "visible", timeout });
    await page.locator(`${route === "thread" ? ".page-panel " : ""}.conversation-message`).first().waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
  };
  const browser = await chromium.launch();
  const results: unknown[] = [];
  try {
    const newContext = async () => {
      const made = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await made.addInitScript(() => {
        const state = window as unknown as { cubeHidden?: boolean };
        Object.defineProperty(document, "hidden", { get: () => !!state.cubeHidden });
        Object.defineProperty(document, "visibilityState", { get: () => state.cubeHidden ? "hidden" : "visible" });
      });
      return made;
    };
    const context = await newContext();
    const background: Page[] = [];
    let stuck = 0;
    for (const count of windowCounts) {
      while (background.length < count) {
        const page = await (separate ? await newContext() : context).newPage();
        await page.goto(`${host.url}/${target}`, { timeout }).catch(() => {});
        await ready(page).catch(() => { stuck++; });
        if (hideBackground) await page.evaluate(() => { (window as unknown as { cubeHidden?: boolean }).cubeHidden = true; document.dispatchEvent(new Event("visibilitychange")); });
        background.push(page);
      }
      while (background.length > count) { const page = background.pop()!; await (separate ? page.context().close() : page.close()); }
      await new Promise(resolve => setTimeout(resolve, 3000));
      const memoryBefore = process.memoryUsage();
      if (active) {
        await post(`/api/threads/${thread}/prompt`, { text: `tool {"name":"bash","args":{"command":"head -c ${active} /dev/zero | tr '\\\\0' a"}}`, model: host.model, requestId: randomUUID() });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const tracing = traceSyncs ? spawn("sudo", ["strace", "-f", "-T", "-qq", "-e", "trace=fsync,fdatasync", "-p", String(process.pid)], { stdio: ["ignore", "ignore", "pipe"] }) : null;
      let traced = "";
      tracing?.stderr.on("data", chunk => { traced += chunk; });
      let heapPeak = 0, rssPeak = 0;
      const sampler = setInterval(() => { const m = process.memoryUsage(); heapPeak = Math.max(heapPeak, m.heapUsed); rssPeak = Math.max(rssPeak, m.rss); }, 250);
      // Idle load: what the open windows cost cubed with nobody touching them.
      handled = [];
      frames = 0; frameBytes = 0;
      const loop = monitorEventLoopDelay({ resolution: 5 });
      loop.enable();
      const cpu = process.cpuUsage();
      const idleMs = 15000;
      await new Promise(resolve => setTimeout(resolve, idleMs));
      loop.disable();
      clearInterval(sampler);
      const used = process.cpuUsage(cpu);
      if (tracing) { spawn("sudo", ["kill", "-INT", String(tracing.pid)]); await new Promise(resolve => tracing.on("exit", resolve)); }
      const syncs = [...traced.matchAll(/(fsync|fdatasync)\(.*<([\d.]+)>/g)].map(match => Number(match[2]) * 1000);
      const idle = { activeBytes: active,
        heapMb: { before: Math.round(memoryBefore.heapUsed / 1e6), peak: Math.round(heapPeak / 1e6) }, rssMb: { before: Math.round(memoryBefore.rss / 1e6), peak: Math.round(rssPeak / 1e6) },
        ...tracing ? { syncs: { count: syncs.length, totalMs: Math.round(syncs.reduce((a, b) => a + b, 0)), ms: summary(syncs) } } : {},
        streamFrames: { perSecond: Math.round(frames / (idleMs / 1000)), mbPerSecond: Math.round(frameBytes / (idleMs / 1000) / 1e4) / 100 },
        requestsPerSecond: Math.round(handled.filter(h => !h.stream).length / (idleMs / 1000) * 10) / 10,
        cpuPercent: Math.round((used.user + used.system) / 10 / idleMs * 10) / 10,
        handlerMs: summary(handled.filter(h => !h.stream).map(h => h.ms)),
        loopDelayMs: { p50: Math.round(loop.percentile(50) / 1e5) / 10, p99: Math.round(loop.percentile(99) / 1e5) / 10, max: Math.round(loop.max / 1e5) / 10 },
        routes: Object.fromEntries([...new Set(handled.filter(h => !h.stream).map(h => h.route))].map(r => [r, summary(handled.filter(h => h.route === r).map(h => h.ms))])) };
      const probes: Array<{ readyMs: number; requests: Array<{ url: string; queuedMs: number; waitMs: number; totalMs: number }> }> = [];
      for (let run = 0; run < runs; run++) {
        handled = [];
        const page = await context.newPage();
        const requests: Array<{ url: string; queuedMs: number; waitMs: number; totalMs: number }> = [];
        page.on("requestfinished", request => {
          const timing = request.timing();
          requests.push({ url: request.url().replace(host.url, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id"),
            queuedMs: Math.round(timing.requestStart), waitMs: Math.round(timing.responseStart - timing.requestStart), totalMs: Math.round(timing.responseEnd) });
        });
        const started = performance.now();
        await page.goto(`${host.url}/${target}`, { timeout }).catch(() => {});
        let readyMs: number;
        try { await ready(page); readyMs = Math.round(performance.now() - started); }
        catch { readyMs = -1; }
        await page.close();
        probes.push({ readyMs, requests });
      }
      if (active) await settled(`/api/threads/${thread}`);
      const all = probes.flatMap(probe => probe.requests);
      results.push({ windows: count, backgroundNotReady: stuck, idle, probe: {
        readyMs: summary(probes.map(probe => probe.readyMs).filter(ms => ms >= 0)), failed: probes.filter(probe => probe.readyMs < 0).length,
        readyRuns: probes.map(probe => probe.readyMs),
        queuedMs: summary(all.map(r => r.queuedMs)), serverWaitMs: summary(all.map(r => r.waitMs)),
        slowest: all.sort((a, b) => b.totalMs - a.totalMs).slice(0, 5) } });
      console.error(`windows=${count} ready=${JSON.stringify((results.at(-1) as any).probe.readyMs)} queued=${JSON.stringify((results.at(-1) as any).probe.queuedMs)} idle=${idle.requestsPerSecond}/s`);
    }
  } finally {
    await browser.close();
  }
  const report = { route, hiddenBackground: hideBackground, separate, active, archived, turns, runs, cpus: os.cpus().length, node: process.version, results };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text);
  process.stdout.write(text);
} finally {
  await host.close();
}
process.exit(0);
