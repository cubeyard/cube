import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import type { ThreadEvent, ThreadTranscript } from "../../src/lib/types.ts";
import { threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
const done: ThreadTranscript["status"] = { state: "completed", run: "r0", error: null };
const LOADS_MS = 8000;

const browser = await chromium.launch();
const engines: Browser[] = [browser];
if (fs.existsSync(webkit.executablePath())) engines.push(await webkit.launch());
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
let failed = false;

/** A browser profile whose windows can say they are hidden (a background
 * tab), as headless Chromium shows every page. */
async function profile(engine: Browser): Promise<BrowserContext> {
  const context = await engine.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const state = window as unknown as { cubeHidden?: boolean };
    Object.defineProperty(document, "hidden", { get: () => !!state.cubeHidden });
    Object.defineProperty(document, "visibilityState", { get: () => state.cubeHidden ? "hidden" : "visible" });
  });
  return context;
}
const setHidden = (page: Page, hidden: boolean) => page.evaluate(value => {
  (window as unknown as { cubeHidden?: boolean }).cubeHidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}, hidden);

async function scenario(name: string, run: (host: ScriptedHost, context: BrowserContext) => Promise<void>, engine = browser): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: done, events: [user("1.0", "thread question"), agent("2.0.0", "the thread's answer")] };
  host.chat = { ...host.transcript, events: [user("1.0", "chat question"), agent("2.0.0", "the chat's answer")] };
  host.thread = { ...threads[0]!, id: "t1" };
  const context = await profile(engine);
  const errors: string[] = [];
  context.on("page", page => page.on("pageerror", error => errors.push(String(error))));
  try {
    await run(host, context);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${name} (${engine.browserType().name()})`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name} (${engine.browserType().name()})\n`, error);
  } finally {
    await context.close();
    await host.close();
  }
}

async function open(context: BrowserContext, host: ScriptedHost, route: string, shows: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${host.url}/${route}`, { timeout: LOADS_MS });
  await page.getByText(shows).first().waitFor({ timeout: LOADS_MS });
  return page;
}

await scenario("three thread windows, then the chat in a fourth", async (host, context) => {
  for (let i = 0; i < 3; i++) await open(context, host, "#/t/t1", "the thread's answer");
  await open(context, host, "#/chat", "the chat's answer");
});

await scenario("six windows in the background, then a seventh", async (host, context) => {
  const windows: Page[] = [];
  for (let i = 0; i < 6; i++) {
    const page = await open(context, host, "#/chat", "the chat's answer");
    await setHidden(page, true);
    windows.push(page);
  }
  await open(context, host, "#/chat", "the chat's answer");
  host.chat = { ...host.chat!, events: [...host.chat!.events, user("3.0", "asked while hidden"), agent("4.0.0", "answered while hidden")] };
  await setHidden(windows[0]!, false);
  await windows[0]!.getByText("answered while hidden").waitFor({ timeout: LOADS_MS });
});

await scenario("the chat under a thread reads what it missed when the thread closes", async (host, context) => {
  const page = await open(context, host, "#/chat", "the chat's answer");
  await page.goto(`${host.url}/#/t/t1`);
  await page.locator(".page-panel").getByText("the thread's answer").waitFor({ timeout: LOADS_MS });
  host.chat = { ...host.chat!, events: [...host.chat!.events, user("3.0", "a report came"), agent("4.0.0", "while the thread was open")] };
  await page.goto(`${host.url}/#/chat`);
  await page.getByText("while the thread was open").waitFor({ timeout: LOADS_MS });
  assert.equal(await page.locator(".composer textarea").count() > 0, true, "the chat's composer is there");
});

for (const engine of engines) {
  await scenario("a thread opened and closed eight times gives back its connections", async (host, context) => {
    const page = await open(context, host, "#/chat", "the chat's answer");
    for (let i = 0; i < 8; i++) {
      await page.goto(`${host.url}/#/t/t1`);
      await page.locator(".page-panel").getByText("the thread's answer").waitFor({ timeout: LOADS_MS });
      await page.goto(`${host.url}/#/chat`);
      await page.locator(".page-panel").waitFor({ state: "detached", timeout: LOADS_MS });
    }
    await open(context, host, "#/t/t1", "the thread's answer");
    for (let at = Date.now(); host.streaming > 1 && Date.now() - at < LOADS_MS;) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(host.streaming, 1, "one thread stream open, the second window's: the first window's eight ended");
  }, engine);
}

for (const engine of engines) await engine.close();
if (failed) process.exit(1);
console.log("windows browser: ok");
process.exit(0);
