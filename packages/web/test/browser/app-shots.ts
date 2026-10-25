/** Screenshots of the pages beside the chat against the scripted host
 * (mocked data, the built UI): a thread on the sheet while its agent works
 * (the thinking cube beside `working…`), a thread whose machine starts, the
 * thread list and the artifact list, at desktop and phone width, light and
 * dark, plus the cube at a few moments, into the directory given as the
 * first argument. Not a test; for review, as chat-sheet-shots.ts is. */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { ThreadSummary } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const out = process.argv[2] ?? "/tmp/app-shots";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844, touch: true },
];
const pause = (page: Page, ms = 400) => page.waitForTimeout(ms);
const thread: ThreadSummary = { ...threads[0]!, id: "t1", title: "composer room: measure the mobile composer and propose more space" };

for (const dark of [false, true]) for (const size of sizes) {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "working", run: "r", error: null }, events: chatEvents().slice(5, 16) };
  host.overview = overview();
  host.thread = thread;
  host.threads = threads.slice(1);
  host.artifacts = artifacts;
  host.bodies = bodies;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch, deviceScaleFactor: 2, colorScheme: dark ? "dark" : "light" });
  const page = await context.newPage();
  const tag = `${size.name}${dark ? "-dark" : ""}`;
  await page.goto(`${host.url}/#/t/t1`);
  await page.locator(".working-line .thinking-cube").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await pause(page, 700);
  await page.screenshot({ path: path.join(out, `thread-${tag}.png`) });
  // the cube beside its words, three moments of a quarter turn
  for (const at of [0, 1, 2]) {
    await page.locator(".working-line").screenshot({ path: path.join(out, `cube-working-${tag}-${at}.png`) });
    await pause(page, 260);
  }
  if (size.touch) {
    await page.locator(".mobile-thread-switch").tap();
    await pause(page);
    await page.screenshot({ path: path.join(out, `thread-drawer-${tag}.png`) });
  }
  host.thread = { ...thread, state: "starting" };
  host.transcript = { ...host.transcript, status: { state: "idle", run: null, error: null }, events: [] };
  await page.goto(`${host.url}/#/threads`);
  await page.locator("main h1").waitFor();
  await pause(page);
  await page.screenshot({ path: path.join(out, `threads-${tag}.png`) });
  await page.goto(`${host.url}/#/t/t1`);
  await page.locator(".conversation-empty .thinking-cube").waitFor();
  await pause(page, 900);
  await page.screenshot({ path: path.join(out, `thread-starting-${tag}.png`) });
  for (const at of [0, 1, 2]) {
    await page.locator(".conversation-empty").screenshot({ path: path.join(out, `cube-starting-${tag}-${at}.png`) });
    await pause(page, 500);
  }
  await page.goto(`${host.url}/#/artifacts`);
  await page.locator("main h1").waitFor();
  await pause(page);
  await page.screenshot({ path: path.join(out, `artifacts-${tag}.png`) });
  await context.close();
  await host.close();
}

await browser.close();
console.log(`screenshots in ${out}`);
