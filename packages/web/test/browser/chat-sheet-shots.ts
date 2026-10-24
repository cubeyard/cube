/** Screenshots of the chat with chat-sheet-data's log against the scripted
 * host (mocked data, the built UI): desktop, laptop, intermediate and phone,
 * light and dark, at the top and the end, with a note and the index open,
 * into the directory given as the first argument. Not a test; for review.
 * Runs against any build: what a build does not have is skipped. */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { artifacts, bodies, chatEvents, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const out = process.argv[2] ?? "/tmp/chat-shots";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "intermediate", width: 1024, height: 768 },
  { name: "phone", width: 390, height: 844, touch: true },
];
const pause = (page: Page, ms = 400) => page.waitForTimeout(ms);
for (const dark of [false, true]) for (const size of sizes) {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
  host.overview = overview();
  host.threads = threads;
  host.artifacts = artifacts;
  host.bodies = bodies;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch, deviceScaleFactor: size.touch ? 2 : 1, colorScheme: dark ? "dark" : "light" });
  const page = await context.newPage();
  await page.goto(`${host.url}/#/chat`);
  await page.locator(".composer textarea").waitFor();
  await page.getByText("Here it is:").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await pause(page, 600);
  const tag = `${size.name}${dark ? "-dark" : ""}`;
  await page.screenshot({ path: path.join(out, `chat-end-${tag}.png`) });
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await pause(page);
  await page.screenshot({ path: path.join(out, `chat-top-${tag}.png`) });
  const note = page.locator(".note-head", { hasText: "composer room: measure" });
  if (await note.count()) {
    await note.first().click();
    await pause(page);
    await page.screenshot({ path: path.join(out, `chat-note-${tag}.png`) });
    await note.first().click();
  }
  if (await page.locator(".sheet-bar .name-key").count()) {
    if (size.touch) await page.locator(".sheet-bar .name-key").tap(); else await page.locator(".sheet-bar .name-key").click();
    await pause(page);
    await page.screenshot({ path: path.join(out, `chat-index-${tag}.png`) });
  }
  await context.close();
  await host.close();
}
await browser.close();
console.log(`screenshots in ${out}`);
