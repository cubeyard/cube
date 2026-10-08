/** The chat in a real browser against a scripted host: a send shows at once
 * and never goes and comes back, whatever the order and timing of the
 * host's answers; the chat reads busy from the send until the run ends,
 * once. Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright";
import type { ThreadEvent, ThreadTranscript } from "../../src/lib/types.ts";
import { assertAlways, assertSend, monitor } from "./monitor.ts";
import { gate, ScriptedHost } from "./scripted-host.ts";

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string, final = true): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final });
const idle: ThreadTranscript["status"] = { state: "completed", run: "r0", error: null };

const browser = await chromium.launch();
let failed = false;

/** A viewport; `touch` is a phone: a coarse pointer, touch and its keys. */
type Viewport = { width: number; height: number; touch?: boolean };

async function scenario(name: string, run: (page: Page, host: ScriptedHost, watch: Awaited<ReturnType<typeof monitor>>) => Promise<void>, viewport: Viewport = { width: 1280, height: 800 }): Promise<void> {
  const host = await ScriptedHost.start();
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.touch, hasTouch: !!viewport.touch });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    host.transcript = { ...host.transcript, status: idle, events: [user("1.0", "earlier"), agent("2.0.0", "an earlier answer")] };
    const watch = await monitor(page);
    await page.goto(`${host.url}/#/chat`);
    await page.locator(".composer textarea").waitFor();
    await page.getByText("an earlier answer").waitFor();
    await run(page, host, watch);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${name} (${viewport.width}x${viewport.height})`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name} (${viewport.width}x${viewport.height})\n`, error);
  } finally {
    await page.close();
    await host.close();
  }
}

async function send(page: Page, watch: Awaited<ReturnType<typeof monitor>>, text: string, mark = text): Promise<void> {
  await page.locator(".composer textarea").fill(text);
  await watch.mark(mark);
  await page.locator(".composer textarea").press("Enter");
}

type Box = { top: number; bottom: number; left: number; right: number; height: number; width: number };
const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate(element => {
  const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
  return { top, bottom, left, right, height, width };
});
/** The box of an element's own text: two labels of one size share a baseline when these share a bottom. */
const textBox = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate(element => {
  const text = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const { top, bottom, left, right, height, width } = range.getBoundingClientRect();
  return { top, bottom, left, right, height, width };
});
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 0.75, `${what}: ${actual} against ${expected}`);
/** A 1x1 png. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Waits until the page has painted what the host sent. */
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  await scenario("a slow send shows at once, then the host's copy, a streamed answer and the end", async (page, host, watch) => {
    const accepted = gate();
    host.onPrompt = async ({ text, requestId }) => {
      await accepted.promise;
      host.set([...host.transcript.events, user(`pending.${requestId}`, text)], { state: "working", run: "pending" });
    };
    await send(page, watch, "fix the gateway");
    await delay(300);
    await settle(page);
    let record = await watch.since("fix the gateway");
    assert.deepEqual(record.at(-1)!.users, ["earlier", "…fix the gateway"], "sending, before the host answered");
    assert.equal(record.at(-1)!.draft, "");
    accepted.open();
    await page.locator(".conversation-message.user:not(.sending)", { hasText: "fix the gateway" }).waitFor();
    const before = host.transcript.events.slice(0, 2);
    host.set([...before, user("3.0", "fix the gateway")], { state: "working" });
    await settle(page);
    for (const text of ["on", "on it", "on it, reading the gateway"]) {
      host.set([...before, user("3.0", "fix the gateway"), agent("live.1.0", text, false)], { state: "working" });
      await settle(page);
    }
    host.set([...before, user("3.0", "fix the gateway"), agent("4.0.0", "on it, reading the gateway")], { state: "completed" });
    await page.locator(".composer[aria-busy=false]").waitFor();
    await settle(page);
    record = await watch.since("fix the gateway");
    assertSend(record, "fix the gateway");
    assert.ok(record.at(-1)!.gap < 4, `the view follows to the end: ${record.at(-1)!.gap}`);
  }, viewport);
}

await scenario("an older frame after the host's copy does not take the message away", async (page, host, watch) => {
  const stale = host.transcript;
  host.onPrompt = ({ text, requestId }) => { host.set([...stale.events, user(`pending.${requestId}`, text)], { state: "working", run: "pending" }); };
  await send(page, watch, "check the runner");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "check the runner" }).waitFor();
  // A frame from before the send (a slow render of a long chat) arrives late.
  host.frame(stale, { keep: true });
  await settle(page);
  await delay(100);
  host.set([...stale.events, user("3.0", "check the runner")], { state: "working" });
  await settle(page);
  host.set([...stale.events, user("3.0", "check the runner"), agent("4.0.0", "the runner is fine")], { state: "completed" });
  await page.locator(".composer[aria-busy=false]").waitFor();
  await settle(page);
  assertSend(await watch.since("check the runner"), "check the runner");
});

await scenario("a failed send puts the message back in the field, and its retry is the same request", async (page, host, watch) => {
  const answered = gate();
  host.onPrompt = async () => { await answered.promise; throw new Error("the host had a problem handling that — try again"); };
  await send(page, watch, "deploy nothing");
  await page.locator(".conversation-message.user.sending", { hasText: "deploy nothing" }).waitFor();
  // Typed while the send is out: kept, after the message put back.
  await page.locator(".composer textarea").pressSequentially("and more");
  answered.open();
  await page.locator(".conversation-error").waitFor();
  await settle(page);
  const record = await watch.since("deploy nothing");
  const end = record.at(-1)!;
  assert.deepEqual(end.users, ["earlier"], "no message left behind");
  assert.equal(end.draft, "deploy nothing\nand more");
  assert.equal(end.busy, false);
  assert.match(end.error ?? "", /try again/);
  assertAlways(record, seen => seen.users.filter(text => text.endsWith("deploy nothing")).length <= 1, "never twice");
  // The retry: the same request id, so a send the host did take is not taken twice.
  host.onPrompt = ({ text, requestId }) => { host.set([...host.transcript.events, user(`pending.${requestId}`, text)], { state: "working", run: "pending" }); };
  await page.locator(".composer textarea").fill("deploy nothing");
  await watch.mark("retry");
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "deploy nothing" }).waitFor();
  assert.equal(host.prompts.length, 2);
  assert.equal(host.prompts[1]!.requestId, host.prompts[0]!.requestId);
  await settle(page);
  assert.equal((await watch.since("retry")).at(-1)!.error, null, "the error clears on the retry");
});

await scenario("a retry of a send the host took though its answer was lost shows the message once", async (page, host, watch) => {
  const base = host.transcript.events;
  host.onPrompt = ({ text, requestId }) => {
    host.set([...base, user(`pending.${requestId}`, text)], { state: "working", run: "pending" });
    throw new Error("the host is busy or restarting — try again in a moment");
  };
  await send(page, watch, "only once");
  await page.locator(".conversation-error").waitFor();
  await settle(page);
  // The host's copy shows, the field has the text back; the retry is the same request.
  host.onPrompt = () => {};
  await watch.mark("retry once");
  await page.locator(".composer textarea").press("Enter");
  await settle(page);
  assert.equal(host.prompts[1]!.requestId, host.prompts[0]!.requestId);
  host.set([...base, user("3.0", "only once")], { state: "working" });
  await settle(page);
  host.set([...base, user("3.0", "only once"), agent("4.0.0", "done")], { state: "completed" });
  await page.locator(".composer[aria-busy=false]").waitFor();
  await settle(page);
  const record = await watch.since("only once");
  assertAlways(record, seen => seen.users.filter(text => text.endsWith("only once")).length <= 1, "never twice");
  assert.deepEqual(record.at(-1)!.users, ["earlier", "only once"]);
});

await scenario("tool calls and their results stream without the message or the busy state flickering", async (page, host, watch) => {
  const base = host.transcript.events;
  host.onPrompt = ({ text, requestId }) => { host.set([...base, user(`pending.${requestId}`, text)], { state: "working", run: "pending" }); };
  await send(page, watch, "count the files");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "count the files" }).waitFor();
  const asked = [...base, user("3.0", "count the files")];
  const call: ThreadEvent = { type: "tool-call", id: "4.0.0", callId: "c1", name: "bash", input: { command: "ls | wc -l" }, final: true };
  host.set([...asked, call], { state: "working" });
  await page.locator(".tool-strip[open]").waitFor();
  host.set([...asked, call, { type: "tool-result", id: "live.tool.c1", callId: "c1", name: "bash", output: "4", isError: false, final: false }], { state: "working" });
  await settle(page);
  host.set([...asked, call, { type: "tool-result", id: "5.0", callId: "c1", name: "bash", output: "42", isError: false, final: true }], { state: "working" });
  await page.locator(".tool-strip:not([open])").waitFor();
  host.set([...asked, call, { type: "tool-result", id: "5.0", callId: "c1", name: "bash", output: "42", isError: false, final: true }, agent("6.0.0", "42 files")], { state: "completed" });
  await page.locator(".composer[aria-busy=false]").waitFor();
  await settle(page);
  assertSend(await watch.since("count the files"), "count the files");
});

await scenario("a failed run shows its error with the message in place", async (page, host, watch) => {
  const base = host.transcript.events;
  host.onPrompt = ({ text, requestId }) => { host.set([...base, user(`pending.${requestId}`, text)], { state: "working", run: "pending" }); };
  await send(page, watch, "please fail");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "please fail" }).waitFor();
  host.set([...base, user("3.0", "please fail")], { state: "working" });
  await settle(page);
  host.set([...base, user("3.0", "please fail")], { state: "failed", error: "the provider refused" });
  await page.locator(".conversation-error", { hasText: "the provider refused" }).waitFor();
  await settle(page);
  assertSend(await watch.since("please fail"), "please fail");
});

await scenario("a lost stream mid-run reconnects; the message and the run stay, and a reload reads them back", async (page, host, watch) => {
  const base = host.transcript.events;
  host.onPrompt = ({ text, requestId }) => { host.set([...base, user(`pending.${requestId}`, text)], { state: "working", run: "pending" }); };
  await send(page, watch, "keep going");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "keep going" }).waitFor();
  const asked = [...base, user("3.0", "keep going")];
  host.set([...asked, agent("live.1.0", "still", false)], { state: "working" });
  await settle(page);
  host.drop();
  await page.locator(".conversation-note").waitFor();
  host.transcript = { ...host.transcript, events: [...asked, agent("live.1.0", "still going", false)] };
  await page.locator(".conversation-note").waitFor({ state: "detached" });
  host.set([...asked, agent("4.0.0", "still going, done")], { state: "completed" });
  await page.locator(".composer[aria-busy=false]").waitFor();
  await settle(page);
  const record = await watch.since("keep going");
  assertSend(record, "keep going");
  assert.ok(record.some(seen => seen.reconnecting), "the lost stream was shown");
  await page.reload();
  await page.getByText("still going, done").waitFor();
  assert.deepEqual(await page.locator(".conversation-message.user .message-copy").allTextContents(), ["earlier", "keep going"]);
});

await scenario("a message sent while the agent works shows at once and the run reads busy throughout", async (page, host, watch) => {
  const base = host.transcript.events;
  host.set([...base, user("3.0", "first"), agent("live.1.0", "working on", false)], { state: "working" });
  await page.locator(".composer[aria-busy=true]").waitFor();
  near((await box(page, ".stop-key")).height, (await box(page, ".composer-field")).height, "the stop key is as tall as the field beside it");
  // a longer draft grows the field, not the stop key, which stays on its last line
  await page.locator(".composer textarea").fill("one\ntwo\nthree\nfour");
  await page.locator(".composer textarea").dispatchEvent("input");
  const [stopKey, grown] = [await box(page, ".stop-key"), await box(page, ".composer-field")];
  assert.ok(grown.height > stopKey.height + 40, "the field grew past the stop key");
  near(stopKey.bottom, grown.bottom, "the stop key stays on the field's last line");
  await page.locator(".composer textarea").fill("");
  host.onPrompt = ({ text, requestId }) => { host.set([...host.transcript.events, user(`pending.${requestId}`, text)], { state: "working" }); };
  await send(page, watch, "also this");
  await page.locator(".conversation-message.user:not(.sending)", { hasText: "also this" }).waitFor();
  host.set([...base, user("3.0", "first"), agent("4.0.0", "working on it"), user("5.0", "also this")], { state: "working" });
  await settle(page);
  host.set([...base, user("3.0", "first"), agent("4.0.0", "working on it"), user("5.0", "also this"), agent("6.0.0", "both done")], { state: "completed" });
  await page.locator(".composer[aria-busy=false]").waitFor();
  await settle(page);
  assertSend(await watch.since("also this"), "also this");
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768, touch: true }, { width: 390, height: 844, touch: true }]) {
  await scenario("the chat's rails are one band and the composer's keys sit on the text's line", async page => {
    const strip = await box(page, ".thread-strip");
    const work = await box(page, ".work-head");
    near(work.height, strip.height, "the threads head is as tall as the chat strip");
    if (viewport.width <= 832) {
      // stacked: the threads bay above the strip, labels on one left edge
      near((await textBox(page, ".work-head h2")).left, (await box(page, ".thread-strip .lamp")).left, "the threads label starts where the strip's lamp does");
    } else {
      near(work.top, strip.top, "the rails start on one line");
      near(work.bottom, strip.bottom, "the rails' hairlines meet");
      const label = await textBox(page, ".work-head h2");
      near((await textBox(page, ".strip-toggle")).bottom, label.bottom, "memory and threads share a baseline");
      near((await textBox(page, ".chat-tagline")).bottom, label.bottom, "the tagline and threads share a baseline");
    }
    // memory is a quiet rail toggle, not a raised key, and says when it is open
    const memory = page.getByRole("button", { name: "memory" });
    assert.equal(await memory.evaluate(element => element.classList.contains("key")), false);
    await memory.click();
    assert.equal(await memory.getAttribute("aria-expanded"), "true");
    await page.locator("#chat-memory").waitFor();
    await memory.click();
    assert.equal(await memory.getAttribute("aria-expanded"), "false");

    // no "image" key: a + at the field's start, send at its end, one line
    assert.equal(await page.getByRole("button", { name: "image", exact: true }).count(), 0);
    assert.equal(await page.locator(".composer button", { hasText: /image/ }).count(), 0);
    const attach = page.getByRole("button", { name: "attach images" });
    assert.equal(await attach.locator("svg").count(), 1, "the attach key is the + glyph");
    const field = await box(page, ".composer-field");
    const plus = await box(page, ".attach-key");
    const sendKey = await box(page, ".send-key");
    const text = await box(page, ".composer textarea");
    for (const [what, key] of [["attach", plus], ["send", sendKey]] as const) {
      near(key.height, text.height, `the ${what} key is as tall as a line of the field`);
      near(key.bottom, text.bottom, `the ${what} key sits on the field's line`);
      near(key.width, key.height, `the ${what} key is square`);
      if (viewport.touch) assert.ok(key.height >= 44, `the ${what} key takes a fingertip: ${key.height}`);
    }
    near(plus.left - field.left, field.right - sendKey.right, "the keys are inset alike");
    near(plus.top - field.top, field.bottom - plus.bottom, "the field pads the keys alike above and below");
    assert.ok(plus.right <= text.left && text.right <= sendKey.left, "attach, text, send in that order");

    // a longer draft grows the field; the keys stay on its last line
    const composer = page.locator(".composer textarea");
    await composer.fill("one\ntwo\nthree");
    await composer.dispatchEvent("input");
    const grown = await box(page, ".composer textarea");
    assert.ok(grown.height > text.height + 20, "the field grew");
    near((await box(page, ".attach-key")).bottom, grown.bottom, "the attach key stays on the last line");
    near((await box(page, ".send-key")).bottom, grown.bottom, "the send key stays on the last line");
    await composer.fill("");
    await composer.dispatchEvent("input");
    near((await box(page, ".composer textarea")).height, text.height, "an empty field is one line again");
  }, viewport);
}

await scenario("the + key opens the file picker from the keyboard; picked, pasted and dropped images attach and send", async (page, host) => {
  // Listening before the key press, so the chooser it opens is caught.
  const choosing = page.waitForEvent("filechooser");
  const composer = page.locator(".composer textarea");
  await composer.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "attach images");
  await page.keyboard.press("Enter");
  const chooser = await choosing;
  assert.ok(chooser.isMultiple(), "the picker takes several images");
  await chooser.setFiles({ name: "picked.png", mimeType: "image/png", buffer: PNG });
  await page.locator(".attachment", { hasText: "ready" }).waitFor();

  await composer.focus();
  await composer.evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes.concat(1))], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...PNG]);
  // one upload at a time, so the host's ids follow picked, pasted, dropped
  await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 2 && [...document.querySelectorAll(".attachment-state")].every(state => state.textContent === "ready"));
  await page.locator(".composer").evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes.concat(0))], "dropped.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [...PNG]);
  await page.waitForFunction(() => document.querySelectorAll(".attachment").length === 3 && [...document.querySelectorAll(".attachment-state")].every(state => state.textContent === "ready"));
  await composer.fill("look at these");
  await composer.press("Enter");
  await page.locator(".conversation-message.user", { hasText: "look at these" }).locator(".message-images li").first().waitFor();
  assert.equal(host.prompts.length, 1);
  assert.deepEqual(host.prompts[0]!.images, ["img-1", "img-2", "img-3"], "the picked, pasted and dropped images went");
  assert.deepEqual(host.prompts[0]!.images!.map(id => host.media.get(id)!.body.at(-1)), [PNG.at(-1), 1, 0], "in that order");
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844, touch: true }]) {
  await scenario("a tool's images show in its strip and open larger; prose shows only an image the thread read; a missing one is a retry", async (page, host) => {
    // A wide screenshot, as Claude Code's Read returns one: the host serves it by its reference.
    const shot = await page.screenshot({ type: "png" });
    host.media.set("m7.0.0", { type: "image/png", body: shot });
    host.transcript = { ...host.transcript, events: [...host.transcript.events,
      user("3.0", "look at the screenshots"),
      { type: "tool-call", id: "m6.0", callId: "r1", name: "Read", input: { file_path: "/workspace/.shots/07-thread-received.png" }, final: true },
      { type: "tool-result", id: "m7.0", callId: "r1", name: "Read", output: "", isError: false, final: true, images: [{ id: "m7.0.0", mimeType: "image/png" }] },
      { type: "tool-call", id: "m8.0", callId: "r2", name: "Read", input: { file_path: "/workspace/.shots/12-review-phone.png" }, final: true },
      { type: "tool-result", id: "m9.0", callId: "r2", name: "Read", output: "", isError: false, final: true, images: [{ id: "m9.0.0", mimeType: "image/png" }] },
      agent("m10.0", "the received thread: ![thread received](.shots/07-thread-received.png) and a remote ![pixel](https://tracker.example/p.png)"),
    ] };
    await page.reload();
    const strip = page.locator(".tool-strip", { hasText: "07-thread-received.png" });
    const thumb = strip.locator(".message-images img");
    await thumb.waitFor();
    assert.equal(await strip.evaluate(element => (element as HTMLDetailsElement).open), true, "a strip with an image is open");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".tool-strip .message-images img")].some(image => image.complete && image.naturalWidth > 0));
    assert.equal(await strip.locator("pre").count(), 0, "no [image] text");
    const box = await thumb.boundingBox();
    assert.ok(box && box.width > 40 && box.width <= viewport.width - 16, `the preview is a bounded thumbnail: ${JSON.stringify(box)}`);
    // the missing one is the dashed retry, not a broken image
    const lost = page.locator(".tool-strip", { hasText: "12-review-phone.png" }).locator(".message-images li");
    await page.waitForFunction(() => document.querySelectorAll(".tool-strip .message-images li.missing").length === 1);
    assert.equal(await lost.getByRole("button").getAttribute("aria-label"), "/workspace/.shots/12-review-phone.png unavailable, retry");
    host.media.set("m9.0.0", { type: "image/png", body: PNG });
    await lost.getByRole("button").click();
    await page.waitForFunction(() => document.querySelectorAll(".tool-strip .message-images li.missing").length === 0);

    await strip.getByRole("button", { name: "view /workspace/.shots/07-thread-received.png larger" }).click();
    const viewer = page.locator("dialog.image-viewer");
    await viewer.waitFor();
    assert.equal(await viewer.getAttribute("aria-label"), "/workspace/.shots/07-thread-received.png");
    const large = await viewer.locator("img").boundingBox();
    assert.ok(large && large.width > box!.width && large.width <= viewport.width, `the viewer shows it larger and fits: ${JSON.stringify(large)}`);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });

    // agent prose: the path it read is the image; a remote one stays a link
    const prose = page.locator(".conversation-message.assistant", { hasText: "the received thread" });
    const pictured = prose.locator("button.markdown-image img");
    await pictured.waitFor();
    assert.equal(await pictured.getAttribute("src"), "/api/optchat/media/m7.0.0");
    assert.equal(await prose.locator("img").count(), 1, "only the image the thread read is fetched");
    assert.equal(await prose.locator("a", { hasText: "pixel" }).getAttribute("href"), "https://tracker.example/p.png");
    await prose.getByRole("button", { name: "view thread received larger" }).click();
    await viewer.waitFor();
    await viewer.getByRole("button", { name: "close" }).click();
    await viewer.waitFor({ state: "detached" });
    // a prose image the host no longer has is the dashed retry too
    host.media.delete("m7.0.0");
    await prose.locator("button.markdown-image").evaluate(button => { const image = button.querySelector("img")!; image.src = `${image.src}?gone`; });
    await page.waitForFunction(() => document.querySelector(".markdown-image.missing") !== null);
    assert.equal(await prose.locator("button.markdown-image").getAttribute("aria-label"), "thread received unavailable, retry");
    host.media.set("m7.0.0", { type: "image/png", body: shot });
    await prose.locator("button.markdown-image").click();
    await page.waitForFunction(() => document.querySelector(".markdown-image.missing") === null && (document.querySelector<HTMLImageElement>(".markdown-image img")?.naturalWidth ?? 0) > 0);
    assert.ok(await page.locator(".transcript-column").evaluate(element => element.scrollWidth <= element.clientWidth), "nothing overflows the transcript sideways");
  }, viewport);

  await scenario("the chat's threads show by project with their own state; no inferred wish list", async (page, host) => {
    const thread = (id: string, project: string, title: string, state: string, archived = false) =>
      ({ id: `${id}-0000-4000-8000-000000000000`, title, project: { id: project, name: project }, state, archived, spawned: 1 });
    host.overview = { threads: [thread("aaaaaaa1", "cube", "fix the gateway host check", "working"), thread("bbbbbbb2", "site", "a much longer thread title that has to wrap or clamp in the narrow panel without overflowing it at all", "completed"),
      thread("ccccccc3", "cube", "old work", "stopped", true)], archived: { shown: 1, total: 3 }, unknown: 0 };
    await page.reload();
    await page.locator(".work-thread").first().waitFor();
    assert.deepEqual(await page.locator(".work-group h3").allTextContents(), ["cube", "site"], "grouped by project, newest first");
    assert.deepEqual(await page.locator(".work-state").allTextContents(), ["aaaaaaa1 · working", "ccccccc3 · archived · stopped", "bbbbbbb2 · turn ended"]);
    assert.equal(await page.locator(".work-thread a.work-title").first().getAttribute("href"), "#/t/aaaaaaa1-0000-4000-8000-000000000000");
    assert.equal(await page.locator(".work-thread.archived a").count(), 0, "an archived thread has no thread page to open");
    await page.getByText("2 older archived not shown").waitFor();
    assert.match(await page.locator(".work-summary").textContent() ?? "", /^2 open · 1 running$/);
    const panel = await box(page, ".work-panel");
    assert.ok(await page.locator(".work-body").evaluate(element => element.scrollWidth <= element.clientWidth), "nothing overflows the panel sideways");
    assert.ok(panel.right <= viewport.width + 0.5, "the panel fits the screen");

    // no model-inferred wish list: no section, no request for one
    assert.equal(await page.locator(".work-wishes, .work-wish").count(), 0);
    assert.equal(await page.getByText(/inferred from the chat/).count(), 0);
    assert.deepEqual(host.requests.filter(request => request.includes("/wishes")), []);
  }, viewport);
}

await browser.close();
if (failed) process.exit(1);
console.log("chat browser: ok");
