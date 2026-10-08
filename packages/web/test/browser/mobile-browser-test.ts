/** The chat and a thread on a phone, in a real browser against a scripted
 * host: the destinations fold behind a menu key, the strips into one row
 * with a details key, and while the keyboard is up the chrome steps aside
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
const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate(element => {
  const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
  return { top, bottom, left, right, height, width };
});
const visible = (page: Page, selector: string) => page.locator(selector).first().isVisible();
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const keyboard = (page: Page) => page.evaluate(() => document.documentElement.dataset.keyboard ?? null);
/** With `room`, only what is above a keyboard that only the visual viewport knows of. */
const shoot = async (page: Page, engine: string, name: string, room?: number) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${engine}-${name}.png`), ...(room ? { clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: room } } : {}) });
};

/** A fingertip lands anywhere within 2.75rem (44px) centred on the key. */
async function assertHitArea(page: Page, selector: string): Promise<void> {
  const misses = await page.locator(selector).first().evaluate(element => {
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
    await page.locator(".composer textarea").waitFor();
    await page.getByText("a path with no break").waitFor();
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
  await page.locator(".composer textarea").focus();
  if (size.ios) await page.evaluate(height => (window.visualViewport as unknown as { set: (h: number) => void }).set(height), room);
  else await page.setViewportSize({ width: size.width, height: room });
  await settle(page);
}
async function closeKeyboard(page: Page, size: { width: number; height: number; ios?: boolean }): Promise<void> {
  await page.locator(".composer textarea").blur();
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
    await scenario(browser, engine, "the chat on a phone: one header row, one strip row, the threads folded", phone, "chat", async page => {
      assert.ok(await visible(page, ".nav-menu-key"), "the menu key shows");
      assert.equal(await visible(page, "header nav"), false, "the destinations are folded");
      assert.equal(await visible(page, ".chat-workspace .strip-model"), false, "the model is behind details");
      assert.equal(await page.locator(".work-fold").getAttribute("aria-expanded"), "false", "the threads panel starts folded");
      const header = await box(page, "header");
      const strip = await box(page, ".thread-strip");
      assert.ok(header.height <= 50, `header is one row: ${header.height}`);
      assert.ok(strip.height <= 50, `strip is one row: ${strip.height}`);
      const transcript = await box(page, ".transcript");
      assert.ok(transcript.height >= phone.height * 0.5, `the conversation has half the screen: ${transcript.height}`);
      for (const key of [".nav-menu-key", ".strip-details-key", ".composer .attach-key", ".composer .send-key"]) await assertHitArea(page, key);
      await assertNoSideways(page);
      await shoot(page, engine, `chat-${tag}`);
    });

    await scenario(browser, engine, "the menu opens, lists every destination at a fingertip's height and closes", phone, "chat", async page => {
      const key = page.locator(".nav-menu-key");
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
      const transcript = await box(page, ".transcript");
      await page.touchscreen.tap(transcript.right - 20, transcript.bottom - 20);
      assert.equal(await key.getAttribute("aria-expanded"), "false", "a press outside closes it");
      await key.tap();
      await page.locator("header nav a", { hasText: "threads" }).tap();
      await page.waitForURL(/#\/threads$/);
      assert.equal(await page.locator(".nav-menu-key").getAttribute("aria-expanded"), "false", "a choice closes it");
    });
  }

  const phone = { width: 375, height: 667 };
  await scenario(browser, engine, "the chat's details key shows the model and memory; the composer folds them", phone, "chat", async (page, host) => {
    const details = page.locator(".chat-workspace .strip-details-key");
    await details.tap();
    assert.equal(await details.getAttribute("aria-expanded"), "true");
    assert.ok(await visible(page, ".chat-workspace .strip-model select"), "the model shows");
    assert.ok(await visible(page, ".chat-workspace .strip-toggle[aria-controls=chat-memory]"), "memory shows");
    await shoot(page, engine, "chat-details-375x667");
    assert.ok(host.requests.includes("GET /api/optchat/model"));
    await page.locator(".composer textarea").tap();
    assert.equal(await details.getAttribute("aria-expanded"), "false", "typing folds the details");
    assert.equal(await visible(page, ".chat-workspace .strip-model"), false);
  });

  for (const ios of [false, true]) {
    const way = ios ? "visual viewport only (iOS)" : "whole viewport (Android)";
    for (const size of [{ width: 375, height: 667, ios }, { width: 390, height: 844, ios }]) {
      const room = size.height - 320;
      await scenario(browser, engine, `typing in the chat: the keyboard takes the ${way}; the conversation keeps the room`, size, "chat", async page => {
        await page.locator(".work-fold").tap();
        await atEnd(page, "the view starts at the end");
        await openKeyboard(page, size, room);
        await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open");
        assert.equal(await visible(page, "header"), false, "the header steps aside");
        assert.equal(await visible(page, ".work-panel"), false, "the threads panel steps aside, even unfolded");
        assert.ok(await visible(page, ".chat-workspace .thread-strip"), "the strip stays");
        const composer = await box(page, ".composer");
        const app = await box(page, "#app");
        assert.ok(Math.abs(app.height - room) < 1, `the app is the room above the keyboard: ${app.height} against ${room}`);
        // the pane's own hairline is the last pixel
        assert.ok(Math.abs(composer.bottom - room) <= 1, `the composer sits on the keyboard: ${composer.bottom}`);
        const transcript = await box(page, ".transcript");
        assert.ok(transcript.height >= room - 130, `the conversation keeps the room: ${transcript.height} of ${room}`);
        await atEnd(page, "and still shows the end");
        await page.keyboard.type("a draft");
        assert.ok(await page.locator(".composer textarea").evaluate(el => el === document.activeElement), "the field keeps focus");
        await shoot(page, engine, `chat-keyboard-${ios ? "ios" : "android"}-${size.width}x${size.height}`, room);
        await closeKeyboard(page, size);
        assert.equal(await keyboard(page), null);
        assert.ok(await visible(page, "header"), "the header comes back");
        assert.equal(await page.locator(".composer textarea").inputValue(), "a draft", "the draft stays");
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

  await scenario(browser, engine, "a thread's strip is one row: lamp, title, details; details hold project, model and archive", phone, "t/t1", async page => {
    const strip = await box(page, ".thread-pane .thread-strip");
    assert.ok(strip.height <= 50, `one row: ${strip.height}`);
    for (const hidden of [".strip-project", ".strip-model", ".thread-strip .key-bank"]) assert.equal(await visible(page, hidden), false, `${hidden} folded`);
    const title = await box(page, ".mobile-thread-switch");
    const key = await box(page, ".thread-pane .strip-details-key");
    assert.ok(title.right <= key.left, "a long title gives way to the details key");
    for (const selector of [".mobile-thread-switch", ".thread-pane .strip-details-key", ".composer .send-key"]) await assertHitArea(page, selector);
    await assertNoSideways(page);
    await shoot(page, engine, "thread-375x667");
    await page.locator(".thread-pane .strip-details-key").tap();
    for (const shown of [".strip-project", ".strip-model", ".thread-strip .key-bank"]) assert.ok(await visible(page, shown), `${shown} shows`);
    assert.ok((await box(page, ".strip-model")).top >= key.bottom, "the details take the row under the title");
    await assertNoSideways(page);
    await shoot(page, engine, "thread-details-375x667");
    // the thread drawer still opens from the title and carries the destinations
    await page.locator(".mobile-thread-switch").tap();
    await page.locator(".thread-sidebar.open").waitFor();
    assert.ok(await visible(page, ".thread-navigation header nav"), "the drawer shows its destinations inline");
    assert.equal(await visible(page, ".thread-navigation .nav-menu-key"), false);
  });

  await scenario(browser, engine, "a thread's failure stays in print with the details folded", phone, "t/t1", async page => {
    assert.ok(await visible(page, ".thread-pane .strip-state.error"), "the error label shows");
    assert.equal(await visible(page, ".strip-model"), false, "the rest stays folded");
    await assertNoSideways(page);
  }, "error");

  await scenario(browser, engine, "an attached image shows above a compact composer, keys in reach", phone, "chat", async page => {
    await page.locator(".composer input[type=file]").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
    await page.locator(".attachment img").waitFor();
    await page.locator(".attachment-state", { hasText: "ready" }).waitFor();
    await openKeyboard(page, phone, 347);
    const attachment = await box(page, ".attachment");
    const field = await box(page, ".composer-field");
    assert.ok(attachment.bottom <= field.top && attachment.top >= 0, "the image sits above the field, in view");
    assert.ok(field.height <= 48, `one line of field: ${field.height}`);
    for (const key of [".composer .attach-key", ".composer .send-key", ".attachment-remove"]) assert.ok(await visible(page, key));
    await shoot(page, engine, "chat-image-keyboard-375x667");
  });

  await scenario(browser, engine, "turned on its side and back: the chrome folds, a keyboard leaves the composer and the conversation", { width: 667, height: 375 }, "chat", async page => {
    assert.ok(await visible(page, ".nav-menu-key"), "a short touch screen folds the destinations");
    assert.equal((await box(page, ".composer .send-key")).height, 36, "a phone on its side has a phone's keys");
    await assertHitArea(page, ".composer .send-key");
    assert.ok((await box(page, ".thread-strip")).height <= 50);
    await assertNoSideways(page);
    await shoot(page, engine, "chat-landscape-667x375");
    await openKeyboard(page, { width: 667, height: 375 }, 175);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === "tight");
    assert.equal(await visible(page, ".chat-workspace .thread-strip"), false, "with so little room the strip steps aside too");
    const transcript = await box(page, ".transcript");
    assert.ok(transcript.height >= 100, `lines of conversation remain: ${transcript.height}`);
    await shoot(page, engine, "chat-landscape-keyboard-667x375");
    await closeKeyboard(page, { width: 667, height: 375 });
    await page.setViewportSize({ width: 375, height: 667 });
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header") && await visible(page, ".nav-menu-key"));
    assert.ok((await box(page, ".composer")).bottom <= 667);
    await assertNoSideways(page);
  });

  await scenario(browser, engine, "the details' model choice is no keyboard; open memory folds with the details", phone, "chat", async page => {
    await page.locator(".chat-workspace .strip-details-key").tap();
    await page.locator(".strip-model select").focus();
    await page.setViewportSize({ width: 375, height: 347 });
    await settle(page);
    assert.equal(await keyboard(page), null, "a focused select is not typing");
    assert.ok(await visible(page, "header"));
    await page.setViewportSize({ width: 375, height: 667 });
    const memory = page.locator(".strip-toggle[aria-controls=chat-memory]");
    await memory.tap();
    await page.locator("#chat-memory").waitFor();
    await page.locator(".composer textarea").tap();
    assert.equal(await memory.getAttribute("aria-expanded"), "false", "memory folds with its toggle");
    assert.equal(await page.locator("#chat-memory").count(), 0);
    // and when the details key itself folds them
    await page.locator(".chat-workspace .strip-details-key").tap();
    await memory.tap();
    await page.locator("#chat-memory").waitFor();
    await page.locator(".chat-workspace .strip-details-key").tap();
    assert.equal(await page.locator("#chat-memory").count(), 0, "folding the details folds memory");
  });

  await scenario(browser, engine, "Tab out of the open menu closes it", phone, "chat", async page => {
    const key = page.locator(".nav-menu-key");
    await key.tap();
    const last = page.locator("header nav a").last();
    await last.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("header")), false, "focus left the header");
    assert.equal(await key.getAttribute("aria-expanded"), "false");
  });

  await scenario(browser, engine, "focus never stays on a destination the menu folded away", phone, "chat", async page => {
    const key = page.locator(".nav-menu-key");
    await key.tap();
    await page.locator("header nav a", { hasText: "projects" }).focus();
    const transcript = await box(page, ".transcript");
    await page.touchscreen.tap(transcript.right - 20, transcript.bottom - 20);
    assert.equal(await key.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("header nav")), false, "a press outside moves focus off the folded menu");
    await key.tap();
    await page.locator("header nav a", { hasText: "chat" }).tap();
    assert.equal(await key.getAttribute("aria-expanded"), "false", "the page already open closes the menu");
    assert.ok(await key.evaluate(el => el === document.activeElement), "and focus stays on the key");
  });

  await scenario(browser, engine, "turned with the keyboard up (Android): typing carries over to the new width", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    assert.equal(await keyboard(page), "open");
    await page.setViewportSize({ width: 667, height: 175 });
    await settle(page);
    assert.equal(await keyboard(page), "tight", "still typing on its side");
    assert.equal(await visible(page, ".chat-workspace .thread-strip"), false);
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
    await page.locator(".composer textarea").blur();
    await page.waitForTimeout(800);
    await page.locator(".composer textarea").focus();
    await settle(page);
    assert.equal(await keyboard(page), null, "the room it showed with no keyboard is the measure");
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "turned with the keyboard up, leaving and coming back before it drops keeps typing", phone, "chat", async page => {
    await openKeyboard(page, phone, 347);
    await page.setViewportSize({ width: 667, height: 175 });
    await settle(page);
    assert.equal(await keyboard(page), "tight");
    await page.locator(".composer textarea").blur();
    await settle(page);
    assert.equal(await keyboard(page), null, "no field, no typing");
    await page.locator(".composer textarea").focus();
    await settle(page);
    assert.equal(await keyboard(page), "tight", "the keyboard never went down");
  });

  await scenario(browser, engine, "zoomed in with the keyboard up (iOS), leaving the field still brings the chrome back", { ...phone, ios: true }, "chat", async page => {
    await openKeyboard(page, { ...phone, ios: true }, 347);
    assert.equal(await keyboard(page), "open");
    await page.evaluate(() => (window.visualViewport as unknown as { zoom: (s: number) => void }).zoom(1.6));
    assert.equal(await keyboard(page), "open", "zooming in alone keeps typing");
    await page.locator(".composer textarea").blur();
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "a narrow desktop window shortened by hand is not a keyboard", { width: 600, height: 800, touch: false }, "chat", async page => {
    assert.ok(await visible(page, ".nav-menu-key"), "a narrow window gets the menu");
    await page.locator(".composer textarea").focus();
    await page.setViewportSize({ width: 600, height: 650 });
    await settle(page);
    assert.equal(await keyboard(page), null);
    assert.ok(await visible(page, "header"));
  });

  await scenario(browser, engine, "the desktop keeps its rows: destinations, model and threads in view, no menu or details keys", { width: 1280, height: 800, touch: false }, "chat", async page => {
    assert.ok(await visible(page, "header nav"));
    assert.equal(await visible(page, ".nav-menu-key"), false);
    assert.equal(await visible(page, ".strip-details-key"), false);
    assert.ok(await visible(page, ".chat-workspace .strip-model select"));
    assert.equal(await page.locator(".work-fold").getAttribute("aria-expanded"), "true");
    await page.locator(".composer textarea").focus();
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
