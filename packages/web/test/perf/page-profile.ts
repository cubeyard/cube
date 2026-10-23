/** A CPU profile of the chat page in Google Chrome while it reads older
 * pages and while a sent message's reply streams, against a running
 * serve.ts (an unminified build, PERF_WEB=<dir of `vite build --minify
 * false`>, gives readable names). Writes .cpuprofile files (DevTools
 * Performance panel, or packages/server/test/perf/profile-summary.ts) and
 * prints the top functions by self time.
 *
 *   node packages/web/test/perf/page-profile.ts --base http://127.0.0.1:7799 --out DIR [--warm 15] [--pages 3] [--send]
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright";

const { values: args } = parseArgs({ options: { base: { type: "string" }, out: { type: "string" }, warm: { type: "string", default: "15" }, pages: { type: "string", default: "3" },
  send: { type: "boolean", default: false }, chrome: { type: "string", default: "/usr/bin/google-chrome" } } });
if (!args.base || !args.out) { console.error("usage: page-profile.ts --base URL --out DIR"); process.exit(2); }
fs.mkdirSync(args.out, { recursive: true });
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
function summary(profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] }, top = 25): string[] {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, index) => {
    const node = byId.get(id)!;
    const key = `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").pop()}:${node.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0));
  });
  return [...self].filter(([key]) => !key.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, micros]) => `${(micros / 1000).toFixed(1).padStart(8)} ms  ${key}`);
}
async function profiled(cdp: CDPSession, name: string, run: () => Promise<void>): Promise<void> {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await run();
  const { profile } = await cdp.send("Profiler.stop");
  fs.writeFileSync(path.join(args.out!, `${name}.cpuprofile`), JSON.stringify(profile));
  console.log(`\n${name}:\n${summary(profile as never).join("\n")}`);
}
const rows = (page: Page) => page.locator(".transcript-column [data-anchor]").count();
async function older(page: Page): Promise<void> {
  const before = await rows(page);
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(count => document.querySelectorAll(".transcript-column [data-anchor]").length > count || !document.querySelector(".transcript-earlier"), before, { timeout: 30_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const browser = await chromium.launch({ executablePath: args.chrome });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(`${args.base}/#/chat`);
await page.locator(".transcript-column [data-anchor]").first().waitFor();
for (let k = 0; k < Number(args.warm); k++) await older(page);
console.log(`rows before: ${await rows(page)}`);
await profiled(cdp, "older-pages", async () => { for (let k = 0; k < Number(args.pages); k++) await older(page); });
console.log(`rows after: ${await rows(page)}`);
if (args.send) {
  await page.locator(".composer textarea").fill("profile send: how are the threads doing");
  await profiled(cdp, "send-stream", async () => {
    await page.locator(".composer textarea").press("Enter");
    await page.waitForFunction(() => document.querySelector(".composer")?.getAttribute("aria-busy") === "true", undefined, { timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector(".composer")?.getAttribute("aria-busy") === "false", undefined, { timeout: 120_000 });
  });
}
await browser.close();
