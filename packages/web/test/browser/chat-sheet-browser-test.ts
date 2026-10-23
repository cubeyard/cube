/** The chat's sheet in a real browser against a scripted host (the data
 * is mocked; the UI is the built one): what the chat started and named
 * stands in a margin beside the message that says so on a wide screen and
 * as quiet lines under it on a narrower one, never twice; opening a note
 * never moves the conversation, nor does streaming; many notes never
 * overlap or lengthen the page; a failed thread scrolled away is pinned
 * with the way back; states are cubed's own, and an unreadable overview or
 * a thread cube no longer has says so; the index opens from its key, `/`
 * and ctrl k, walks by arrow keys and gives focus back. Screenshots go to
 * CUBE_SCREENSHOTS when it is set. Needs a built UI and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { ThreadEvent } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
let failed = false;
type Viewport = { width: number; height: number; touch?: boolean };
const desktop: Viewport = { width: 1440, height: 900 };
const laptop: Viewport = { width: 1280, height: 800 };
const between: Viewport = { width: 1024, height: 768 };
const phone: Viewport = { width: 390, height: 844, touch: true };

async function scenario(name: string, viewport: Viewport, run: (page: Page, host: ScriptedHost) => Promise<void>,
  setup: (host: ScriptedHost) => void = () => {}, options: { reducedMotion?: "reduce" } = {}): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
  host.overview = overview();
  host.threads = threads;
  host.artifacts = artifacts;
  host.bodies = bodies;
  setup(host);
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.touch, hasTouch: !!viewport.touch, reducedMotion: options.reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${host.url}/#/chat`);
    await page.locator(".composer textarea").waitFor();
    if (host.transcript.events.length) await page.locator(".conversation-message").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await run(page, host);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${name} (${viewport.width}x${viewport.height})`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name} (${viewport.width}x${viewport.height})\n`, error);
  } finally {
    await context.close();
    await host.close();
  }
}

type Box = { top: number; bottom: number; left: number; right: number; height: number; width: number };
const boxOf = (page: Page, selector: string, index = 0): Promise<Box> => page.locator(selector).nth(index).evaluate(element => {
  const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
  return { top, bottom, left, right, height, width };
});
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 160)))));
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** Every row's place in the conversation's own coordinates. */
const rowTops = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".transcript-column > [data-anchor]")].map(row => `${row.dataset.anchor}:${row.offsetTop}`));
/** The margin's notes: their boxes in page order, and whether any overlap. */
const notes = (page: Page) => page.evaluate(() => {
  const boxes = [...document.querySelectorAll<HTMLElement>(".margin-notes > .margin-note")].map(note => ({ row: note.dataset.note!, top: note.offsetTop, bottom: note.offsetTop + note.offsetHeight }));
  const overlap = boxes.some((box, index) => index > 0 && box.top < boxes[index - 1]!.bottom);
  return { boxes, overlap };
});
const anchorTop = (page: Page, row: string) => page.locator(`.transcript-column > [data-anchor="${row}"]`).evaluate(element => (element as HTMLElement).offsetTop);
const head = (page: Page, title: RegExp | string) => page.locator(".note-head", { hasText: title });

await scenario("the margin: each note beside the message that started or named it, once", desktop, async page => {
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  const { boxes, overlap } = await notes(page);
  assert.deepEqual(boxes.map(box => box.row), ["call:spawn-old", "call:spawn-1", "4.1", "call:write-1"], "in the conversation's order: spawns, a linked artifact, a written one");
  assert.equal(overlap, false, "no two notes overlap");
  for (const box of boxes) assert.ok(Math.abs(box.top - await anchorTop(page, box.row)) <= 2 || box.top > await anchorTop(page, box.row), `${box.row} at or below its message`);
  assert.ok(Math.abs(boxes[1]!.top - await anchorTop(page, "call:spawn-1")) <= 2, "the spawn's note is level with it");
  assert.equal(await page.locator(`.margin-note[data-note="call:spawn-1"]`).evaluate(element => element.classList.contains("level")), true, "and tied to it by a hairline");
  // in the margin, right of the column
  const column = await boxOf(page, ".transcript-column");
  const margin = await boxOf(page, ".sheet-margin");
  assert.ok(margin.left >= column.right + 16, "the margin stands apart from the column");
  // the states are cubed's own words; a thread cube lost says so; a task that did not start says why
  const spawn = page.locator(`.margin-note[data-note="call:spawn-1"]`);
  assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["working · cube", "turn ended · cube", "machine failed · keel-images", "nope · no project nope"]);
  assert.deepEqual(await spawn.locator(".lamp").evaluateAll(all => all.map(lamp => lamp.className.replace("lamp", "").trim())), ["on-amber blink", "", "on-red", "on-red"], "blinking amber, the unlit lens, steady red");
  assert.equal(await page.locator(`.margin-note[data-note="call:spawn-old"] .note-state`).textContent(), "not known to cube · keel-images");
  // an artifact the chat linked and one it wrote: one note each, never one it did not name
  assert.deepEqual(await page.locator(".margin-note .note-head:has(.note-doc) .note-title").allTextContents(), ["composer room: more space on the phone", "today's review"]);
  // nothing inline on a wide screen: no note twice
  assert.equal(await page.locator(".transcript-column .sheet-note").count(), 0);
  // the chat's own tools in words, the report under its thread's name
  assert.deepEqual(await page.locator(".tool-said").allTextContents(), ["started 1 thread", "started 3 threads · 1 not started", "told composer room: measure the mobile composer and propose more space", "created today's review · revision 1"]);
  assert.equal(await page.locator(".report .report-name").first().textContent(), "find why the artifact browser test is flaky");
  assert.equal(await page.locator(".report a.report-name").first().getAttribute("href"), `#/t/${ID.flaky}`);
  // the margin never makes the page longer than the conversation
  const [scroll, content] = await page.locator(".transcript").evaluate(element => [element.scrollHeight, (element.querySelector(".transcript-page") as HTMLElement).offsetHeight + parseFloat(getComputedStyle(element).paddingTop) + parseFloat(getComputedStyle(element).paddingBottom)]);
  assert.ok(scroll <= content + 1, `no longer than the conversation: ${scroll} against ${content}`);
  await shoot(page, "sheet-desktop-top");
});

for (const viewport of [desktop, laptop, { width: 1216, height: 800 }]) {
  await scenario("the column and the composer share the viewport's centreline; the margin hangs to the right, inside the window", viewport, async page => {
    const centre = viewport.width / 2;
    const column = await boxOf(page, ".transcript-column");
    const field = await boxOf(page, ".composer-field");
    const margin = await boxOf(page, ".sheet-margin");
    assert.ok(Math.abs((column.left + column.right) / 2 - centre) <= 0.5, `the column is centred: ${column.left}–${column.right} on ${viewport.width}`);
    assert.ok(Math.abs(field.left - column.left) <= 0.5 && Math.abs(field.right - column.right) <= 0.5, `the composer keeps the column's line: ${field.left}–${field.right}`);
    assert.ok(margin.left >= column.right + 16, `the margin hangs outward to the right: ${margin.left} after ${column.right}`);
    assert.ok(margin.right <= viewport.width - 8 && margin.width >= 180, `the margin fits the window: ${margin.left}–${margin.right}, ${margin.width} wide`);
    assert.ok((await boxOf(page, ".work-key")).right <= field.left, "the work key hangs before the field");
    for (const note of await page.locator(".margin-note.placed").all()) {
      const box = await note.evaluate(element => element.getBoundingClientRect().right);
      assert.ok(box <= margin.right + 0.5, "every note within the margin");
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "nothing sideways");
    assert.ok(await page.locator(".transcript").evaluate(element => element.scrollWidth <= element.clientWidth), "the transcript does not scroll sideways");
    await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
    await settle(page);
    await shoot(page, `sheet-centre-${viewport.width}`);
  });
}

await scenario("opening a note keeps the conversation still; it opens in place, escape folds it back", desktop, async page => {
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  const before = await rowTops(page);
  const scroll = await page.locator(".transcript").evaluate(element => element.scrollTop);
  const spawnTop = (await notes(page)).boxes[1]!.top;
  const composer = head(page, "composer room: measure");
  await composer.click();
  await page.locator(".note-peek").waitFor();
  await settle(page);
  assert.equal(await composer.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await rowTops(page), before, "no message moved");
  assert.equal(await page.locator(".transcript").evaluate(element => element.scrollTop), scroll, "the view did not scroll");
  const after = await notes(page);
  assert.equal(after.overlap, false, "the notes after it made room");
  assert.equal(after.boxes[1]!.top, spawnTop, "the opened note stays by its message");
  const peek = page.locator(".note-peek");
  assert.equal(await peek.locator("a", { hasText: "open thread" }).getAttribute("href"), `#/t/${ID.composer}`, "the full view is a link away");
  assert.match(await peek.textContent() ?? "", /212px left/, "its newest report, from the chat");
  await shoot(page, "sheet-desktop-open");
  // its report in the chat: shown and focused
  await peek.getByRole("button", { name: "its report in the chat" }).click();
  await page.waitForFunction(() => document.activeElement?.classList.contains("report"));
  await composer.focus();
  await page.keyboard.press("Escape");
  await page.locator(".note-peek").waitFor({ state: "detached" });
  assert.ok(await composer.evaluate(element => element === document.activeElement), "focus back on the note's head");
  // an artifact opens with its opening words, read on demand, and the way to read it
  await head(page, "today's review").click();
  await page.locator(".note-peek .note-report", { hasText: "Two threads reported" }).waitFor();
  assert.equal(await page.locator(".note-peek a", { hasText: "read" }).getAttribute("href"), `#/a/${ID.review}`);
});

await scenario("streaming and a growing margin never move what the reader looks at", laptop, async (page, host) => {
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  await head(page, "composer room: measure").click();
  const before = await rowTops(page);
  const scroll = await page.locator(".transcript").evaluate(element => element.scrollTop);
  const events = host.transcript.events;
  for (const text of ["Reading", "Reading the thread's", "Reading the thread's report again, it says the composer room has 212px."]) {
    host.set([...events, { type: "user-message", id: "9.0", text: "and now?" }, { type: "assistant-text", id: "live.1", text, reasoning: false, final: false }], { state: "working" });
    // states change meanwhile: a longer state line grows a note
    host.overview = overview({ composer: "waiting for a runner", flaky: "working" });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(page);
  }
  await page.locator(".note-state", { hasText: "waiting for a runner" }).waitFor();
  const after = await rowTops(page);
  assert.deepEqual(after.slice(0, before.length), before, "earlier messages stay where they were");
  assert.equal(await page.locator(".transcript").evaluate(element => element.scrollTop), scroll, "the reader's place stays");
  assert.equal((await notes(page)).overlap, false);
  // the work key counts what moves and what failed, in cubed's words
  assert.match(await page.locator(".work-key").getAttribute("aria-label") ?? "", /2 running · 1 failed$/);
});

await scenario("many threads from one message: four shown, the rest a press away, never overlapping", desktop, async page => {
  await page.locator(".note-more").waitFor();
  assert.equal(await page.locator(".margin-note[data-note='call:spawn-many'] .note-item").count(), 4, "four, and the rest a press away");
  assert.equal(await page.locator(".note-more").textContent(), "6 more");
  await page.locator(".note-more").click();
  assert.equal(await page.locator(".margin-note[data-note='call:spawn-many'] .note-item").count(), 10);
  await settle(page);
  assert.equal((await notes(page)).overlap, false, "the notes made room");
  // near the end they move up rather than lengthen the page; a note moved off its message draws no tie to it
  for (const box of (await notes(page)).boxes) {
    const tied = await page.locator(`.margin-note[data-note="${box.row}"]`).evaluate(element => element.classList.contains("level"));
    assert.equal(tied, Math.abs(box.top - await anchorTop(page, box.row)) < 3, `${box.row}: tied only when level`);
  }
  const [scroll, content] = await page.locator(".transcript").evaluate(element => [element.scrollHeight, (element.querySelector(".transcript-page") as HTMLElement).offsetHeight + parseFloat(getComputedStyle(element).paddingTop) + parseFloat(getComputedStyle(element).paddingBottom)]);
  assert.ok(scroll <= content + 1, "still no longer than the conversation");
  await shoot(page, "sheet-desktop-many");
}, host => {
  const many = Array.from({ length: 9 }, (_, index) => `${(index + 1).toString(16).repeat(8)}`);
  host.transcript = { ...host.transcript, events: [...chatEvents(),
    { type: "user-message", id: "10.0", text: "start nine more" },
    { type: "tool-call", id: "10.1", callId: "spawn-many", name: "spawn", input: { tasks: [] }, final: true },
    { type: "tool-result", id: "10.2", callId: "spawn-many", name: "spawn", output: [...many.map(short => `[${short}] started in cube: task ${short}`), "task 10 (cube) not started: no free slot"].join("\n"), isError: false, final: true },
    { type: "assistant-text", id: "10.3", text: "Nine started; one waits for a slot.", reasoning: false, final: true },
  ] };
});

await scenario("a failed thread scrolled away is pinned at the margin's top, with the way back", laptop, async page => {
  await page.locator(".transcript").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settle(page);
  const pin = page.locator(".margin-pin", { hasText: "java trusts runner ca" });
  await pin.waitFor();
  assert.match(await pin.textContent() ?? "", /machine failed/);
  assert.equal(await page.locator(".margin-pin").count(), 1, "only a failure is pinned, nothing else claims attention");
  await shoot(page, "sheet-laptop-pinned");
  await pin.click();
  await page.waitForFunction(() => document.activeElement?.closest(".margin-note")?.getAttribute("data-note") === "call:spawn-1");
  await page.locator(".margin-pin").waitFor({ state: "detached" });
}, host => { host.transcript = { ...host.transcript, events: [...chatEvents().slice(0, 9), ...chatEvents({ filler: 12 }).slice(4, 4 + 24), ...chatEvents().slice(9)] }; });

for (const viewport of [between, phone]) {
  await scenario("narrower: the notes are quiet lines under their message, threads only, never twice", viewport, async page => {
    assert.equal(await page.locator(".sheet-margin").count(), 0, "no margin");
    const inline = page.locator(".transcript-column .sheet-note");
    assert.equal(await inline.count(), 2, "under the two spawns");
    assert.equal(await page.locator(".transcript-column .sheet-note .note-doc").count(), 0, "artifacts stay links in the text");
    const spawn = page.locator(".transcript-column [data-anchor='call:spawn-1'] + .sheet-note");
    assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["working", "turn ended", "machine failed", "nope · no project nope"]);
    // each state is whole on its line: the title gives way first
    for (const state of await spawn.locator(".note-head:not(.static) .note-state").all()) assert.ok(await state.evaluate(element => element.scrollWidth <= element.clientWidth), "the state is not cut");
    assert.ok(await page.locator(".transcript-column").evaluate(element => element.scrollWidth <= element.clientWidth), "nothing overflows sideways");
    await spawn.locator(".note-head", { hasText: "composer room" }).click();
    await spawn.locator(".note-peek a", { hasText: "open thread" }).waitFor();
    assert.match(await spawn.locator(".note-facts").textContent() ?? "", /cube/, "the project, in the opened note");
    if (viewport.touch) assert.ok((await boxOf(page, ".transcript-column .note-head")).height >= 43.9, "a fingertip's height");
    await spawn.locator(".note-head", { hasText: "composer room" }).scrollIntoViewIfNeeded();
    await shoot(page, `sheet-${viewport.width}-inline`);
  });
}

await scenario("the index: its key, / and ctrl k open it; arrows walk it; escape gives focus back; / in the composer is just text", desktop, async page => {
  const key = page.locator(".work-key");
  assert.equal(await key.getAttribute("aria-label"), "index: threads, artifacts and settings · 1 running · 1 failed");
  await key.focus();
  await page.keyboard.press("Enter");
  const index = page.locator(".chat-index");
  await index.locator("input[type=search]").waitFor();
  assert.ok(await index.locator("input[type=search]").evaluate(element => element === document.activeElement), "focus in the filter");
  assert.deepEqual(await index.locator(".index-row[href^='#/t/'] .index-meta").allTextContents(), ["machine failed · keel-images", "working · cube", "turn ended · cube"], "failed, then moving, then the rest");
  await settle(page);
  await shoot(page, "sheet-desktop-index");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), `#/t/${ID.ca}`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON", "up from the filter wraps to the end (memory)");
  await page.keyboard.press("Escape");
  await index.waitFor({ state: "hidden" });
  assert.ok(await key.evaluate(element => element === document.activeElement), "focus back on the key");
  // `/` outside a field
  await page.locator(".transcript").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await index.waitFor();
  // the filter narrows; enter opens the first match
  await page.keyboard.type("flaky");
  assert.deepEqual(await index.locator(".index-row .index-title").allTextContents(), ["find why the artifact browser test is flaky"]);
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`#/t/${ID.flaky}$`));
  await page.goBack();
  await page.locator(".composer textarea").waitFor();
  // in the composer `/` is a character; ctrl k still opens the index
  await page.locator(".composer textarea").focus();
  await page.keyboard.type("a/b");
  assert.equal(await page.locator(".composer textarea").inputValue(), "a/b");
  assert.equal(await index.isVisible(), false);
  await page.keyboard.press("Control+k");
  await index.waitFor();
  await page.keyboard.press("Escape");
  assert.ok(await page.locator(".composer textarea").evaluate(element => element === document.activeElement), "focus back in the composer");
  assert.equal(await page.locator(".composer textarea").inputValue(), "a/b", "the draft stays");
  // the places are all there
  await page.locator(".sheet-bar .name-key").click();
  assert.deepEqual(await index.locator(".index-places a").evaluateAll(all => all.map(link => link.getAttribute("href"))), ["#/threads", "#/artifacts", "#/projects", "#/settings/providers"]);
});

await scenario("an overview that cannot be read is said, never guessed; the last good one stays", desktop, async (page, host) => {
  const spawn = page.locator(`.margin-note[data-note="call:spawn-1"]`);
  assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["state not read · cube", "state not read · cube", "state not read · keel-images", "nope · no project nope"]);
  assert.deepEqual(await spawn.locator(".lamp").evaluateAll(all => all.slice(0, 3).map(lamp => lamp.className.trim())), ["lamp", "lamp", "lamp"], "no lamp is lit for a state not read");
  await page.locator(".work-key").click();
  await page.locator(".chat-index .index-error", { hasText: "threads could not be read" }).waitFor();
  host.overviewError = null;
  await page.locator(".chat-index .index-error button").click();
  await page.locator(".chat-index .index-row .index-meta", { hasText: "working · cube" }).waitFor();
  await page.keyboard.press("Escape");
  await spawn.locator(".note-state", { hasText: "working · cube" }).waitFor();
  host.overviewError = "the host had a problem";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(400);
  assert.equal(await spawn.locator(".note-state").first().textContent(), "working · cube", "the last good state stays");
}, host => { host.overviewError = "the host had a problem"; });

await scenario("an empty chat: an empty margin, the key says only where it goes", desktop, async page => {
  await page.locator(".conversation-empty", { hasText: "one chat, every thread" }).waitFor();
  assert.ok(await page.locator(".sheet-margin").isVisible(), "the margin's room is kept, so the column never jumps");
  assert.equal(await page.locator(".margin-note").count(), 0);
  assert.equal(await page.locator(".work-key").getAttribute("aria-label"), "index: threads, artifacts and settings");
  await page.locator(".work-key").click();
  await page.locator(".chat-index .index-quiet", { hasText: "no open threads" }).waitFor();
  await page.locator(".chat-index .index-quiet", { hasText: "no artifacts yet" }).waitFor();
  await shoot(page, "sheet-desktop-empty");
}, host => {
  host.transcript = { ...host.transcript, events: [] as ThreadEvent[], status: { state: "idle", run: null, error: null } };
  host.overview = { threads: [], archived: { shown: 0, total: 0 }, unknown: 0 };
  host.threads = [];
  host.artifacts = [];
});

await scenario("reduced motion: notes and the index open without movement", desktop, async page => {
  await head(page, "composer room: measure").click();
  const motion = await page.evaluate(() => [".note-peek", ".margin-note"].map(selector => {
    const style = getComputedStyle(document.querySelector(selector)!);
    return `${style.animationName}|${style.transitionDuration}`;
  }));
  assert.deepEqual(motion, ["none|0s", "none|0s"]);
  await page.locator(".work-key").click();
  assert.equal(await page.locator(".chat-index").evaluate(element => getComputedStyle(element).animationName), "none");
}, () => {}, { reducedMotion: "reduce" });

await browser.close();
if (failed) process.exit(1);
console.log("chat sheet browser: ok");
