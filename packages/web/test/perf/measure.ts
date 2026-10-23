/** Measures the built UI against the real cubed over a seeded root
 * (packages/server/test/perf/seed.ts) in Google Chrome over CDP. Not a
 * test: it writes numbers, traces and screenshots. The seeded root is
 * copied first, so a run never changes it; the server runs as its own
 * process (serve.ts) and logs every request's server-side time.
 *
 *   pnpm build
 *   node packages/web/test/perf/measure.ts --root /path/seeded --out /path/results [--runs 5] [--trace] [--profile] [--only api,chat,older,thread,lists,phone,idle,leak,send]
 *
 * --trace writes Chrome traces (DevTools Performance panel, ui.perfetto.dev)
 * of the first cold chat load and the first older-page scroll; --profile
 * runs the server under `node --cpu-prof` (a .cpuprofile in --out).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";

const { values: args } = parseArgs({ options: {
  root: { type: "string" }, out: { type: "string" }, runs: { type: "string", default: "5" }, trace: { type: "boolean", default: false },
  chrome: { type: "string", default: "/usr/bin/google-chrome" }, port: { type: "string", default: "7799" }, only: { type: "string" },
  headed: { type: "boolean", default: false }, tps: { type: "string", default: "60" }, profile: { type: "boolean", default: false },
} });
if (!args.root || !args.out) { console.error("usage: measure.ts --root <seeded root> --out <dir> [--runs N] [--trace]"); process.exit(2); }
const REPO = path.resolve(import.meta.dirname, "../../../..");
const RUNS = Number(args.runs);
const out = path.resolve(args.out);
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(args.root, "manifest.json"), "utf8"));
const only = args.only ? new Set(args.only.split(",")) : null;
const want = (name: string) => !only || only.has(name);
const log = (...items: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...items);

// ---- a fresh copy of the seeded root, served by its own process ----
const scratch = path.join(os.tmpdir(), "pf", path.basename(path.resolve(args.root)));
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.dirname(scratch), { recursive: true });
execFileSync("cp", ["-a", path.resolve(args.root), scratch]);
fs.rmSync(path.join(scratch, "requests.jsonl"), { force: true });
const base = `http://127.0.0.1:${args.port}`;
let server = undefined as unknown as ChildProcess;
let serverStart: { openMs: number; listenMs: number; pid: number } = { openMs: 0, listenMs: 0, pid: 0 };
async function startServer(): Promise<void> {
  server = spawn(process.execPath, [...args.profile ? ["--cpu-prof", "--cpu-prof-dir", out] : [], path.join(REPO, "packages/server/test/perf/serve.ts"), scratch, args.port!, String(manifest.seed)],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PERF_TPS: args.tps } });
  const serverLog = fs.createWriteStream(path.join(out, "server.log"), { flags: "a" });
  server.stderr!.pipe(serverLog);
  serverStart = await new Promise((resolve, reject) => {
    let buffer = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      serverLog.write(chunk);
      buffer += chunk.toString();
      const line = buffer.split("\n").find(item => item.startsWith("{\"ready\""));
      if (line) resolve(JSON.parse(line));
    });
    server.on("exit", code => reject(new Error(`server exited ${code}`)));
  });
}
async function stopServer(): Promise<void> {
  server.kill("SIGINT");
  await new Promise(resolve => server.once("exit", resolve));
}
/** The server's CPU share over `ms`, from /proc. */
async function serverCpu(ms: number): Promise<number> {
  const ticks = () => { const fields = fs.readFileSync(`/proc/${serverStart.pid}/stat`, "utf8").split(") ")[1]!.split(" "); return Number(fields[11]) + Number(fields[12]); };
  const before = ticks();
  await delay(ms);
  return ((ticks() - before) / 100) / (ms / 1000);
}
async function settle(): Promise<void> {
  // Until the server is quiet (opening threads at start, a poll's work).
  for (let k = 0; k < 30 && await serverCpu(1000) > 0.1; k++);
}
const get = async (route: string) => { const response = await fetch(`${base}${route}`); return { status: response.status, text: await response.text() }; };
const json = async (route: string) => JSON.parse((await get(route)).text);

// ---- statistics ----
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const quantile = (values: number[], q: number) => { const s = sorted(values); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN; };
const stats = (values: number[]) => ({ n: values.length, median: round(quantile(values, 0.5)), min: round(Math.min(...values)), max: round(Math.max(...values)), p90: round(quantile(values, 0.9)) });
const round = (value: number) => Math.round(value * 10) / 10;

// ---- what the page records ----
const INIT = () => {
  const perf = { longtasks: [] as Array<{ start: number; duration: number }>, events: [] as Array<Record<string, unknown>>, loaf: [] as Array<Record<string, unknown>>, frames: [] as number[] };
  (window as unknown as { __perf: typeof perf }).__perf = perf;
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) perf.longtasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true }); } catch { /* unsupported */ }
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) perf.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration, id: (entry as PerformanceEventTiming & { interactionId: number }).interactionId,
        inputDelay: entry.processingStart - entry.startTime, processing: entry.processingEnd - entry.processingStart, presentation: entry.startTime + entry.duration - entry.processingEnd });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch { /* unsupported */ }
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as unknown as Array<{ startTime: number; duration: number; blockingDuration: number; renderStart: number; styleAndLayoutStart: number; scripts: Array<{ duration: number; invoker: string; sourceURL: string; sourceFunctionName: string; forcedStyleAndLayoutDuration: number }> }>) {
        perf.loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration,
          render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0, styleLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
          scripts: [...entry.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3).map(script => ({ d: Math.round(script.duration), forced: Math.round(script.forcedStyleAndLayoutDuration), invoker: script.invoker, fn: script.sourceFunctionName, src: script.sourceURL.split("/").pop() })) });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch { /* unsupported */ }
};
type PagePerf = { longtasks: Array<{ start: number; duration: number }>; events: Array<{ name: string; start: number; duration: number; id: number; inputDelay: number; processing: number; presentation: number }>; loaf: Array<{ start: number; duration: number; blocking: number; render: number; styleLayout: number; scripts: unknown[] }> };
const now = (page: Page) => page.evaluate(() => performance.now());
const pagePerf = (page: Page) => page.evaluate(() => (window as unknown as { __perf: PagePerf }).__perf) as Promise<PagePerf>;
/** Long tasks and long frames between two page times. */
async function mainThread(page: Page, from: number, to: number) {
  const perf = await pagePerf(page);
  const tasks = perf.longtasks.filter(task => task.start >= from && task.start <= to);
  const frames = perf.loaf.filter(frame => frame.start >= from && frame.start <= to);
  return { longTasks: tasks.length, longTaskMs: round(tasks.reduce((sum, task) => sum + task.duration, 0)), maxLongTaskMs: round(Math.max(0, ...tasks.map(task => task.duration))),
    tbtMs: round(tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)), longFrames: frames.length,
    worstFrames: frames.sort((a, b) => b.duration - a.duration).slice(0, 2).map(frame => ({ ms: round(frame.duration), styleLayoutMs: round(frame.styleLayout), scripts: frame.scripts })) };
}
const METRICS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "Nodes", "JSEventListeners", "Documents"] as const;
async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.filter(item => (METRICS as readonly string[]).includes(item.name)).map(item => [item.name, item.value]));
}
function delta(before: Record<string, number>, after: Record<string, number>) {
  const ms = (name: string) => round((after[name]! - before[name]!) * 1000);
  return { taskMs: ms("TaskDuration"), scriptMs: ms("ScriptDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration"),
    layouts: after.LayoutCount! - before.LayoutCount!, styles: after.RecalcStyleCount! - before.RecalcStyleCount!,
    heapMB: round(after.JSHeapUsedSize! / 1048576), nodes: after.Nodes!, listeners: after.JSEventListeners! };
}
/** Requests the server logged between two wall times, summed by route. */
function serverRequests(fromWall: number, toWall: number) {
  const file = path.join(scratch, "requests.jsonl");
  if (!fs.existsSync(file)) return {};
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { at: number; url: string; headersMs: number; totalMs: number; bytes: number });
  const byRoute: Record<string, { n: number; headersMs: number[]; bytes: number }> = {};
  for (const row of rows) {
    if (row.at < fromWall || row.at > toWall + 50) continue;
    if (!row.url.startsWith("/api/")) continue;
    const route = row.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/=\d+/g, "=N");
    const item = byRoute[route] ??= { n: 0, headersMs: [], bytes: 0 };
    item.n++; item.headersMs.push(row.headersMs); item.bytes += row.bytes;
  }
  return Object.fromEntries(Object.entries(byRoute).map(([route, item]) => [route, { n: item.n, headersMsMedian: round(quantile(item.headersMs, 0.5)), headersMsMax: round(Math.max(...item.headersMs)), kib: round(item.bytes / 1024) }]));
}
/** Resolves at the first frame where `check` holds, with the page's time. */
function whenTrue(page: Page, check: string, timeout = 120_000): Promise<number> {
  return page.evaluate(({ check, timeout }) => new Promise<number>((resolve, reject) => {
    const test = new Function(`return (${check})`) as () => boolean;
    const end = performance.now() + timeout;
    const step = () => {
      let ok = false;
      try { ok = !!test(); } catch { /* not yet */ }
      if (ok) resolve(performance.now());
      else if (performance.now() > end) reject(new Error(`timed out: ${check}`));
      else requestAnimationFrame(step);
    };
    step();
  }), { check, timeout });
}
const shown = (anchor: string) => `(() => { const e = document.querySelector(${JSON.stringify(`.transcript-column [data-anchor="${anchor}"]`)}); const s = document.querySelector(".transcript"); return !!e && e.getBoundingClientRect().height > 0 && s.scrollHeight - s.scrollTop - s.clientHeight < 130; })()`;
const anchorOf = (events: Array<{ type: string; id: string; callId?: string }>) => { const last = events.at(-1)!; return last.type === "tool-call" || last.type === "tool-result" ? `call:${last.callId}` : last.id; };
const twoFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// ---- the run ----
const results: Record<string, unknown> = {};
const pageErrors: Array<{ url: string; error: string }> = [];
const write = () => fs.writeFileSync(path.join(out, "results.json"), `${JSON.stringify({ ...results, pageErrors }, null, 2)}\n`);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
let browser = undefined as unknown as Browser;
async function newContext(viewport = DESKTOP, phone = false): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession }> {
  const context = await browser.newContext({ viewport, ...phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {} });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" } as never).catch(() => cdp.send("Performance.enable"));
  page.on("pageerror", error => { log("page error:", page.url().replace(base, ""), String(error)); pageErrors.push({ url: page.url().replace(base, ""), error: String(error.stack ?? error).slice(0, 1500) }); });
  return { context, page, cdp };
}
async function traced<T>(page: Page, name: string, run: () => Promise<T>): Promise<T> {
  if (!args.trace) return run();
  await browser.startTracing(page, { path: path.join(out, `trace-${name}.json`), screenshots: true });
  try { return await run(); } finally { await browser.stopTracing(); }
}

try {
  await startServer();
  log("server", serverStart);
  await settle();
  const version = execFileSync(args.chrome!, ["--version"], { encoding: "utf8" }).trim();
  browser = await chromium.launch({ executablePath: args.chrome, headless: !args.headed });
  results.environment = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(), seededCommit: manifest.commit,
    chrome: version, browserVersion: browser.version(), headless: !args.headed, node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    memGiB: round(os.totalmem() / 2 ** 30), kernel: os.release(), runs: RUNS, viewport: DESKTOP, phone: PHONE,
    note: "server and Chrome share this VM; no GPU (software raster); CPU not throttled",
  };
  results.scale = { name: manifest.scale, seed: manifest.seed, counts: manifest.counts, bytes: manifest.bytes };
  results.serverStart = serverStart;
  write();

  // What the routes cost on the server, without a browser: sequential, warm.
  const tail = await json("/api/optchat/history?tail=120");
  const chatLast = anchorOf(tail.events);
  const artifacts = (await json("/api/artifacts")).artifacts as Array<{ id: string; head: number }>;
  const busiest = [...artifacts].sort((a, b) => b.head - a.head)[0];
  const longThread = manifest.counts.longThread as string;
  if (want("api")) {
    const routes = ["/api/state", "/api/threads?includeArchived=1", "/api/threads", "/api/projects", "/api/optchat/threads", "/api/artifacts",
      "/api/optchat/model", "/api/optchat/view", "/api/optchat/history?tail=120", `/api/optchat/history?before=${tail.start}&limit=120`, "/api/optchat/history",
      `/api/threads/${longThread}/history?tail=120`, `/api/threads/${longThread}/history`, ...busiest ? [`/api/artifacts/${busiest.id}`] : [], "/api/usage", "/api/runners"];
    const api: Record<string, unknown> = {};
    for (const route of routes) {
      const times: number[] = [];
      let bytes = 0, status = 0;
      for (let k = 0; k < 2 + Math.max(RUNS, 8); k++) {
        const at = performance.now();
        const response = await get(route);
        if (k >= 2) times.push(performance.now() - at);
        bytes = Buffer.byteLength(response.text); status = response.status;
      }
      api[route.replace(longThread, ":long").replace(busiest?.id ?? "-", ":busiest")] = { status, kib: round(bytes / 1024), ...stats(times) };
    }
    results.api = api;
    write();
    log("api done");
  }

  // 1. Chat: cold (a new profile) and warm (a reload), to the newest message.
  if (want("chat")) {
    const cold: Record<string, number[]> = { newestMs: [], ttfbMs: [], dclMs: [] };
    const warm: Record<string, number[]> = { newestMs: [] };
    const details: unknown[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { context, page, cdp } = await newContext();
      const wall = Date.now();
      const m0 = await metrics(cdp);
      const go = async () => {
        await page.goto(`${base}/#/chat`, { waitUntil: "commit" });
        return whenTrue(page, shown(chatLast));
      };
      const newest = run === 0 ? await traced(page, "chat-cold", go) : await go();
      await twoFrames(page);
      const nav = await page.evaluate(() => { const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming; return { ttfb: entry.responseStart, dcl: entry.domContentLoadedEventEnd }; });
      cold.newestMs!.push(newest); cold.ttfbMs!.push(nav.ttfb); cold.dclMs!.push(nav.dcl);
      const m1 = await metrics(cdp);
      details.push({ run, newestMs: round(newest), ...delta(m0, m1), main: await mainThread(page, 0, newest + 50), rows: await page.locator(".transcript-column [data-anchor]").count(), server: serverRequests(wall, Date.now()) });
      if (run === 0) await page.screenshot({ path: path.join(out, "chat-desktop.png") });
      await page.reload({ waitUntil: "commit" });
      warm.newestMs!.push(await whenTrue(page, shown(chatLast)));
      await context.close();
    }
    results.chat = { cold: Object.fromEntries(Object.entries(cold).map(([key, values]) => [key, stats(values)])), warmReload: stats(warm.newestMs!), runs: details };
    write();
    log("chat", JSON.stringify((results.chat as { cold: unknown }).cold));
  }

  // 2. Older messages: scroll to the top again and again; each page's time
  // from the scroll to its rows in the DOM, the main thread meanwhile, then
  // typing in the composer with that much history in the DOM.
  const scrollOlder = async (route: string, last: string, label: string, pages: number) => {
    const runs: unknown[] = [];
    const pageTimes: number[] = [], typing: number[] = [], typingEarly: number[] = [];
    for (let run = 0; run < Math.min(RUNS, 3); run++) {
      const { context, page, cdp } = await newContext();
      await page.goto(`${base}/${route}`, { waitUntil: "commit" });
      await whenTrue(page, shown(last));
      await twoFrames(page);
      // Typing with only the first window in the DOM.
      typingEarly.push(...await typeInComposer(page, `${label}-early-${run}`));
      const m0 = await metrics(cdp);
      const t0 = await now(page);
      const wall = Date.now();
      const steps: Array<{ ms: number; rows: number }> = [];
      const step = async () => {
        for (let k = 0; k < pages; k++) {
          const before = await page.locator(".transcript-column [data-anchor]").count();
          const more = await page.locator(".transcript-earlier").count();
          if (!more) break;
          const at = await now(page);
          await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
          const done = await whenTrue(page, `document.querySelectorAll(".transcript-column [data-anchor]").length > ${before} || !document.querySelector(".transcript-earlier")`, 30_000).catch(() => NaN);
          await twoFrames(page);
          steps.push({ ms: round(done - at), rows: await page.locator(".transcript-column [data-anchor]").count() });
          pageTimes.push(done - at);
        }
      };
      await (run === 0 ? traced(page, `${label}-older`, step) : step());
      const m1 = await metrics(cdp);
      const t1 = await now(page);
      // Scrolling through what is loaded, by wheel: frame times.
      const frames = await page.evaluate(async () => {
        const scroller = document.querySelector(".transcript")!;
        const times: number[] = [];
        let last = performance.now();
        let going = true;
        const tick = (time: number) => { times.push(time - last); last = time; if (going) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        for (let k = 0; k < 60; k++) { scroller.scrollBy({ top: 400 }); await new Promise(resolve => setTimeout(resolve, 16)); }
        going = false;
        return times;
      });
      typing.push(...await typeInComposer(page, `${label}-late-${run}`));
      runs.push({ run, steps, total: { ms: round(t1 - t0), ...delta(m0, m1) }, main: await mainThread(page, t0, t1), server: serverRequests(wall, Date.now()),
        scrollFrames: { n: frames.length, medianMs: round(quantile(frames, 0.5)), p95Ms: round(quantile(frames, 0.95)), over50: frames.filter(time => time > 50).length } });
      if (run === 0) await page.screenshot({ path: path.join(out, `${label}-older.png`) });
      await context.close();
    }
    return { pageMs: stats(pageTimes.filter(Number.isFinite)), typingFirstWindow: stats(typingEarly), typingAfterOlder: stats(typing), runs };
  };
  /** Types into the composer; each keystroke's interaction duration (Event Timing). */
  async function typeInComposer(page: Page, label: string): Promise<number[]> {
    const composer = page.locator(".composer textarea");
    await composer.click();
    const from = await now(page);
    await page.keyboard.type("the runner answered and the gateway attached the machine, then the thread went on with its work as planned", { delay: 30 });
    await delay(300);
    const perf = await pagePerf(page);
    const byInteraction = new Map<number, number>();
    for (const event of perf.events) if (event.start >= from && event.id) byInteraction.set(event.id, Math.max(byInteraction.get(event.id) ?? 0, event.duration));
    await composer.fill("");
    void label;
    // Every keystroke under the 16 ms threshold counts as 16 at most: report those above it as measured.
    const keys = 104;
    return [...byInteraction.values(), ...Array.from({ length: Math.max(0, keys - byInteraction.size) }, () => 16)];
  }
  if (want("older")) {
    results.chatOlder = await scrollOlder("#/chat", chatLast, "chat", 25);
    write();
    log("chat older", JSON.stringify((results.chatOlder as { pageMs: unknown }).pageMs));
  }
  if (want("thread") && longThread) {
    const threadTail = await json(`/api/threads/${longThread}/history?tail=120`);
    const threadLast = anchorOf(threadTail.events);
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await newContext();
      await page.goto(`${base}/#/t/${longThread}`, { waitUntil: "commit" });
      times.push(await whenTrue(page, shown(threadLast)));
      if (run === 0) await page.screenshot({ path: path.join(out, "thread-desktop.png") });
      await context.close();
    }
    results.thread = { coldNewestMs: stats(times), older: await scrollOlder(`#/t/${longThread}`, threadLast, "thread", 15) };
    write();
    log("thread", JSON.stringify(results.thread).slice(0, 300));
  }

  // 3. Lists: threads (desktop), its project filter, artifacts, one artifact and its revisions.
  if (want("lists")) {
    const projects = (await json("/api/projects")).projects as Array<{ id: string; name: string }>;
    const active = (await json("/api/threads")).threads as Array<{ project: { id: string } }>;
    const threadsList: number[] = [], filter: number[] = [], artifactsList: number[] = [], artifactOpen: number[] = [], revisionSwitch: number[] = [];
    const runs: unknown[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { context, page, cdp } = await newContext();
      const m0 = await metrics(cdp);
      await page.goto(`${base}/#/threads`, { waitUntil: "commit" });
      threadsList.push(await whenTrue(page, `document.querySelectorAll(".thread-list .module").length >= ${active.length}`));
      const m1 = await metrics(cdp);
      // Filter by the project with the most threads, then back to all.
      const top = projects.map(project => ({ project, n: active.filter(thread => thread.project.id === project.id).length })).sort((a, b) => b.n - a.n)[0]!;
      let at = await now(page);
      await page.locator("select[aria-label='filter threads by project']").selectOption(top.project.id);
      filter.push(await whenTrue(page, `document.querySelectorAll(".thread-list .module").length === ${top.n}`) - at);
      at = await now(page);
      await page.locator("select[aria-label='filter threads by project']").selectOption("");
      filter.push(await whenTrue(page, `document.querySelectorAll(".thread-list .module").length === ${active.length}`) - at);
      at = await now(page);
      await page.evaluate(() => { location.hash = "#/artifacts"; });
      artifactsList.push(await whenTrue(page, `document.querySelectorAll(".artifact-list li").length >= ${artifacts.length}`) - at);
      if (busiest) {
        at = await now(page);
        await page.evaluate(id => { location.hash = `#/a/${id}`; }, busiest.id);
        artifactOpen.push(await whenTrue(page, `!!document.querySelector(".artifact-body") && document.querySelector(".artifact-body").textContent.length > 50`) - at);
        if (run === 0) await page.screenshot({ path: path.join(out, "artifact-desktop.png") });
        for (const revision of [1, Math.ceil(busiest.head / 2)]) {
          if (revision >= busiest.head) continue;
          const text = await page.locator(".artifact-body").textContent();
          at = await now(page);
          await page.evaluate(({ id, revision }) => { location.hash = `#/a/${id}?rev=${revision}`; }, { id: busiest.id, revision });
          revisionSwitch.push(await whenTrue(page, `!!document.querySelector(".artifact-body") && document.querySelector(".artifact-body").textContent !== ${JSON.stringify(text)}`, 20_000).catch(() => NaN) - at);
        }
      }
      runs.push({ run, threadList: delta(m0, m1) });
      await context.close();
    }
    results.lists = { activeThreads: active.length, threadsListMs: stats(threadsList), projectFilterMs: stats(filter), artifactsListMs: stats(artifactsList), artifactOpenMs: stats(artifactOpen),
      revisionSwitchMs: stats(revisionSwitch.filter(Number.isFinite)), busiestRevisions: busiest?.head ?? 0, runs };
    write();
    log("lists", JSON.stringify(results.lists).slice(0, 400));
  }

  // 4. Phone: the chat, the index (open, filter typing), threads from the index, the project filter.
  if (want("phone")) {
    const load: number[] = [], indexOpen: number[] = [], indexTyping: number[] = [], toThreads: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { context, page } = await newContext(PHONE, true);
      await page.goto(`${base}/#/chat`, { waitUntil: "commit" });
      load.push(await whenTrue(page, shown(chatLast)));
      await twoFrames(page);
      if (run === 0) await page.screenshot({ path: path.join(out, "chat-phone.png") });
      let at = await now(page);
      await page.locator(".sheet-bar .name-key").tap();
      indexOpen.push(await whenTrue(page, `!!document.querySelector("dialog.chat-index[open]") && document.querySelector("dialog.chat-index").getBoundingClientRect().height > 100`) - at);
      await twoFrames(page);
      if (run === 0) await page.screenshot({ path: path.join(out, "index-phone.png") });
      const filterField = page.locator("dialog.chat-index input").first();
      await filterField.tap();
      const from = await now(page);
      await page.keyboard.type("review the runner", { delay: 40 });
      await delay(300);
      const perf = await pagePerf(page);
      const byInteraction = new Map<number, number>();
      for (const event of perf.events) if (event.start >= from && event.id) byInteraction.set(event.id, Math.max(byInteraction.get(event.id) ?? 0, event.duration));
      indexTyping.push(...byInteraction.values(), ...Array.from({ length: Math.max(0, 17 - byInteraction.size) }, () => 16));
      await filterField.fill("");
      at = await now(page);
      await page.locator("dialog.chat-index a[href='#/threads']").first().tap();
      toThreads.push(await whenTrue(page, `document.querySelectorAll(".thread-list .module").length > 0`) - at);
      if (run === 0) await page.screenshot({ path: path.join(out, "threads-phone.png") });
      await context.close();
    }
    results.phone = { chatNewestMs: stats(load), indexOpenMs: stats(indexOpen), indexFilterKeyMs: stats(indexTyping), indexToThreadsMs: stats(toThreads) };
    write();
    log("phone", JSON.stringify(results.phone));
  }

  // 5. Idle: a page left open, by route. Main-thread time per minute (CDP
  // TaskDuration) and what the polls cost the server.
  if (want("idle")) {
    const idle: Record<string, unknown> = {};
    for (const route of ["#/chat", "#/threads", `#/t/${longThread}`, "#/artifacts"]) {
      const { context, page, cdp } = await newContext();
      await page.goto(`${base}/${route}`, { waitUntil: "load" });
      await delay(5000);
      const m0 = await metrics(cdp);
      const wall = Date.now();
      const t0 = await now(page);
      const cpu = serverCpu(30_000);
      await delay(30_000);
      const t1 = await now(page);
      const m1 = await metrics(cdp);
      idle[route.replace(longThread, ":long")] = { seconds: 30, ...delta(m0, m1), main: await mainThread(page, t0, t1), serverCpuShare: round(await cpu * 100) / 100, server: serverRequests(wall, Date.now()) };
      await context.close();
    }
    results.idle = idle;
    write();
    log("idle", JSON.stringify(idle).slice(0, 400));
  }

  // 6. Leaks: one page, every route again and again; after a forced GC,
  // heap, nodes, listeners and documents per round.
  if (want("leak")) {
    const { context, page, cdp } = await newContext();
    await page.goto(`${base}/#/chat`, { waitUntil: "commit" });
    await whenTrue(page, shown(chatLast));
    const routes = ["#/threads", `#/t/${longThread}`, "#/artifacts", ...busiest ? [`#/a/${busiest.id}`] : [], "#/projects", "#/chat"];
    const rounds: unknown[] = [];
    for (let round_ = 0; round_ <= 15; round_++) {
      if (round_ > 0) for (const route of routes) {
        await page.evaluate(hash => { location.hash = hash; }, route);
        await delay(700);
      }
      await delay(1000);
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const m = await metrics(cdp);
      rounds.push({ round: round_, heapMB: round(m.JSHeapUsedSize! / 1048576), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents });
    }
    // Which route keeps its nodes: chat -> route -> chat, eight times each;
    // the elements no longer in the document that the heap still holds, by class.
    const detached = async () => {
      const proto = await cdp.send("Runtime.evaluate", { expression: "HTMLElement.prototype" });
      const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId! });
      const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: objects.objectId!, returnByValue: true,
        functionDeclaration: "function () { const m = {}; let n = 0; for (const e of this) { let gone = false; try { gone = !e.isConnected; } catch { continue; } if (!gone) continue; n++; const k = (e.tagName.toLowerCase() + '.' + (typeof e.className === 'string' ? e.className.trim().split(/\\s+/)[0] : '')); m[k] = (m[k] || 0) + 1; } return { n, top: Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8) }; }" });
      await cdp.send("Runtime.releaseObject", { objectId: objects.objectId! });
      return result.value as { n: number; top: Array<[string, number]> };
    };
    const byRoute: Record<string, unknown> = {};
    for (const route of routes.filter(item => item !== "#/chat")) {
      await page.evaluate(() => { location.hash = "#/chat"; });
      await delay(1500);
      await cdp.send("HeapProfiler.collectGarbage");
      const before = await metrics(cdp);
      for (let k = 0; k < 8; k++) {
        await page.evaluate(hash => { location.hash = hash; }, route);
        await delay(700);
        await page.evaluate(() => { location.hash = "#/chat"; });
        await delay(700);
      }
      await delay(1000);
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const after = await metrics(cdp);
      byRoute[route.replace(/[0-9a-f-]{36}/, ":id")] = { nodesPerCycle: round((after.Nodes! - before.Nodes!) / 8), listenersPerCycle: round((after.JSEventListeners! - before.JSEventListeners!) / 8),
        heapKBPerCycle: round((after.JSHeapUsedSize! - before.JSHeapUsedSize!) / 1024 / 8), detached: await detached() };
    }
    results.leak = { routes: routes.map(route => route.replace(/[0-9a-f-]{36}/, ":id")), rounds, byRoute };
    write();
    log("leak", JSON.stringify(rounds.at(0)), JSON.stringify(rounds.at(-1)));
    await context.close();
  }

  // 7. A send in the chat while history is loaded: the reply streams (the
  // controlled model at --tps tokens/s); the main thread meanwhile. Changes
  // the copy, so last.
  if (want("send")) {
    const sends: unknown[] = [];
    for (const older of [0, 10]) for (let run = 0; run < Math.min(RUNS, 3); run++) {
      const { context, page, cdp } = await newContext();
      await page.goto(`${base}/#/chat`, { waitUntil: "commit" });
      await whenTrue(page, `!!document.querySelector(".transcript-column [data-anchor]")`);
      await delay(1000);
      for (let k = 0; k < older; k++) {
        const before = await page.locator(".transcript-column [data-anchor]").count();
        await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
        await whenTrue(page, `document.querySelectorAll(".transcript-column [data-anchor]").length > ${before} || !document.querySelector(".transcript-earlier")`, 30_000).catch(() => 0);
      }
      const rows = await page.locator(".transcript-column [data-anchor]").count();
      const text = `perf send ${older} ${run}: how are the threads doing`;
      await page.locator(".composer textarea").fill(text);
      const m0 = await metrics(cdp);
      const t0 = await now(page);
      const wall = Date.now();
      await page.locator(".composer textarea").press("Enter");
      const shownAt = await whenTrue(page, `[...document.querySelectorAll(".conversation-message.user")].some(e => e.textContent.includes(${JSON.stringify(text)}))`);
      await whenTrue(page, `document.querySelector(".composer").getAttribute("aria-busy") === "true"`, 10_000).catch(() => 0);
      const doneAt = await whenTrue(page, `document.querySelector(".composer").getAttribute("aria-busy") === "false"`, 120_000);
      const m1 = await metrics(cdp);
      sends.push({ olderPages: older, run, rows, echoMs: round(shownAt - t0), turnMs: round(doneAt - t0), ...delta(m0, m1), main: await mainThread(page, t0, doneAt), server: serverRequests(wall, Date.now()) });
      await context.close();
      await delay(1500);
    }
    results.send = sends;
    write();
    log("send", JSON.stringify(sends).slice(0, 400));
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await stopServer();
  write();
}
