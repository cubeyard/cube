// node typing-profile.ts BASE OUT.cpuprofile PAGES : the chat, PAGES older pages read, then 40 keystrokes under the CPU profiler; top self times.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/agent/perfm/packages/web/package.json");
const { chromium } = require("playwright");
const [base, out, pages] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(`${base}/#/chat`);
await page.waitForSelector(".transcript-column [data-anchor]");
await page.waitForTimeout(1500);
for (let k = 0; k < Number(pages); k++) {
  const before = await page.locator(".transcript-column [data-anchor]").count();
  await page.locator(".transcript").evaluate((e: HTMLElement) => { e.scrollTop = 0; });
  await page.waitForFunction((n: number) => document.querySelectorAll(".transcript-column [data-anchor]").length > n || !document.querySelector(".transcript-earlier"), before, { timeout: 30000 }).catch(() => 0);
}
console.log("rows", await page.locator(".transcript-column [data-anchor]").count());
await page.locator(".composer textarea").focus();
await page.waitForTimeout(1000);
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp.send("Profiler.start");
const t = Date.now();
for (const ch of "how are the threads doing today, all good") { await page.keyboard.type(ch); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))); }
const { profile } = await cdp.send("Profiler.stop");
console.log("typing wall ms", Date.now() - t);
fs.writeFileSync(out, JSON.stringify(profile));
const self = new Map<string, number>();
const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
profile.samples.forEach((id: number, i: number) => { const n: any = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000); });
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(v.toFixed(1).padStart(8), k);
await browser.close();
