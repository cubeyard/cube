/** The chat's sheet in a real browser against a scripted host (the data
 * is mocked; the UI is the built one): what the chat started and named
 * stands in a margin beside the message that says so on a wide screen and
 * as quiet lines under it on a narrower one, never twice; opening a note
 * never moves the conversation, nor does streaming; many notes never
 * overlap or lengthen the page; a failed thread scrolled away is pinned
 * with the way back; states are cubed's own, and an unreadable overview or
 * a thread cube no longer has says so; a tell the thread took brings it
 * back beside the tell (once), a refused or failed one does not; the index opens from its key, `/`
 * and ctrl k, walks by arrow keys and gives focus back, and with many
 * threads it is on a desktop as it was, its places a scroll or a key away. Screenshots go to
 * CUBE_SCREENSHOTS when it is set. Needs a built UI and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import fsSync from "node:fs";
import { chromium, webkit, type Browser, type Page } from "playwright";
import type { ThreadEvent } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { gate, ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
// Safari's engine, for the touch scenarios, when Playwright has it (CI does)
const safari: Browser | null = fsSync.existsSync(webkit.executablePath()) ? await webkit.launch() : null;
if (!safari) console.log("SKIP: webkit touch scenarios (install it: pnpm --filter @cube/web exec playwright install webkit)");
let failed = false;
type Viewport = { width: number; height: number; touch?: boolean };
const desktop: Viewport = { width: 1440, height: 900 };
const laptop: Viewport = { width: 1280, height: 800 };
const between: Viewport = { width: 1024, height: 768 };
const phone: Viewport = { width: 390, height: 844, touch: true };

async function scenario(name: string, viewport: Viewport, run: (page: Page, host: ScriptedHost) => Promise<void>,
  setup: (host: ScriptedHost) => void = () => {}, options: { reducedMotion?: "reduce"; engine?: Browser } = {}): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
  host.overview = overview();
  host.threads = threads;
  host.artifacts = artifacts;
  host.bodies = bodies;
  setup(host);
  const engine = options.engine ?? browser;
  // WebKit on Linux has no mobile emulation; it still has touch.
  const context = await engine.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: !!viewport.touch && engine === browser, hasTouch: !!viewport.touch, reducedMotion: options.reducedMotion ?? "no-preference" });
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
    console.log(`ok - ${engine === browser ? "" : "webkit "}${name} (${viewport.width}x${viewport.height})`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${engine === browser ? "" : "webkit "}${name} (${viewport.width}x${viewport.height})\n`, error);
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
  assert.deepEqual(boxes.map(box => box.row), ["call:spawn-old", "call:spawn-1", "4.1", "call:tell-1", "call:write-1"], "in the conversation's order: spawns, a linked artifact, the thread told last, a written one");
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
  assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["turn ended · cube", "machine failed · keel-images", "nope · no project nope"]);
  assert.deepEqual(await spawn.locator(".note-state").evaluateAll(all => all.map(state => state.classList.contains("failure"))), [false, true, true], "failures in error ink, the rest quiet");
  // the thread the chat told came back beside the tell, once: not at its spawn too
  const told = page.locator(`.margin-note[data-note="call:tell-1"]`);
  assert.deepEqual(await told.locator(".note-title").allTextContents(), ["composer room: measure the mobile composer and propose more space"]);
  assert.deepEqual(await told.locator(".note-state").allTextContents(), ["working · cube"]);
  assert.equal(await page.locator(".margin-note .note-head", { hasText: "composer room: measure" }).count(), 1, "one note for the thread");
  assert.equal(await page.locator(".lamp, .blink").count(), 0, "no lamp, glow or blink anywhere: states are words");
  assert.ok(await page.evaluate(() => [...document.querySelectorAll("*")].every(element => getComputedStyle(element).animationIterationCount !== "infinite")), "nothing pulses");
  assert.equal(await page.locator(`.margin-note[data-note="call:spawn-old"] .note-state`).textContent(), "not known to cube · keel-images");
  // an artifact the chat linked and one it wrote: one note each, never one it did not name
  assert.deepEqual(await page.locator(".margin-note .note-head.artifact .note-title").allTextContents(), ["composer room: more space on the phone", "today's review"]);
  // an artifact keeps its file mark (a kind, not a state); a thread note has none
  assert.equal(await page.locator(".margin-note .note-head.artifact .note-doc svg").count(), 2, "each artifact note carries the file mark");
  assert.equal(await page.locator(".margin-note .note-head:not(.artifact) .note-doc").count(), 0);
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
    assert.equal(await page.locator(".composer-row > *").count(), 1, "nothing beside the field");
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

// the field stands a breath off the window's bottom edge, a little more on a taller window
const lifts: number[] = [];
for (const viewport of [{ width: 1280, height: 720 }, desktop, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
  await scenario("the composer stands off the window's bottom edge", viewport, async page => {
    const lift = viewport.height - (await boxOf(page, ".composer-field")).bottom;
    assert.ok(lift >= 16 && lift <= 30, `a modest breath under the field: ${lift}`);
    assert.ok(lift >= (lifts.at(-1) ?? 0), `no less on a taller window: ${lift} after ${lifts.at(-1)}`);
    lifts.push(lift);
    await shoot(page, `sheet-lift-${viewport.width}x${viewport.height}`);
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
  // its report in the chat: shown, opened and focused (its folded line's summary)
  await peek.getByRole("button", { name: "its report in the chat" }).click();
  await page.waitForFunction(() => { const report = document.activeElement?.closest("details.report"); return !!report && (report as HTMLDetailsElement).open && document.activeElement?.tagName === "SUMMARY"; });
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
  // what moves and what failed is said in the notes, not counted beside the composer
  assert.equal(await page.locator(".composer").getByText(/running|failed/).count(), 0);
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

for (const [viewport, engine] of [[between, browser], [phone, browser], ...safari ? [[phone, safari] as const] : []] as const) {
  await scenario("narrower: the notes are quiet lines under their message, threads only, never twice", viewport, async page => {
    assert.equal(await page.locator(".sheet-margin").count(), 0, "no margin");
    // a thread works and one failed, and still nothing stands beside the composer
    assert.equal(await page.locator(".composer-row > *").count(), 1, "nothing beside the field");
    assert.equal(await page.locator(".composer").getByText(/running|failed/).count(), 0, "no count beside the composer");
    const inline = page.locator(".transcript-column .sheet-note");
    assert.equal(await inline.count(), 3, "under the two spawns and the tell");
    assert.equal(await inline.locator(".note-head", { hasText: "composer room: measure" }).count(), 1, "the told thread once, under its tell");
    assert.equal(await page.locator(".transcript-column .sheet-note .note-head.artifact").count(), 0, "artifacts stay links in the text");
    const spawn = page.locator(".transcript-column [data-anchor='call:spawn-1'] + .sheet-note");
    assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["turn ended", "machine failed", "nope · no project nope"]);
    const told = page.locator(".transcript-column [data-anchor='call:tell-1'] + .sheet-note");
    assert.deepEqual(await told.locator(".note-state").allTextContents(), ["working"]);
    // each state is whole on its line: the title gives way first
    for (const state of await spawn.locator(".note-head:not(.static) .note-state").all()) assert.ok(await state.evaluate(element => element.scrollWidth <= element.clientWidth), "the state is not cut");
    assert.ok(await page.locator(".transcript-column").evaluate(element => element.scrollWidth <= element.clientWidth), "nothing overflows sideways");
    await told.locator(".note-head", { hasText: "composer room" }).click();
    await told.locator(".note-peek a", { hasText: "open thread" }).waitFor();
    assert.match(await told.locator(".note-facts").textContent() ?? "", /cube/, "the project, in the opened note");
    if (viewport.touch) assert.ok((await boxOf(page, ".transcript-column .note-head")).height >= 43.9, "a fingertip's height");
    await told.locator(".note-head", { hasText: "composer room" }).scrollIntoViewIfNeeded();
    await shoot(page, `sheet-${viewport.width}-inline`);
  }, () => {}, { engine });
}

// A tell brings its thread back beside it: the thread's spawn is far above,
// scrolled away, and the tells arrive live. Only a tell the thread took
// (sent, or queued into its running turn) moves it; a refused or failed one
// and one still running do not. Never two notes for one thread.
for (const viewport of [desktop, phone]) {
  await scenario("a tell the thread took brings it back beside the tell, once; a refused or failed one does not", viewport, async (page, host) => {
    const wide = viewport.width >= 1216;
    const flaky = ID.flaky.slice(0, 8), ca = ID.ca.slice(0, 8);
    // inline, a note follows its row, or the folded run of calls the row is in (tool-groups-browser-test)
    const noteAt = (row: string) => page.locator(wide ? `.margin-notes > [data-note="${row}"]` : `.transcript-column .sheet-note.inline[data-note="${row}"]`);
    const flakyNotes = () => page.locator(wide ? ".margin-note .note-head" : ".transcript-column .sheet-note .note-head", { hasText: "find why the artifact browser test is flaky" });
    const toEnd = async () => { await page.locator(".transcript").evaluate(element => { element.scrollTop = element.scrollHeight; }); await settle(page); };
    const inView = (row: string) => noteAt(row).evaluate(element => {
      const box = element.getBoundingClientRect(), view = element.closest(".transcript")!.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    });
    const tell = (id: string, short: string, output: string | null, isError = false): ThreadEvent[] => [
      { type: "tool-call", id: `${id}.c`, callId: id, name: "tell", input: { id: short, message: "keep going" }, final: true },
      ...output === null ? [] : [{ type: "tool-result", id: `${id}.r`, callId: id, name: "tell", output, isError, final: true } as ThreadEvent],
    ];
    const base = host.transcript.events;
    await toEnd();
    assert.equal(await flakyNotes().count(), 1, "one note for the thread, at its spawn far above");
    assert.equal(await noteAt("call:spawn-1").locator(".note-head", { hasText: "find why the artifact browser test is flaky" }).count(), 1);

    // a tell still running moves nothing yet
    let events = [...base, { type: "user-message", id: "t.0", text: "tell the flaky one to keep going" } as ThreadEvent, ...tell("tell-q", flaky, null)];
    host.set(events, { state: "working" });
    await page.locator(".transcript-column [data-anchor='call:tell-q']").waitFor();
    await settle(page);
    assert.equal(await noteAt("call:tell-q").count(), 0, "no note while the tell runs");

    // queued into the working thread's turn: it comes back beside the tell, in view, and leaves the spawn's note
    events = [...base, events.at(-2)!, ...tell("tell-q", flaky, `queued for [${flaky}], which is working: it has not read it yet, and reads it after its current tool call, in this turn; its report comes back as a message starting "[${flaky}] "`)];
    host.set(events, { state: "working" });
    await noteAt("call:tell-q").waitFor();
    await toEnd();
    assert.ok(await inView("call:tell-q"), "the note is beside the tell, in view");
    assert.equal(await flakyNotes().count(), 1, "still one note for the thread");
    assert.equal(await noteAt("call:spawn-1").locator(".note-head", { hasText: "find why the artifact browser test is flaky" }).count(), 0, "it left the spawn's note");
    assert.match(await noteAt("call:tell-q").textContent() ?? "", /turn ended/, "with cubed's state for it");
    if (wide) assert.equal(await noteAt("call:tell-q").evaluate(element => element.classList.contains("level")), true, "level with its tell, tied by a hairline");

    // refused, and an error: the java thread stays at its spawn, nothing beside either tell
    events = [...events,
      ...tell("tell-no", ca, `not sent: [${ca}] had 3 tells from you since the user's last message; tell the user what it needs instead`),
      ...tell("tell-err", ca, `[${ca}] is archived`, true)];
    host.set(events, { state: "working" });
    // the three tells are one folded run of calls now: the row is there, folded
    await page.locator(".transcript-column [data-anchor='call:tell-err']").waitFor({ state: "attached" });
    await settle(page);
    assert.equal(await noteAt("call:tell-no").count() + await noteAt("call:tell-err").count(), 0, "a refused or failed tell brings nothing back");
    assert.equal(await noteAt("call:spawn-1").locator(".note-head", { hasText: "java trusts runner ca" }).count(), 1, "the java thread stays at its spawn");

    // told again: it moves to the newest tell, never two
    events = [...events, ...tell("tell-again", flaky, `sent to [${flaky}]; its report comes back as a message starting "[${flaky}] "`)];
    host.set(events, { state: "completed" });
    await noteAt("call:tell-again").waitFor();
    await toEnd();
    assert.equal(await noteAt("call:tell-q").count(), 0, "not at the older tell");
    assert.equal(await flakyNotes().count(), 1, "one note for the thread");
    assert.ok(await inView("call:tell-again"), "beside the newest tell, in view");
    await shoot(page, `sheet-${viewport.width}-told-again`);
  }, host => { host.transcript = { ...host.transcript, events: chatEvents({ filler: 12 }) }; });
}

await scenario("the index: the wordmark, / and ctrl k open it; arrows walk it; escape gives focus back; / in the composer is just text", desktop, async page => {
  const key = page.locator(".sheet-bar .name-key");
  assert.equal(await key.getAttribute("aria-label"), "cube · index: threads, artifacts and settings · press /");
  await key.focus();
  await page.keyboard.press("Enter");
  const index = page.locator(".chat-index");
  await index.locator("input[type=search]").waitFor();
  assert.ok(await index.locator("input[type=search]").evaluate(element => element === document.activeElement), "focus in the filter");
  assert.deepEqual(await index.locator(".index-row[href^='#/t/'] .index-meta").allTextContents(), ["machine failed · keel-images", "working · cube", "turn ended · cube"], "failed, then moving, then the rest");
  assert.equal(await index.locator(".index-row[href^='#/a/'] .index-doc svg").count(), 2, "artifact rows carry the file mark");
  assert.equal(await index.locator(".index-row[href^='#/t/'] .index-doc").count(), 0, "thread rows carry no mark");
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

{
  const list = gate();
  const seen = gate();
  await scenario("before cube has answered, no note claims a thread is lost; once it has, the lost one says so", desktop, async page => {
    const states = () => page.locator(".margin-note .note-head:not(.artifact) .note-state").allTextContents();
    await page.locator(".margin-note").first().waitFor();
    await settle(page);
    const early = await states();
    assert.deepEqual(early, ["reading state… · keel-images", "reading state… · cube", "reading state… · keel-images", "nope · no project nope", "reading state… · cube"], "reading, never lost");
    assert.equal(await page.locator(".note-state", { hasText: "not known to cube" }).count(), 0);
    assert.equal(await page.locator(".margin-note .note-state.failure").count(), 1, "only the task that did not start, before a state is read");
    await shoot(page, "sheet-desktop-reading");
    // the thread list alone cannot say a thread is lost (the overview counts those)
    list.open();
    await page.waitForTimeout(3500);
    assert.equal(await page.locator(".note-state", { hasText: "not known to cube" }).count(), 0, "the list alone claims nothing lost");
    seen.open();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator(".note-state", { hasText: "not known to cube" }).waitFor();
    assert.deepEqual(await states(), ["not known to cube · keel-images", "turn ended · cube", "machine failed · keel-images", "nope · no project nope", "working · cube"]);
  }, host => { host.onThreadList = () => list.promise; host.onOverview = () => seen.promise; });
}

await scenario("an overview that cannot be read: a thread not in the list is not called lost either", laptop, async page => {
  await page.locator(".margin-note").first().waitFor();
  await page.waitForTimeout(3500);
  await settle(page);
  assert.equal(await page.locator(".margin-note[data-note='call:spawn-old'] .note-state").textContent(), "state not read · keel-images");
  await page.locator(".margin-note[data-note='call:spawn-old'] .note-head").click();
  await page.locator(".note-peek .failure", { hasText: "its state could not be read" }).waitFor();
}, host => { host.overviewError = "the host had a problem"; });

await scenario("a failed thread's note in view on the first load is not pinned", desktop, async page => {
  await page.locator(".margin-note.placed").first().waitFor();
  for (let frame = 0; frame < 4; frame++) await settle(page);
  const view = await boxOf(page, ".transcript");
  const note = await boxOf(page, ".margin-note[data-note='call:spawn-1']");
  assert.ok(note.top >= view.top && note.bottom <= view.bottom, `the note is in view: ${note.top}–${note.bottom}`);
  assert.equal(await page.locator(".margin-pin").count(), 0, "so no pin, no scroll needed to clear it");
});

await scenario("a keyboard or screen reader reaches a message's note from the message, and back", desktop, async page => {
  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  const skip = page.locator(".note-skip").nth(1);
  assert.equal(await skip.textContent(), "3 threads from this message, in the margin");
  const before = await rowTops(page);
  await page.locator(".transcript-column > [data-anchor='call:spawn-1'] summary").focus();
  await page.keyboard.press("Tab");
  assert.ok(await skip.evaluate(element => element === document.activeElement), "the skip key is next after the message");
  assert.ok((await boxOf(page, ".note-skip:focus")).width > 40, "seen while focused");
  assert.deepEqual(await rowTops(page), before, "and takes no room");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".margin-note")?.getAttribute("data-note")), "call:spawn-1", "focus in its note");
  await page.keyboard.press("Enter");
  await page.locator(".note-peek button", { hasText: "the message that started it" }).click();
  await page.waitForFunction(() => document.activeElement?.closest("[data-anchor]")?.getAttribute("data-anchor") === "call:spawn-1");
});

await scenario("an overview that cannot be read is said, never guessed; the last good one stays", desktop, async (page, host) => {
  const spawn = page.locator(`.margin-note[data-note="call:spawn-1"]`);
  const told = page.locator(`.margin-note[data-note="call:tell-1"]`);
  assert.deepEqual(await spawn.locator(".note-state").allTextContents(), ["state not read · cube", "state not read · keel-images", "nope · no project nope"]);
  assert.deepEqual(await told.locator(".note-state").allTextContents(), ["state not read · cube"]);
  assert.equal(await spawn.locator(".note-state.failure").count(), 1, "no state is shown as failed when it was not read");
  await page.locator(".sheet-bar .name-key").click();
  await page.locator(".chat-index .index-error", { hasText: "threads could not be read" }).waitFor();
  host.overviewError = null;
  await page.locator(".chat-index .index-error button").click();
  await page.locator(".chat-index .index-row .index-meta", { hasText: "working · cube" }).waitFor();
  await page.keyboard.press("Escape");
  await told.locator(".note-state", { hasText: "working · cube" }).waitFor();
  host.overviewError = "the host had a problem";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(400);
  assert.equal(await told.locator(".note-state").first().textContent(), "working · cube", "the last good state stays");
}, host => { host.overviewError = "the host had a problem"; });

for (const engine of [browser, ...safari ? [safari] : []]) await scenario("a tap opens the index without the keyboard: the sheet takes focus, its close key is in reach, focus goes back", phone, async page => {
  await page.locator(".sheet-bar .name-key").tap();
  const index = page.locator(".chat-index");
  await index.locator(".index-row").first().waitFor();
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement?.className), "chat-index", "the sheet has focus, not the filter");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "DIALOG");
  const close = index.getByRole("button", { name: "close index" });
  const key = await boxOf(page, ".index-close");
  assert.ok(key.top >= 0 && key.bottom <= phone.height, "the close key is on screen");
  const hits = await page.locator(".index-close").evaluate(element => {
    const { left, top, width, height } = element.getBoundingClientRect();
    const [x, y] = [left + width / 2, top + height / 2];
    return [[-21, 0], [21, 0], [0, -21], [0, 21]].filter(([dx, dy]) => { const hit = document.elementFromPoint(x + dx!, y + dy!); return !(hit === element || element.contains(hit)); }).length;
  });
  assert.equal(hits, 0, "a fingertip's 44px around it");
  await shoot(page, "sheet-390-index-tap");
  // the filter is a tap away, and only then is it typing
  await index.locator("input[type=search]").tap();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT");
  await close.tap();
  await index.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("name-key"));
}, () => {}, { engine });

await scenario("a mouse or a key opens the index with the filter ready to type, its focus seen", desktop, async page => {
  await page.locator(".sheet-bar .name-key").click();
  const input = page.locator(".chat-index input[type=search]");
  await page.waitForFunction(() => document.activeElement?.matches(".chat-index input"));
  assert.notEqual(await page.locator(".index-filter").evaluate(element => getComputedStyle(element).boxShadow), "none", "the focused filter shows its rule");
  const floating = await boxOf(page, ".chat-index");
  assert.ok(floating.width <= 576.5 && floating.top > 100 && floating.bottom < desktop.height - 40, `on a desktop the index still rises over the composer, not over the screen: ${JSON.stringify(floating)}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches(".chat-index input"));
});

for (const viewport of [desktop, between]) await scenario("with many threads the desktop index is as it was: it floats, its places follow the lists, the keys reach them", viewport, async page => {
  await page.locator(".sheet-bar .name-key").click();
  const index = page.locator(".chat-index");
  await index.locator(".index-row[href^='#/t/']").nth(42).waitFor();
  await settle(page);
  const floating = await boxOf(page, ".chat-index");
  assert.ok(floating.width <= 576.5 && floating.top > 0 && floating.bottom < viewport.height - 40, `still a floating index over the composer: ${JSON.stringify(floating)}`);
  assert.equal(await index.locator(".index-foot").evaluate(element => getComputedStyle(element).position), "static", "no sticky foot on a desktop: the lists keep the whole height");
  const body = await boxOf(page, ".index-body");
  assert.ok((await boxOf(page, ".index-places")).top > body.bottom, "the places come after the lists, as before");
  assert.deepEqual(await index.locator(".index-places a").evaluateAll(all => all.map(link => link.getAttribute("href"))), ["#/threads", "#/artifacts", "#/projects", "#/settings/providers"]);
  // the keys walk the index as before: down from the filter to the first thread, up wraps to memory
  await index.locator("input[type=search]").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), `#/t/${ID.ca}`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "index-memory");
  // shift tab from memory reaches the model, then the last place, scrolled into view with its focus seen
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "#/settings/providers");
  const settings = await boxOf(page, ".index-places a:focus");
  assert.ok(settings.top >= body.top && settings.bottom <= body.bottom, `the focused place is in view: ${settings.top}–${settings.bottom}`);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement!).backgroundColor), "rgba(0, 0, 0, 0)", "the focused place is washed");
  await shoot(page, `sheet-${viewport.width}-index-many`);
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/settings\/providers$/);
  await index.waitFor({ state: "hidden" });
}, host => {
  const base = overview();
  host.overview = { ...base, threads: [...base.threads, ...Array.from({ length: 40 }, (_, n) => ({ ...base.threads[1]!, id: `${(n + 16).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, title: `synthetic thread ${n + 1}` }))] };
});

await scenario("an empty chat: an empty margin, nothing beside the composer", desktop, async page => {
  await page.locator(".conversation-empty", { hasText: "one chat, every thread" }).waitFor();
  assert.ok(await page.locator(".sheet-margin").isVisible(), "the margin's room is kept, so the column never jumps");
  assert.equal(await page.locator(".margin-note").count(), 0);
  assert.equal(await page.locator(".composer-row > *").count(), 1, "nothing beside the field");
  await page.locator(".sheet-bar .name-key").click();
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
  await page.locator(".sheet-bar .name-key").click();
  assert.equal(await page.locator(".chat-index").evaluate(element => getComputedStyle(element).animationName), "none");
}, () => {}, { reducedMotion: "reduce" });

await browser.close();
await safari?.close();
if (failed) process.exit(1);
console.log("chat sheet browser: ok");
