/** A thread's composer while the thread list says its machine starts,
 * against a scripted host (the data is mocked; the UI is the built one).
 * The list is polled every 3 s, so it can still say "starting" after the
 * host says ready and the first reply shows: Enter then sends the message,
 * once, without waiting for the next poll. While the host still says
 * "starting", Enter sends nothing and the words stay in the field.
 * Desktop, Chromium. Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary } from "../../src/lib/types.ts";
import { ScriptedHost } from "./scripted-host.ts";

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
const starting: ThreadSummary = { id: "t1", title: "a new thread", state: "starting", error: null, createdAt: Date.now(), archived: false, project: { id: "cube", name: "cube" } };

const browser = await chromium.launch();
let failed = false;

async function scenario(name: string, run: (page: Page, host: ScriptedHost) => Promise<void>): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "completed", run: "cube:initial", error: null }, events: [user("1.0", "hello"), agent("1.1", "ok: hello")] };
  host.thread = starting;
  host.chat = { ...host.transcript, events: [] };
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${host.url}/#/t/t1`);
    await page.locator(".page-panel .conversation-message.assistant", { hasText: "ok: hello" }).waitFor();
    await run(page, host);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name}\n`, error);
  } finally {
    await page.close();
    await host.close();
  }
}

/** Resolves just after the page's next poll of the thread list: the one after it is 3 s away. */
async function afterPoll(host: ScriptedHost): Promise<void> {
  const polls = () => host.requests.filter(request => request === "GET /api/threads").length;
  const seen = polls();
  for (const deadline = Date.now() + 5000; polls() === seen; await delay(20)) assert.ok(Date.now() < deadline, "the thread list is polled");
}

const composer = (page: Page) => page.locator(".page-panel .composer textarea");

await scenario("a list still saying starting after the host is ready: Enter sends, once", async (page, host) => {
  await composer(page).click();
  await composer(page).pressSequentially("next message");
  await afterPoll(host);
  host.thread = { ...starting, state: "ready" };
  const pressed = Date.now();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  for (const deadline = Date.now() + 1500; !host.prompts.length; await delay(20)) {
    assert.ok(Date.now() < deadline, `Enter sent nothing within 1.5 s; the list was read ${host.requests.filter(request => request === "GET /api/threads").length} times`);
  }
  assert.ok(Date.now() - pressed < 2500, "sent before the next poll");
  await delay(500);
  assert.deepEqual(host.prompts.map(prompt => prompt.text), ["next message"], "sent once");
  assert.equal(await composer(page).inputValue(), "", "the words left the field");
});

await scenario("a thread the host still starts: Enter sends nothing and keeps the words", async (page, host) => {
  await composer(page).click();
  await composer(page).pressSequentially("too early");
  await afterPoll(host);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  await delay(1000);
  assert.equal(host.prompts.length, 0, "nothing sent while the machine starts");
  assert.equal(await composer(page).inputValue(), "too early", "the words stay in the field");
  assert.ok(await page.locator(".page-panel .composer .send-key").isDisabled(), "the send key is held");
  host.thread = { ...starting, state: "ready" };
  await page.locator(".page-panel .composer .send-key:enabled").waitFor({ timeout: 5000 });
  await page.keyboard.press("Enter");
  for (const deadline = Date.now() + 1500; !host.prompts.length; await delay(20)) assert.ok(Date.now() < deadline, "sent once ready");
  assert.deepEqual(host.prompts.map(prompt => prompt.text), ["too early"]);
});

await browser.close();
if (failed) process.exit(1);
