/** A thread OptChat names in its reply as `[name](#/t/<id>)` is a link in
 * the chat, against the scripted host with chat-sheet-data's log: a short
 * id and a whole one open that thread's page over the chat, by a press or
 * the keyboard; an archived thread, one cube does not have and a key that
 * is no id print their words; artifact and external links stay as they
 * were; a link in a message still streaming is a link already. Desktop and
 * phone, Chromium and WebKit where Playwright has it. Needs a built UI
 * (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, webkit, type Browser, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const ARCHIVED = "abcdef01-7777-4777-8777-777777777777";
const archived: ThreadSummary = { id: ARCHIVED, title: "old spike", state: "ready", error: null, createdAt: Date.now() - 900_000, archived: true, project: { id: "cube", name: "cube" } };
const short = (id: string) => id.slice(0, 8);
const mention: ThreadEvent = { type: "assistant-text", id: "9.0", reasoning: false, final: true,
  text: `[composer room](#/t/${short(ID.composer)}) is still working and [the flaky test](#/t/${ID.flaky}) is done. `
    + `[old spike](#/t/${short(ARCHIVED)}) is archived, [java trust](#/t/${short(ID.gone)}) is gone and [calm otter](#/t/calm-otter) is a name. `
    + `See [today's review](#/a/${ID.review}) and [#241](https://github.com/cubeyard/cube/pull/241).` };
const streaming: ThreadEvent = { type: "assistant-text", id: "live.1", reasoning: false, final: false, text: `Still writing about [the flaky test](#/t/${short(ID.flaky)}) and` };

const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
const errors: string[] = [];
const panel = (page: Page) => page.locator("dialog.page-panel");

try {
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    const host = await ScriptedHost.start();
    host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: [...chatEvents(), mention] };
    host.overview = overview();
    host.thread = threads[0]!;
    host.threads = [...threads.slice(1), archived];
    host.artifacts = artifacts;
    host.bodies = bodies;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${host.url}/#/chat`);
    const message = page.locator(".chat-sheet .conversation-message.assistant[data-anchor='9.0'] .message-copy");
    await message.locator("a", { hasText: "composer room" }).waitFor();

    const links = await message.locator("a").evaluateAll(anchors => anchors.map(a => ({ text: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target") })));
    assert.deepEqual(links, [
      { text: "composer room", href: `#/t/${ID.composer}`, target: null },
      { text: "the flaky test", href: `#/t/${ID.flaky}`, target: null },
      { text: "today's review", href: `#/a/${ID.review}`, target: null },
      { text: "#241", href: "https://github.com/cubeyard/cube/pull/241", target: "_blank" },
    ], `${size.name}: open threads link by their whole id, in place; the artifact and the pull request stay as they were`);
    assert.match(await message.innerText(), /old spike is archived, java trust is gone and calm otter is a name\./, `${size.name}: what names no open thread is its words`);

    // the keyboard opens the thread's page over the chat, and closing it comes back
    const composer = message.locator("a", { hasText: "composer room" });
    await composer.focus();
    await page.keyboard.press("Enter");
    await panel(page).locator(".thread-strip").waitFor();
    assert.equal(await page.evaluate(() => location.hash), `#/t/${ID.composer}`, `${size.name}: enter opens the thread`);
    assert.match(await panel(page).innerText(), /composer room: measure the mobile composer/, `${size.name}: that thread's page`);
    await page.goBack();
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), "#/chat", `${size.name}: back is the chat`);

    // a press (a tap on the phone) does the same
    if (size.touch) await composer.tap();
    else await composer.click();
    await panel(page).locator(".thread-strip").waitFor();
    assert.equal(await page.evaluate(() => location.hash), `#/t/${ID.composer}`, `${size.name}: a press opens the thread`);
    await page.goBack();
    await panel(page).waitFor({ state: "detached" });

    // a message still being written links as it grows
    host.set([...host.transcript.events, streaming], { state: "working" });
    const live = page.locator(".chat-sheet .conversation-message.assistant[data-anchor='live.1'] a", { hasText: "the flaky test" });
    await live.waitFor();
    assert.equal(await live.getAttribute("href"), `#/t/${ID.flaky}`, `${size.name}: a streaming message's thread link`);

    assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), true, `${size.name}: nothing scrolls sideways`);
    console.log(`ok: ${size.name}: thread links open the thread; the rest print their words`);
    await context.close();
    await host.close();
  }
  assert.deepEqual(errors, [], "no script errors");
  console.log("thread links browser: ok");
} finally {
  for (const [, browser] of engines) await browser.close();
}
process.exit(0);
