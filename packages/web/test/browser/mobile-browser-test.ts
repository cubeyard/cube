/** The chat and a thread on a phone, in a real browser against a scripted
 * host: the chat is one quiet row over the conversation with its index a
 * key away; elsewhere the destinations fold behind a menu key, a thread's
 * strip into one row with a details key, and while the keyboard is up the chrome steps aside
 * so the conversation keeps the screen — both the way Android resizes the
 * page (the viewport shrinks) and the way iOS Safari does (only the visual
 * viewport shrinks; stood in for here, as no desktop engine has an on-screen
 * keyboard). Turning the phone, long content, an attached image and the
 * fingertip's hit area of every small key are checked; the desktop keeps
 * its rows. Runs in Chromium, and in WebKit too when Playwright has it.
 * Screenshots go to CUBE_SCREENSHOTS when it is set. Needs a built UI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary } from "../../src/lib/types.ts";
import { ACTIVE } from "./monitor.ts";
import { ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
const LONG_WORD = "gateway-".repeat(40);
const events: ThreadEvent[] = [];
for (let i = 0; i < 12; i++) {
  events.push(user(`${i}.0`, `question ${i}: why does egress stall behind the gateway?`));
  events.push(agent(`${i}.1.0`, `answer ${i}: the gateway queues frames while the TLS handshake waits on the upstream. `.repeat(3)));
}
events.push(agent("99.0.0", `a path with no break: ${LONG_WORD}`));
const thread: ThreadSummary = {
  id: "t1", title: "make the mobile composer roomy enough to read a long conversation while typing", state: "ready", error: null,
  createdAt: Date.now(), archived: false, project: { id: "p1", name: "cube" },
  workspaceBase: { remote: "https://github.com/cubeyard/cube", ref: "refs/heads/main", oid: "ab3b52c6ab3b52c6" },
};
/** A 1x1 png. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Runs before the app: a visual viewport the test sizes, as iOS Safari's
 * keyboard does, while the layout viewport stays whole. */
function fakeVisualViewport(): void {
  // Read live: the page's own size settles after this runs.
  let keyboardHeight: number | null = null;
  let scale = 1;
  const target = Object.defineProperties(new EventTarget(), {
    width: { get: () => innerWidth / scale },
    height: { get: () => (keyboardHeight ?? innerHeight) / scale },
    scale: { get: () => scale }, offsetTop: { value: 0 }, offsetLeft: { value: 0 },
    set: { value: (height: number | null) => { keyboardHeight = height; target.dispatchEvent(new Event("resize")); } },
    zoom: { value: (to: number) => { scale = to; target.dispatchEvent(new Event("resize")); } },
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => target });
}

type Box = { top: number; bottom: number; left: number; right: number; height: number; width: number };
/** A selector within the place the reader is in (the panel over the chat, else the chat); the app itself as it is. */
const inView = (selector: string) => /^(#app|:root|html|body)\b/.test(selector) ? selector : `${ACTIVE} ${selector}`;
const box = (page: Page, selector: string): Promise<Box> => page.locator(inView(selector)).first().evaluate(element => {
  const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
  return { top, bottom, left, right, height, width };
});
const visible = (page: Page, selector: string) => page.locator(inView(selector)).first().isVisible();
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const keyboard = (page: Page) => page.evaluate(() => document.documentElement.dataset.keyboard ?? null);
/** With `room`, only what is above a keyboard that only the visual viewport knows of. */
const shoot = async (page: Page, engine: string, name: string, room?: number) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${engine}-${name}.png`), ...(room ? { clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: room } } : {}) });
};

/** A fingertip lands anywhere within 2.75rem (44px) centred on the key. */
async function assertHitArea(page: Page, selector: string): Promise<void> {
  const misses = await page.locator(inView(selector)).first().evaluate(element => {
    const { left, top, width, height } = element.getBoundingClientRect();
    const [x, y] = [left + width / 2, top + height / 2];
    const out: string[] = [];
    for (const [dx, dy] of [[-21, 0], [21, 0], [0, -21], [0, 21], [-20, -20], [20, 20]]) {
      const hit = document.elementFromPoint(x + dx!, y + dy!);
      if (!hit || !(hit === element || element.contains(hit))) out.push(`${dx},${dy} → ${hit?.className || hit?.tagName}`);
    }
    return out;
  });
  assert.deepEqual(misses, [], `${selector} keeps a 44px hit area`);
}
async function assertNoSideways(page: Page): Promise<void> {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(scroll <= width, `nothing pushes the page sideways: ${scroll} > ${width}`);
}
/** Waits until the transcript's view is at its end: a following view is
 * pinned again by a ResizeObserver, a frame or so after its box changes. */
const atEnd = (page: Page, what: string) => page.waitForFunction(() => {
  const el = document.querySelector(".transcript")!;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
}, undefined, { timeout: 5000 }).catch(() => assert.fail(what));

let failed = false;
async function scenario(browser: Browser, engine: string, name: string, size: { width: number; height: number; touch?: boolean; ios?: boolean }, route: string,
  run: (page: Page, host: ScriptedHost) => Promise<void>, threadState: ThreadSummary["state"] = thread.state): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { agent: "pi", owner: null, status: { state: "completed", run: "r", error: null }, events };
  host.thread = { ...thread, state: threadState };
  host.overview = { threads: [{ id: "t1", title: thread.title, state: "working", project: thread.project, archived: false } as never], archived: { shown: 0, total: 0 }, unknown: 0 };
  const touch = size.touch ?? true;
  // WebKit on Linux has no mobile emulation; it still has touch.
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: touch && engine === "chromium", hasTouch: touch, deviceScaleFactor: 2, reducedMotion: "reduce" });
  if (size.ios) await context.addInitScript(fakeVisualViewport);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  const label = `${engine} ${name} (${size.width}x${size.height})`;
  try {
    await page.goto(`${host.url}/#/${route}`);
    if (route === "chat" || route.startsWith("t/")) {
      await page.locator(`${ACTIVE} .composer textarea`).waitFor();
      await page.locator(ACTIVE).getByText("a path with no break").waitFor();
    } else await page.locator(`${ACTIVE} main h1`).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await run(page, host);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${label}`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${label}\n`, error);
  } finally {
    await context.close();
    await host.close();
  }
}

/** Focuses the composer and shrinks the room as a keyboard does: the whole
 * viewport (Android) or only the visual viewport (iOS). */
async function openKeyboard(page: Page, size: { width: number; height: number; ios?: boolean }, room: number): Promise<void> {
  await page.locator(`${ACTIVE} .composer textarea`).focus();
  if (size.ios) await page.evaluate(height => (window.visualViewport as unknown as { set: (h: number) => void }).set(height), room);
  else await page.setViewportSize({ width: size.width, height: room });
  await settle(page);
}
async function closeKeyboard(page: Page, size: { width: number; height: number; ios?: boolean }): Promise<void> {
  await page.locator(`${ACTIVE} .composer textarea`).blur();
  await settle(page);
  assert.equal(await keyboard(page), null, "leaving the field ends typing before the keyboard has gone");
  if (size.ios) await page.evaluate(() => (window.visualViewport as unknown as { set: (h: null) => void }).set(null));
  else await page.setViewportSize({ width: size.width, height: size.height });
  await settle(page);
}

async function suite(type: BrowserType, engine: string): Promise<void> {
  const browser = await type.launch();
  const phones = [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }];

  for (const phone of phones) {
    const tag = `${phone.width}x${phone.height}`;
    await scenario(browser, engine, "the chat on a phone: one quiet row above the conversation, the index a key away", phone, "chat", async page => {
      assert.equal(await page.locator(`${ACTIVE} .thread-strip, .work-panel, header nav, .nav-menu-key`).count(), 0, "no strip, panel, menu or destinations");
      const bar = await box(page, ".sheet-bar");
      assert.ok(bar.height <= 50, `one quiet row: ${bar.height}`);
      const transcript = await box(page, ".transcript");
      assert.ok(transcript.height >= phone.height * 0.65, `the conversation has the screen: ${transcript.height}`);
      for (const key of [".sheet-bar .name-key", ".composer .attach-key", ".composer .send-key"]) await assertHitArea(page, key);
      assert.equal(await page.locator(`${ACTIVE} .composer-row > *`).count(), 1, "nothing beside the field: no key or count before it");
      assert.ok(Math.abs((await box(page, ".composer-field")).left - (await box(page, ".transcript-column")).left) <= 0.5, "the field keeps the column's line");
      assert.ok(Math.abs(phone.height - (await box(page, ".composer-field")).bottom - 16) <= 0.5, "the field stands 1rem off the bottom edge");
      await assertNoSideways(page);
      await shoot(page, engine, `chat-${tag}`);
    });

    await scenario(browser, engine, "elsewhere the menu opens, lists every destination at a fingertip's height and closes", phone, "threads", async page => {
      const key = page.locator(`${ACTIVE} .nav-menu-key`);
      await key.tap();
      assert.equal(await key.getAttribute("aria-expanded"), "true");
      const links = page.locator("header nav a");
      const names = await links.allTextContents();
      for (const name of ["chat", "threads", "artifacts", "projects", "settings"]) assert.ok(names.includes(name), `the menu lists ${name}`);
      for (const link of await links.all()) assert.ok(await link.isVisible(), "every destination is in the menu, in view");
      const heights = await links.evaluateAll(all => all.map(link => link.getBoundingClientRect().height));
      assert.ok(heights.every(height => height >= 43.9), `each destination is a full key high: ${heights}`);
      await assertNoSideways(page);
      await shoot(page, engine, `chat-menu-${tag}`);
      await page.keyboard.press("Escape");
      assert.equal(await key.getAttribute("aria-expanded"), "false", "escape closes it");
      assert.ok(await key.evaluate(el => el === document.activeElement), "and hands focus back to the key");
      await key.tap();
      const main = await box(page, "main");
      await page.touchscreen.tap(main.right - 20, main.bottom - 20);
      assert.equal(await key.getAttribute("aria-expanded"), "false", "a press outside closes it");
      await key.tap();
      await page.locator("header nav a", { hasText: "projects" }).tap();
      await page.waitForURL(/#\/projects$/);
      assert.equal(await page.locator(`${ACTIVE} .nav-menu-key`).getAttribute("aria-expanded"), "false", "a choice closes it");
    });
  }

  const phone = { width: 375, height: 667 };
  await scenario(browser, engine, "the wordmark raises the index over the whole screen: threads, places, model and memory at a fingertip", phone, "chat", async (page, host) => {
    await page.locator(`${ACTIVE} .sheet-bar .name-key`).tap();
    const index = page.locator(`${ACTIVE} .chat-index`);
    await index.locator(".index-row").first().waitFor();
    await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "DIALOG", "a tap gives the sheet focus, not the filter");
    assert.equal(await keyboard(page), null, "no keyboard rises");
    await assertHitArea(page, ".chat-index .index-close");
    const sheet = await box(page, ".chat-index");
    assert.ok(Math.abs(sheet.top) <= 1 && Math.abs(sheet.bottom - phone.height) <= 1 && sheet.width >= phone.width - 1, `the index is the whole screen: ${JSON.stringify(sheet)}`);
    const heights = await index.locator(".index-row").evaluateAll(all => all.map(row => row.getBoundingClientRect().height));
    assert.ok(heights.every(height => height >= 43.9), `each row is a fingertip high: ${heights}`);
    assert.deepEqual(await index.locator(".index-places a").allTextContents(), ["threads", "artifacts", "projects", "settings"]);
    assert.ok(await index.locator("select[aria-label=model]").isVisible(), "the model is in the index");
    assert.ok(host.requests.includes("GET /api/optchat/model"));
    await assertNoSideways(page);
    await shoot(page, engine, "chat-index-375x667");
    await index.getByRole("button", { name: /memory/ }).tap();
    await page.locator("#chat-memory").waitFor();
    assert.equal(await index.evaluate(element => (element as HTMLDialogElement).open), false, "the index makes way for the memory");
    // its close event gives focus back to the key, a task later: then type
    await page.waitForFunction(() => document.activeElement?.classList.contains("name-key"));
    await settle(page);
    await openKeyboard(page, phone, 347);
    const typing = await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open", undefined, { timeout: 10_000 }).then(() => null, async () =>
      page.evaluate(() => JSON.stringify({ active: document.activeElement?.tagName + "." + document.activeElement?.className, scale: visualViewport?.scale, vv: visualViewport?.height, inner: innerHeight, dialog: (document.querySelector(".chat-index") as HTMLDialogElement | null)?.open })));
    assert.equal(typing, null, `the keyboard reads as up: ${typing}`);
    assert.equal(await visible(page, "#chat-memory"), false, "typing, the memory steps aside");
  });

  // a home indicator's inset (Chromium can set one; WebKit here cannot)
  if (engine === "chromium") for (const route of ["chat", "t/t1"]) {
    const size = { width: 390, height: 844, ios: true };
    await scenario(browser, engine, `the home indicator's inset is the floor under the composer; the keyboard takes its place (${route})`, size, route, async page => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never);
      await settle(page);
      const lift = () => box(page, ".composer-field").then(field => field.bottom);
      assert.ok(Math.abs(size.height - await lift() - 38) <= 0.5, `the inset and a breath under the field: ${size.height - await lift()}`);
      await shoot(page, engine, `${route === "chat" ? "chat" : "thread"}-inset-390x844`);
      await openKeyboard(page, size, 524);
      await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open");
      assert.ok(Math.abs(524 - await lift() - 13.6) <= 0.5, `no inset over the keys: ${524 - await lift()}`);
      await closeKeyboard(page, size);
      assert.ok(Math.abs(size.height - await lift() - 38) <= 0.5, `the inset is back with the keyboard down: ${size.height - await lift()}`);
    });
  }

  for (const ios of [false, true]) {
    const way = ios ? "visual viewport only (iOS)" : "whole viewport (Android)";
    for (const size of [{ width: 375, height: 667, ios }, { width: 390, height: 844, ios }]) {
      const room = size.height - 320;
      await scenario(browser, engine, `typing in the chat: the keyboard takes the ${way}; the conversation keeps the room`, size, "chat", async page => {
        await atEnd(page, "the view starts at the end");
        await openKeyboard(page, size, room);
        await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open");
        assert.equal(await visible(page, ".sheet-bar"), false, "the wordmark's row steps aside");
        const composer = await box(page, ".composer");
        const app = await box(page, "#app");
        assert.ok(Math.abs(app.height - room) < 1, `the app is the room above the keyboard: ${app.height} against ${room}`);
        // the pane's own hairline is the last pixel
        assert.ok(Math.abs(composer.bottom - room) <= 1, `the composer sits on the keyboard: ${composer.bottom}`);
        const lift = room - (await box(page, ".composer-field")).bottom;
        assert.ok(Math.abs(lift - 13.6) <= 0.5, `the field sits close on the keys: ${lift}`);
        const transcript = await box(page, ".transcript");
        assert.ok(transcript.height >= room - 130, `the conversation keeps the room: ${transcript.height} of ${room}`);
        await atEnd(page, "and still shows the end");
        await page.keyboard.type("a draft");
        assert.ok(await page.locator(`${ACTIVE} .composer textarea`).evaluate(el => el === document.activeElement), "the field keeps focus");
        await shoot(page, engine, `chat-keyboard-${ios ? "ios" : "android"}-${size.width}x${size.height}`, room);
        await closeKeyboard(page, size);
        assert.equal(await keyboard(page), null);
        assert.ok(await visible(page, "header"), "the header comes back");
        assert.equal(await page.locator(`${ACTIVE} .composer textarea`).inputValue(), "a draft", "the draft stays");
      });
    }
    await scenario(browser, engine, `typing in a thread: the keyboard takes the ${way}`, { ...phone, ios }, "t/t1", async page => {
      await openKeyboard(page, { ...phone, ios }, 347);
      await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open");
      const strip = await box(page, ".thread-pane .thread-strip");
      assert.ok(strip.height <= 50, `the strip stays one row: ${strip.height}`);
      const transcript = await box(page, ".transcript");
      assert.ok(transcript.height >= 347 - 130, `the conversation keeps the room: ${transcript.height}`);
      await shoot(page, engine, `thread-keyboard-${ios ? "ios" : "android"}-375x667`, 347);
    });
  }

  await scenario(browser, engine, "a thread has the whole screen: one row of the way back, its name and details; details hold project, model and archive", phone, "t/t1", async page => {
    const strip = await box(page, ".thread-pane .thread-strip");
    assert.ok(strip.height <= 50, `one row: ${strip.height}`);
    assert.equal(await page.locator(`${ACTIVE} :is(.thread-sidebar, .main-header, nav, .nav-menu-key)`).count(), 0, "no menu, destinations or thread list");
    for (const hidden of [".strip-project", ".strip-model", ".thread-details .key-bank"]) assert.equal(await visible(page, hidden), false, `${hidden} folded`);
    const back = await box(page, ".thread-pane .bar-back");
    const title = await box(page, ".thread-pane .bar-title");
    const key = await box(page, ".thread-pane .strip-details-key");
    assert.ok(back.right <= title.left && title.right <= key.left, "the way back, then a long title that gives way to the details key");
    for (const selector of [".thread-pane .bar-back", ".thread-pane .strip-details-key", ".composer .send-key"]) await assertHitArea(page, selector);
    await assertNoSideways(page);
    await shoot(page, engine, "thread-375x667");
    await page.locator(`${ACTIVE} .thread-pane .strip-details-key`).tap();
    for (const shown of [".strip-project", ".strip-model", ".thread-details .key-bank"]) assert.ok(await visible(page, shown), `${shown} shows`);
    assert.ok((await box(page, ".strip-model")).top >= key.bottom, "the details take the row under the bar");
    await assertNoSideways(page);
    await shoot(page, engine, "thread-details-375x667");
    // the composer taking focus folds them again, so the conversation keeps the room
    await page.locator(`${ACTIVE} .composer textarea`).focus();
    assert.equal(await visible(page, ".strip-project"), false, "the details fold as the composer takes focus");
  });

  await scenario(browser, engine, "a thread's failure stays in print with the details folded", phone, "t/t1", async page => {
    assert.ok(await visible(page, ".thread-pane .strip-state.error"), "the error label shows");
    assert.equal(await visible(page, ".strip-model"), false, "the rest stays folded");
    await assertNoSideways(page);
  }, "error");

  await scenario(browser, engine, "an attached image shows above a compact composer, keys in reach", phone, "chat", async page => {
    await page.locator(`${ACTIVE} .composer input[type=file]`).setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.locator(`${ACTIVE} .attachment img`).waitFor();
    await page.locator(`${ACTIVE} .attachment-state`, { hasText: "ready" }).waitFor();
    await openKeyboard(page, phone, 347);
    const attachment = await box(page, ".attachment");
    const field = await box(page, ".composer-field");
    assert.ok(attachment.bottom <= field.top && attachment.top >= 0, "the image sits above the field, in view");
    assert.ok(field.height <= 48, `one line of field: ${field.height}`);
    for (const key of [".composer .attach-key", ".composer .send-key", ".attachment-remove"]) assert.ok(await visible(page, key));
    await shoot(page, engine, "chat-image-keyboard-375x667");
  });

  await scenario(browser, engine, "turned on its side and back: the chrome folds, a keyboard leaves the composer and the conversation", { width: 667, height: 375 }, "chat", async page => {
    assert.ok((await box(page, ".sheet-bar")).height <= 50, "one quiet row");
    assert.equal((await box(page, ".composer .send-key")).height, 36, "a phone on its side has a phone's keys");
    await assertHitArea(page, ".composer .send-key");
    await assertHitArea(page, ".sheet-bar .name-key");
    await assertNoSideways(page);
    await shoot(page, engine, "chat-landscape-667x375");
    await openKeyboard(page, { width: 667, height: 375 }, 175);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === "tight");
    assert.equal(await visible(page, ".sheet-bar"), false, "with so little room only the conversation and the composer stay");
    const transcript = await box(page, ".transcript");
    assert.ok(transcript.height >= 100, `lines of conversation remain: ${transcript.height}`);
    await shoot(page, engine, "chat-landscape-keyboard-667x375");
    await closeKeyboard(page, { width: 667, height: 375 });
    await page.setViewportSize({ width: 375, height: 667 });
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, ".sheet-bar"));
    assert.ok((await box(page, ".composer")).bottom <= 667);
    await assertNoSideways(page);
  });

  for (const ios of [false, true]) {
    const way = ios ? "visual viewport only (iOS)" : "whole viewport (Android)";
    await scenario(browser, engine, `typing in the index's filter with the keyboard up, ${way}: the index is the whole screen above it, its results scroll on their own`, { ...phone, ios }, "chat", async (page, host) => {
      // enough threads that the results outgrow the room the keyboard leaves
      host.overview = { threads: Array.from({ length: 14 }, (_, n) => ({ id: `t${n}`, title: n === 3 ? "fix the flaky artifact test" : `thread number ${n} about the gateway`, state: n % 3 ? "completed" : "working",
        project: { id: "p1", name: "cube" }, archived: false, spawned: null })), archived: { shown: 0, total: 0 }, unknown: 0 };
      await page.locator(`${ACTIVE} .sheet-bar .name-key`).tap();
      const index = page.locator(`${ACTIVE} .chat-index`);
      await index.locator(".index-row").nth(13).waitFor({ state: "attached" });
      const filter = index.locator("input[type=search]");
      await filter.tap();
      // the keyboard rises over the bottom 320px, as the user types
      const room = phone.height - 320;
      if (ios) await page.evaluate(height => (window.visualViewport as unknown as { set: (h: number) => void }).set(height), room);
      else await page.setViewportSize({ width: phone.width, height: room });
      await settle(page);
      await page.keyboard.type("gateway");
      await settle(page);
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value), "gateway", "the filter keeps focus and the words typed");
      const sheet = await box(page, ".chat-index");
      assert.ok(Math.abs(sheet.top) <= 1 && Math.abs(sheet.bottom - room) <= 1 && sheet.left <= 0.5 && sheet.width >= phone.width - 1,
        `the index fills the room above the keyboard: ${JSON.stringify(sheet)} in ${phone.width}x${room}`);
      const field = await box(page, ".chat-index input[type=search]");
      assert.ok(field.top >= 0 && field.bottom <= room, `the filter is in view: ${field.top}–${field.bottom} of ${room}`);
      const close = await box(page, ".chat-index .index-close");
      assert.ok(close.top >= 0 && close.bottom <= room, "the close key is in view");
      const first = await box(page, ".chat-index .index-row");
      assert.ok(first.top >= field.bottom && first.bottom <= room, `the first result is in view: ${first.top}–${first.bottom} of ${room}`);
      assert.equal(await index.locator(".index-row[href^='#/t/']").count(), 13, "the filter narrows the results");
      // the results scroll on their own; the filter and the page stay put
      const scrolled = await page.locator(`${ACTIVE} .chat-index .index-body`).evaluate(body => { body.scrollTop = body.scrollHeight; return { top: body.scrollTop, room: body.scrollHeight - body.clientHeight }; });
      assert.ok(scrolled.room > 0 && scrolled.top > 0, `the results scroll: ${JSON.stringify(scrolled)}`);
      await settle(page);
      assert.deepEqual(await box(page, ".chat-index input[type=search]"), field, "the filter stays where it is");
      assert.equal(await page.evaluate(() => [window.scrollY, document.scrollingElement?.scrollTop ?? 0].join()), "0,0", "the page behind does not scroll");
      await assertNoSideways(page);
      await shoot(page, engine, `index-filter-keyboard-${ios ? "ios" : "android"}-375x667`, room);
      // closing gives focus back to the key that opened it
      await page.locator(`${ACTIVE} .chat-index .index-close`).tap();
      await index.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.classList.contains("name-key"));
      if (ios) await page.evaluate(() => (window.visualViewport as unknown as { set: (h: null) => void }).set(null));
      else await page.setViewportSize({ width: phone.width, height: phone.height });
      await settle(page);
      assert.equal(await keyboard(page), null, "no field, no keyboard");
    });
  }

  await scenario(browser, engine, "leaving the chat while the index is open (a route change, back) leaves none of its viewport listeners behind", { ...phone, ios: true }, "chat", async page => {
    // Every resize/scroll listener added from here on to the window and the
    // visual viewport, by function, while it is live. (Installed in the page
    // as it is: a reload would cut the open stream, which WebKit reports as an error.)
    await page.evaluate(() => {
      const live = new Set<unknown>();
      const ids = new Map<unknown, number>();
      const key = (target: EventTarget, type: string, listener: unknown) => {
        if (!ids.has(listener)) ids.set(listener, ids.size);
        return `${target === window ? "window" : "viewport"}:${type}:${ids.get(listener)}`;
      };
      const watched = (target: EventTarget, type: string) => (target === window || target === window.visualViewport) && (type === "resize" || type === "scroll");
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (listener && watched(this, type)) live.add(key(this, type, listener));
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if (listener && watched(this, type)) live.delete(key(this, type, listener));
        return remove.call(this, type, listener, options);
      };
      (window as unknown as { liveListeners: () => string[] }).liveListeners = () => [...live] as string[];
    });
    const listeners = () => page.evaluate(() => (window as unknown as { liveListeners: () => string[] }).liveListeners());
    // history: chat, threads, chat
    await page.evaluate(() => { location.hash = "#/threads"; });
    await page.locator(`${ACTIVE} main h1`).waitFor();
    await page.evaluate(() => { location.hash = "#/chat"; });
    await page.locator(`${ACTIVE} .sheet-bar .name-key`).waitFor();
    for (const leave of ["back", "route"] as const) {
      const before = new Set(await listeners());
      await page.locator(`${ACTIVE} .sheet-bar .name-key`).tap();
      await page.locator(`${ACTIVE} .chat-index .index-row`).first().waitFor();
      const opened = (await listeners()).filter(item => !before.has(item));
      assert.equal(opened.length, 3, `the open index follows the viewport: ${opened.join(" ")}`);
      if (leave === "back") await page.goBack();
      else await page.evaluate(() => { location.hash = "#/projects"; });
      await page.locator(`${ACTIVE} main h1`).waitFor();
      await settle(page);
      assert.equal(await page.locator(`${ACTIVE} .chat-index`).count(), 0, "the index went with the chat");
      const left = (await listeners()).filter(item => opened.includes(item));
      assert.deepEqual(left, [], `after ${leave === "back" ? "going back" : "a route change"} none of the index's listeners is left`);
      if (leave === "back") { await page.goForward(); await page.locator(`${ACTIVE} .sheet-bar .name-key`).waitFor(); }
    }
  });

  await scenario(browser, engine, "the index's model choice is no keyboard", phone, "chat", async page => {
    await page.locator(`${ACTIVE} .sheet-bar .name-key`).tap();
    await page.locator(`${ACTIVE} .chat-index select[aria-label=model]`).focus();
    await page.setViewportSize({ width: 375, height: 347 });
    await settle(page);
    assert.equal(await keyboard(page), null, "a focused select is not typing");
    await page.setViewportSize({ width: 375, height: 667 });
    await page.keyboard.press("Escape");
    assert.ok(await visible(page, ".sheet-bar"));
  });

  await scenario(browser, engine, "Tab out of the open menu closes it", phone, "threads", async page => {
    const key = page.locator(`${ACTIVE} .nav-menu-key`);
    await key.tap();
    const last = page.locator("header nav a").last();
    await last.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("header nav")), false, "focus left the menu");
    assert.equal(await key.getAttribute("aria-expanded"), "false");
  });

  await scenario(browser, engine, "focus never stays on a destination the menu folded away", phone, "threads", async page => {
    const key = page.locator(`${ACTIVE} .nav-menu-key`);
    await key.tap();
    await page.locator("header nav a", { hasText: "projects" }).focus();
    const main = await box(page, "main");
    await page.touchscreen.tap(main.right - 20, main.bottom - 20);
    assert.equal(await key.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("header nav")), false, "a press outside moves focus off the folded menu");
    await key.tap();
    await page.locator("header nav a", { hasText: "threads" }).tap();
    assert.equal(await key.getAttribute("aria-expanded"), "false", "the page already open closes the menu");
    assert.ok(await key.evaluate(el => el === document.activeElement), "and focus stays on the key");
  });

  await scenario(browser, engine, "turned with the keyboard up (Android): typing carries over to the new width", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    assert.equal(await keyboard(page), "open");
    await page.setViewportSize({ width: 667, height: 175 });
    await settle(page);
    assert.equal(await keyboard(page), "tight", "still typing on its side");
    assert.equal(await visible(page, ".sheet-bar"), false);
    // the keyboard goes down with focus kept (Android's back key): the chrome returns
    await page.setViewportSize({ width: 667, height: 375 });
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "turned with the keyboard up, it drops for the turn and rises again; back down, the chrome returns", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    for (const [width, height, expected] of [[667, 375, "open"], [667, 175, "tight"], [667, 375, null]] as const) {
      await page.setViewportSize({ width, height });
      await settle(page);
      assert.equal(await keyboard(page), expected, `${width}x${height}`);
    }
  });

  await scenario(browser, engine, "turned with the keyboard up, it stays down: leaving the field measures the room, and the chrome stays", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    await page.setViewportSize({ width: 667, height: 375 });
    await settle(page);
    assert.equal(await keyboard(page), "open", "no measure yet at this width");
    await page.locator(`${ACTIVE} .composer textarea`).blur();
    await page.waitForTimeout(800);
    await page.locator(`${ACTIVE} .composer textarea`).focus();
    await settle(page);
    assert.equal(await keyboard(page), null, "the room it showed with no keyboard is the measure");
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "turned with the keyboard up, leaving and coming back before it drops keeps typing", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    await page.setViewportSize({ width: 667, height: 175 });
    await settle(page);
    assert.equal(await keyboard(page), "tight");
    await page.locator(`${ACTIVE} .composer textarea`).blur();
    await settle(page);
    assert.equal(await keyboard(page), null, "no field, no typing");
    await page.locator(`${ACTIVE} .composer textarea`).focus();
    await settle(page);
    assert.equal(await keyboard(page), "tight", "the keyboard never went down");
  });

  await scenario(browser, engine, "zoomed in with the keyboard up (iOS), leaving the field still brings the chrome back", { ...phone, ios: true }, "chat", async page => {
    await openKeyboard(page, { ...phone, ios: true }, 347);
    assert.equal(await keyboard(page), "open");
    await page.evaluate(() => (window.visualViewport as unknown as { zoom: (s: number) => void }).zoom(1.6));
    assert.equal(await keyboard(page), "open", "zooming in alone keeps typing");
    await page.locator(`${ACTIVE} .composer textarea`).blur();
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "a narrow desktop window shortened by hand is not a keyboard", { width: 600, height: 800, touch: false }, "chat", async page => {
    assert.ok(await visible(page, ".sheet-bar"), "a narrow window keeps its one row");
    await page.locator(`${ACTIVE} .composer textarea`).focus();
    await page.setViewportSize({ width: 600, height: 650 });
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "the desktop: the sheet and its margin, no menu or details keys", { width: 1280, height: 800, touch: false }, "chat", async page => {
    assert.ok(await visible(page, ".sheet-margin"), "the margin is drawn");
    assert.equal(await page.locator(`${ACTIVE} .nav-menu-key, .strip-details-key, header nav`).count(), 0);
    await page.locator(`${ACTIVE} .composer textarea`).focus();
    await settle(page);
    assert.equal(await keyboard(page), null, "a focused field without a keyboard changes nothing");
    assert.ok(await visible(page, "header"));
    assert.equal((await box(page, ".composer .send-key")).height, 32, "the desktop's keys keep their size");
    await shoot(page, engine, "chat-desktop-1280x800");
  });

  await browser.close();
}

await suite(chromium, "chromium");
if (fs.existsSync(webkit.executablePath())) await suite(webkit, "webkit");
else console.log("SKIP: webkit (install it: pnpm --filter @cube/web exec playwright install webkit)");
process.exit(failed ? 1 : 0);
