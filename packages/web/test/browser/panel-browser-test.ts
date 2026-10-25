/** The places over the chat, against the scripted host: the chat is home and
 * stays; threads, a thread, artifacts, projects and settings open in one
 * modal panel over it and close back to it with the chat as it was (its
 * draft, its scroll). The panel takes focus and gives it back; escape
 * closes it unless a field holds text; its close key and back close it; a
 * place opened from the chat's index closes the index; the chat's own keys
 * stay off while a place is open. Desktop (a sheet from the right, the chat
 * beside it) and phone (the whole screen). Needs a built UI (pnpm build)
 * and Playwright's Chromium. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { artifacts, bodies, chatEvents, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const host = await ScriptedHost.start();
host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
host.thread = { ...threads[0]!, id: "t1" };
host.chat = { ...host.transcript };
host.transcript = { ...host.transcript, events: chatEvents().slice(0, 4) };
host.threads = threads.slice(1);
host.artifacts = artifacts;
host.bodies = bodies;
host.overview = overview();
const browser = await chromium.launch();
const errors: string[] = [];
const panel = (page: Page) => page.locator("dialog.page-panel");
const chatDraft = (page: Page) => page.locator(".chat-sheet .composer textarea");
const inPanel = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("dialog.page-panel"));

try {
  for (const size of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${host.url}/#/chat`);
    await chatDraft(page).waitFor();
    await page.getByText("Here it is:").waitFor();
    await chatDraft(page).fill("a draft the chat keeps");
    const scroller = page.locator(".chat-sheet .transcript");
    await scroller.evaluate(element => { element.scrollTop = 120; });
    const scrolled = await scroller.evaluate(element => element.scrollTop);

    // a place opens over the chat: modal, named, focus inside, the chat inert and still there
    await page.evaluate(() => { location.hash = "#/threads"; });
    await panel(page).locator("main h1", { hasText: "threads" }).waitFor();
    assert.equal(await panel(page).evaluate(element => (element as HTMLDialogElement).open && element.matches(":modal")), true, `${size.name}: the panel is modal`);
    assert.equal(await panel(page).getAttribute("aria-label"), "threads");
    assert.ok(await inPanel(page), `${size.name}: focus is in the panel`);
    assert.equal(await page.locator(".chat-sheet").count(), 1, `${size.name}: the chat stays mounted`);
    const box = await panel(page).boundingBox();
    if (size.touch) assert.ok(box!.x <= 0 && box!.width >= size.width - 1, `${size.name}: the whole screen: ${JSON.stringify(box)}`);
    else assert.ok(box!.x > 100 && Math.round(box!.x + box!.width) === size.width, `${size.name}: a sheet from the right, the chat beside it: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), true, `${size.name}: nothing scrolls sideways`);

    // the chat's keys are off while a place is open: `/` opens no index under the panel
    await page.locator("body").press("/");
    assert.equal(await page.locator(".chat-index[open]").count(), 0, `${size.name}: no index under the panel`);

    // escape closes it, and the chat is as it was
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), "#/chat");
    assert.equal(await chatDraft(page).inputValue(), "a draft the chat keeps", `${size.name}: the draft is kept`);
    assert.equal(await scroller.evaluate(element => element.scrollTop), scrolled, `${size.name}: the scroll is kept`);

    // a thread from the index: the index goes, the thread opens; escape in its composer with text keeps the panel
    await page.locator(".sheet-bar .name-key").click();
    await page.locator(".chat-index[open] .index-row").first().waitFor();
    await page.evaluate(() => { location.hash = "#/t/t1"; });
    await panel(page).locator(".thread-strip").waitFor();
    assert.equal(await page.locator(".chat-index[open]").count(), 0, `${size.name}: the index closed as the place opened`);
    const threadDraft = panel(page).locator(".composer textarea");
    await threadDraft.waitFor();
    await threadDraft.fill("a thread draft");
    await threadDraft.press("Escape");
    assert.equal(await panel(page).count(), 1, `${size.name}: escape in a field with text never closes the panel`);
    assert.equal(await threadDraft.inputValue(), "a thread draft");

    // the close key closes it; back opens the place again, forward leaves it
    const close = panel(page).locator(".panel-close").first();
    await (size.touch ? close.tap() : close.click());
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), "#/chat");
    await page.goBack();
    await panel(page).locator(".thread-strip").waitFor();
    await page.goForward();
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await chatDraft(page).inputValue(), "a draft the chat keeps", `${size.name}: the draft outlives every visit`);

    // a deep link opens the place over the chat at once
    await page.goto(`${host.url}/#/artifacts`);
    await panel(page).locator("main h1", { hasText: "artifacts" }).waitFor();
    await chatDraft(page).waitFor({ state: "attached" });
    console.log(`ok: ${size.name}: places open over the chat and close back to it as it was`);
    await context.close();
  }
  assert.deepEqual(errors, [], "no script errors");
  console.log("panel browser: ok");
} finally {
  await browser.close();
  await host.close();
}
process.exit(0);
