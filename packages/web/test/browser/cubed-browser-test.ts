/** The chat in a real browser against the real cubed and OptChat, with a
 * controlled model (streamed text, a tool call, a provider failure): sends,
 * streaming, tool rounds, errors and a reload keep the send invariants.
 * Pi's render is slowed as a long chat's is, which showed every send as
 * gone and back before OptChat held its shown messages. Needs a built UI
 * (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";
import { assertSend, monitor } from "./monitor.ts";

// A long chat: every frame of Pi's transcript comes this much later.
const host = await startChatHost({ renderMs: 80 });
const url = host.url;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on("pageerror", error => errors.push(String(error)));
const watch = await monitor(page);
await page.goto(`${url}/#/chat`);
const composer = page.locator(".composer textarea");
await composer.waitFor();
await page.locator(".conversation-empty", { hasText: "one chat, every thread" }).waitFor();

async function send(page: Page, text: string): Promise<void> {
  await composer.fill(text);
  await watch.mark(text);
  await composer.press("Enter");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: text }).waitFor();
  await page.locator(".composer[aria-busy=false]").waitFor({ timeout: 20_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  await send(page, "hello there");
  let record = await watch.since("hello there");
  assertSend(record, "hello there");
  assert.ok(record.some(seen => seen.working), "the run showed as working");
  assert.ok(record.filter(seen => seen.agent.some(text => text.startsWith("hello, this reply"))).length > 1, "the reply streamed over several frames");

  await send(page, "please use the date tool");
  record = await watch.since("please use the date tool");
  assertSend(record, "please use the date tool");
  assert.ok(record.at(-1)!.agent.some(text => text.includes("date")), "the tool call shows");
  assert.ok(record.at(-1)!.agent.some(text => text.startsWith("the date tool answered")), "the answer after the tool");

  await send(page, "please fail now");
  record = await watch.since("please fail now");
  assertSend(record, "please fail now");
  assert.match(record.at(-1)!.error ?? "", /refused/, `the failure shows: ${JSON.stringify(record.slice(-4))}`);

  await send(page, "and once more");
  record = await watch.since("and once more");
  assertSend(record, "and once more");
  assert.equal(record.at(-1)!.error, null, "a new run clears the failure");

  await page.reload();
  await page.locator(".conversation-message.user", { hasText: "and once more" }).waitFor();
  await page.locator(".composer[aria-busy=false]").waitFor();
  assert.deepEqual(await page.locator(".conversation-message.user .message-copy").allTextContents(),
    ["hello there", "please use the date tool", "please fail now", "and once more"], "a reload reads the same messages, once each");
  assert.deepEqual(errors, [], "no script errors");
  console.log("cubed browser: ok");
} finally {
  await browser.close();
  await host.close();
}
process.exit(0);
