/** The places over the chat, against the scripted host: the chat is home and
 * stays; threads, a thread, artifacts, projects and settings open in one
 * modal panel over it and close back to it with the chat as it was (its
 * draft, its scroll). The panel takes focus and gives it back; escape
 * closes it unless a field holds text; its close key and back close it; a
 * place opened from the chat's index closes the index; the chat's own keys
 * stay off while a place is open. Desktop (a sheet from the right, the chat
 * beside it) and phone (the whole screen). An unsent thread draft
 * survives every way the panel closes and is there when the thread opens
 * again; a sent one is not. Needs a built UI (pnpm build)
 * and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { artifacts, bodies, chatEvents, overview, threads } from "./chat-sheet-data.ts";
import { gate, ScriptedHost, type Prompt } from "./scripted-host.ts";

const host = await ScriptedHost.start();
host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
host.thread = { ...threads[0]!, id: "t1" };
host.chat = { ...host.transcript };
host.transcript = { ...host.transcript, events: chatEvents().slice(0, 4) };
host.threads = threads.slice(1);
host.artifacts = artifacts;
host.bodies = bodies;
host.overview = overview();
const errors: string[] = [];
const panel = (page: Page) => page.locator("dialog.page-panel");
const chatDraft = (page: Page) => page.locator(".chat-sheet .composer textarea");
const until = async (check: () => boolean, what: string) => {
  for (const deadline = Date.now() + 10_000; !check(); await new Promise(resolve => setTimeout(resolve, 50))) assert.ok(Date.now() < deadline, `waiting for ${what}`);
};
/** Lets a held send end and waits until the page has its answer, not a guessed time. */
async function settle(page: Page, held: { open: () => void }): Promise<void> {
  const answered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/prompt"));
  held.open();
  await answered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const ACTIVE_NOTE = "dialog.page-panel .conversation-error";
const inPanel = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("dialog.page-panel"));
/** What has focus, in words: its text and whether it is the element marked `data-opener`. */
const focused = (page: Page) => page.evaluate(() => ({ opener: document.activeElement?.hasAttribute("data-opener") ?? false, what: `${document.activeElement?.tagName} ${document.activeElement?.textContent?.trim().slice(0, 30)}` }));
/** Opens a place from a link in the chat by the keyboard, as a reader does, and marks the link. */
async function openFrom(page: Page, link: ReturnType<Page["locator"]>): Promise<void> {
  await link.evaluate(element => element.setAttribute("data-opener", ""));
  await link.focus();
  await page.keyboard.press("Enter");
  await panel(page).locator("main h1, .thread-strip").first().waitFor();
}
// WebKit (Safari's engine) too, where Playwright has it.
const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: pnpm --filter @cube/web exec playwright install webkit)");

try {
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    // WebKit on Linux has no mobile emulation; it still has touch.
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
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

    // focus goes back to the link that opened the place: after escape, and after the close key
    const link = page.locator(".chat-sheet .markdown a", { hasText: "composer room: more space on the phone" });
    for (const how of ["escape", "close key"] as const) {
      await openFrom(page, link);
      if (how === "escape") await page.keyboard.press("Escape");
      else await panel(page).locator(".panel-close").first().click();
      await panel(page).waitFor({ state: "detached" });
      await page.waitForTimeout(350);
      const now = await focused(page);
      assert.ok(now.opener, `${size.name}: after the ${how}, focus is back on the link that opened the place, not ${now.what}`);
    }

    if (!size.touch) {
      // a selection dragged out of the panel onto the chat beside it keeps the panel open
      await openFrom(page, link);
      const text = panel(page).locator(".artifact-body p").first();
      await text.waitFor();
      const from = (await text.boundingBox())!;
      await page.mouse.move(from.x + 10, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(40, from.y + from.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      assert.equal(await panel(page).count(), 1, `${size.name}: a selection dragged onto the backdrop does not close the panel`);
      assert.ok((await page.evaluate(() => String(getSelection()))).length > 0, `${size.name}: the selection is kept`);
      // a press that begins and ends on the backdrop still closes it, focus back on the link
      await page.mouse.click(40, 400);
      await panel(page).waitFor({ state: "detached" });
      await page.waitForTimeout(350);
      assert.ok((await focused(page)).opener, `${size.name}: after a press on the backdrop, focus is back on the link`);
    }

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

    // an unsent thread draft outlives every way the panel closes, and comes back when the thread opens again
    const paths: Array<[string, () => Promise<void>]> = [
      ["the close key", async () => { const key = panel(page).locator(".strip-close"); await (size.touch ? key.tap() : key.click()); }],
      ["escape from outside the field", async () => { await panel(page).locator(".strip-title, .mobile-thread-switch").first().evaluate(element => (element as HTMLElement).blur()); await page.locator("dialog.page-panel").focus(); await page.keyboard.press("Escape"); }],
      ["back", async () => { await page.goBack(); }],
      ...size.touch ? [] : [["a press on the backdrop", async () => { await page.mouse.click(40, 400); }] as [string, () => Promise<void>]],
    ];
    for (const [index, [how, leave]] of paths.entries()) {
      const words = `draft ${index}: kept when the panel closes by ${how}\nsecond line`;
      await page.evaluate(() => { location.hash = "#/t/t1"; });
      const field = panel(page).locator(".composer textarea");
      await field.waitFor();
      await field.fill(words);
      await leave();
      await panel(page).waitFor({ state: "detached" });
      await page.evaluate(() => { location.hash = "#/t/t1"; });
      await panel(page).locator(".composer textarea").waitFor();
      assert.equal(await panel(page).locator(".composer textarea").inputValue(), words, `${size.name}: the draft comes back after closing by ${how}`);
      assert.ok(await panel(page).locator(".composer textarea").evaluate(element => element.scrollHeight <= element.clientHeight + 2), `${size.name}: the field holds the kept draft without a scrollbar`);
      await page.evaluate(() => { location.hash = "#/chat"; });
      await panel(page).waitFor({ state: "detached" });
    }
    // a sent draft is gone: the next visit starts empty
    await page.evaluate(() => { location.hash = "#/t/t1"; });
    const field = panel(page).locator(".composer textarea");
    await field.waitFor();
    await field.fill(`sent from ${size.name}`);
    await field.press("Enter");
    await until(() => host.prompts.some(prompt => prompt.text === `sent from ${size.name}`), "the message was sent");
    assert.equal(await field.inputValue(), "");
    await page.evaluate(() => { location.hash = "#/chat"; });
    await panel(page).waitFor({ state: "detached" });
    await page.evaluate(() => { location.hash = "#/t/t1"; });
    await panel(page).locator(".composer textarea").waitFor();
    assert.equal(await panel(page).locator(".composer textarea").inputValue(), "", `${size.name}: a sent message does not come back as a draft`);
    await page.evaluate(() => { location.hash = "#/chat"; });
    await panel(page).waitFor({ state: "detached" });
    assert.equal(await chatDraft(page).inputValue(), "a draft the chat keeps", `${size.name}: the chat's own draft is untouched`);

    // A send that fails after the panel closed. Each send is held until the
    // test lets it fail; `tries` records every request the host saw.
    const tries: Prompt[] = [];
    const failLater = () => { const held = gate(); host.onPrompt = async prompt => { tries.push(prompt); await held.promise; throw new Error("the host refused it"); }; return held; };
    const openThread = async () => { await page.evaluate(() => { location.hash = "#/t/t1"; }); await panel(page).locator(".composer textarea").waitFor(); return panel(page).locator(".composer textarea"); };
    const toChat = async () => { await page.evaluate(() => { location.hash = "#/chat"; }); await panel(page).waitFor({ state: "detached" }); };
    const note = () => panel(page).locator(".conversation-error");

    // 1 · it fails while the thread is closed: the words and a note wait for the next visit
    let held = failLater();
    let late = await openThread();
    await late.fill(`late A ${size.name}`);
    await late.press("Enter");
    await until(() => tries.length === 1, "the send reached the host");
    await toChat();
    await settle(page, held);
    late = await openThread();
    assert.equal(await late.inputValue(), `late A ${size.name}`, `${size.name}: a send that failed after the panel closed comes back on the next visit`);
    assert.match(await note().textContent() ?? "", /^not sent: .*back in the field/, `${size.name}: and says it was not sent`);
    // its retry is the same request: one id, so it cannot post twice
    host.onPrompt = prompt => { tries.push(prompt); };
    await late.press("Enter");
    await until(() => tries.length === 2, "the retry reached the host");
    assert.equal(tries[1]!.requestId, tries[0]!.requestId, `${size.name}: the retry of the recovered words keeps the first request's id`);
    await page.waitForTimeout(200);
    assert.equal(await note().count(), 0, `${size.name}: a sent retry clears the note`);
    await toChat();

    // 2 · it fails while the thread is open again with newer typing: the words come back before it, nothing is overwritten
    held = failLater();
    late = await openThread();
    await late.fill(`late B ${size.name}`);
    await late.press("Enter");
    await until(() => tries.length === 3, "the send reached the host");
    await toChat();
    late = await openThread();
    assert.equal(await late.inputValue(), "", `${size.name}: the send is still on its way`);
    await late.fill("newer typing");
    held.open();
    await page.locator(ACTIVE_NOTE).waitFor();
    assert.equal(await late.inputValue(), `late B ${size.name}\nnewer typing`, `${size.name}: a late failure lands in the open view before what was typed since`);
    assert.match(await note().textContent() ?? "", /^not sent: /, `${size.name}: with its note`);
    await late.press("End");
    await late.type(" and more");
    await toChat();
    late = await openThread();
    assert.equal(await late.inputValue(), `late B ${size.name}\nnewer typing and more`, `${size.name}: typing after the recovery is kept, nothing overwrote it`);
    assert.match(await note().textContent() ?? "", /^not sent: /, `${size.name}: the note stays until a send goes through`);
    // a field emptied by hand drops the note
    await late.fill("");
    await toChat();
    late = await openThread();
    assert.equal(await note().count(), 0, `${size.name}: an emptied field drops the note`);
    await toChat();

    // 3 · it succeeds while the thread is open again: the same words sent once more are a second message, with their own id
    const succeedLater = () => { const held = gate(); host.onPrompt = async prompt => { tries.push(prompt); await held.promise; }; return held; };
    held = succeedLater();
    late = await openThread();
    await late.fill("continue");
    await late.press("Enter");
    await until(() => tries.length === 4, "the send reached the host");
    await toChat();
    late = await openThread();
    await settle(page, held);
    host.onPrompt = prompt => { tries.push(prompt); };
    await late.fill("continue");
    await late.press("Enter");
    await until(() => tries.length === 5, "the repeat reached the host");
    assert.notEqual(tries[4]!.requestId, tries[3]!.requestId, `${size.name}: a repeat after the first went through is a new request, not a replay`);
    await toChat();

    // 4 · a kept failure retried in a view that closes before the retry goes through: the next view's repeat is a new request
    held = failLater();
    late = await openThread();
    await late.fill("retry me");
    await late.press("Enter");
    await until(() => tries.length === 6, "the send reached the host");
    await toChat();
    await settle(page, held);
    held = succeedLater();
    late = await openThread();
    assert.equal(await late.inputValue(), "retry me");
    await late.press("Enter");
    await until(() => tries.length === 7, "the retry reached the host");
    assert.equal(tries[6]!.requestId, tries[5]!.requestId, `${size.name}: the retry keeps the failed request's id`);
    await toChat();
    late = await openThread();
    await settle(page, held);
    host.onPrompt = prompt => { tries.push(prompt); };
    await late.fill("retry me");
    await late.press("Enter");
    await until(() => tries.length === 8, "the repeat reached the host");
    assert.notEqual(tries[7]!.requestId, tries[5]!.requestId, `${size.name}: once the retry went through, the same words again are a new request`);
    await toChat();

    // 5 · a failure, then other words sent instead: the failed words sent later are a new request
    host.onPrompt = prompt => { tries.push(prompt); throw new Error("the host refused it"); };
    late = await openThread();
    await late.fill("alpha");
    await late.press("Enter");
    await until(() => tries.length === 9, "the send reached the host");
    await note().waitFor();
    host.onPrompt = prompt => { tries.push(prompt); };
    await late.fill("beta");
    await late.press("Enter");
    await until(() => tries.length === 10, "the other words reached the host");
    await toChat();
    late = await openThread();
    await late.fill("alpha");
    await late.press("Enter");
    await until(() => tries.length === 11, "the failed words sent again reached the host");
    assert.notEqual(tries[10]!.requestId, tries[8]!.requestId, `${size.name}: after other words were sent, the failed words again are a new request`);
    await toChat();
    host.onPrompt = () => {};

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
  for (const [, browser] of engines) await browser.close();
  await host.close();
}
process.exit(0);
