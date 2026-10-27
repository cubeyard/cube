/** The chat folds each run of consecutive tool calls into one line, against
 * the scripted host (the data is mocked; the UI is the built one): `n tools
 * called`, the failures in error ink, the state while it moves, the call
 * worth naming. The chat's prose stays whole and in its place; one call
 * alone stays its own line. Enter or a press opens a run and the reader's
 * choice holds while frames arrive and the run grows; a run streams in a
 * call at a time; a failed call is named on the folded line and stands open
 * inside it. A spawn folded into a run keeps its margin note beside the
 * run's line (desktop) or its thread lines under it (phone), and the note's
 * way back opens the run. A tell folded into a run (#288) keeps its
 * thread's one note, at the newest tell it took, by the run's line while
 * folded and by the tell's own line once open. Desktop and phone, Chromium and WebKit where
 * Playwright has it. Screenshots go to CUBE_SCREENSHOTS when it is set.
 * Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, type Browser, type Locator, type Page } from "playwright";
import type { ThreadEvent } from "../../src/lib/types.ts";
import { artifacts, bodies, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string, final = true): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final });
const call = (id: string, callId: string, name: string, input: unknown): ThreadEvent => ({ type: "tool-call", id, callId, name, input, final: true });
const result = (id: string, callId: string, name: string, output: string, isError = false, final = true): ThreadEvent => ({ type: "tool-result", id, callId, name, output, isError, final });

const history: ThreadEvent[] = [
  user("1.0", "what is running, and start a thread on the flaky artifact test"),
  agent("1.1", "Looking at what runs first."),
  call("1.2", "threads-1", "threads", {}),
  result("1.3", "threads-1", "threads", `[${ID.composer.slice(0, 8)}] working · composer room`),
  call("1.4", "zoom-1", "zoom", { id: 12 }),
  result("1.5", "zoom-1", "zoom", "the user asked about the artifact test yesterday"),
  call("1.6", "spawn-1", "spawn", { tasks: [{ project: "cube", task: "find why the artifact browser test is flaky" }] }),
  result("1.7", "spawn-1", "spawn", `[${ID.flaky.slice(0, 8)}] started in cube: find why the artifact browser test is flaky`),
  agent("1.8", "Composer room is still working. I started a thread on the flaky artifact test."),
  user("2.0", "tell composer room to keep the send key"),
  call("2.1", "tell-bad", "tell", { id: "zzzzzzzz", message: "keep the send key" }),
  result("2.2", "tell-bad", "tell", "no thread [zzzzzzzz] in this chat", true),
  call("2.3", "threads-2", "threads", {}),
  result("2.4", "threads-2", "threads", `[${ID.composer.slice(0, 8)}] working · composer room`),
  agent("2.5", "That id was wrong; composer room is the one working now."),
  call("2.6", "tell-1", "tell", { id: ID.composer.slice(0, 8), message: "keep the send key" }),
  result("2.7", "tell-1", "tell", `sent to [${ID.composer.slice(0, 8)}]`),
  agent("2.8", "Told composer room to keep the send key."),
];

const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
const errors: string[] = [];
const groups = (page: Page) => page.locator(".chat-sheet details.tool-group");
const isOpen = (locator: Locator) => locator.evaluate(element => (element as HTMLDetailsElement).open);

try {
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    const host = await ScriptedHost.start();
    host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: history };
    host.overview = overview();
    host.threads = threads;
    host.artifacts = artifacts;
    host.bodies = bodies;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${size.name}: ${String(error)}`));
    await page.goto(`${host.url}/#/chat`);
    await page.getByText("Told composer room to keep the send key.").waitFor();
    await page.evaluate(() => document.fonts.ready);

    // history: two runs fold, the lone tell stays its own line, the prose is whole and in order
    assert.equal(await groups(page).count(), 2, `${size.name}: two runs of calls, two lines`);
    const first = groups(page).nth(0), second = groups(page).nth(1);
    assert.equal(await isOpen(first), false, `${size.name}: a run comes folded`);
    const summary = first.locator(":scope > summary");
    assert.match(await summary.innerText(), /^3 tools called\s+started 1 thread\s*$/, `${size.name}: the count and the last call in plain words`);
    assert.equal(await summary.getAttribute("aria-label"), "3 tools called: started 1 thread", `${size.name}: the line's accessible name says it`);
    const lineBox = (await summary.boundingBox())!;
    assert.ok(lineBox.height <= (size.touch ? 48 : 28), `${size.name}: one line (${lineBox.height}px)`);
    if (size.touch) assert.ok(lineBox.height >= 43.5, `${size.name}: a fingertip's height (${lineBox.height}px)`);
    // the folded run is its line alone (WebKit reports a stale box for a details inside a folded one; the run's own height does not lie)
    const runBox = (await first.boundingBox())!;
    assert.ok(Math.abs(runBox.height - lineBox.height) < 1, `${size.name}: its calls are not shown (${runBox.height}px for a ${lineBox.height}px line)`);
    assert.equal(await page.locator(".chat-sheet .tool-strip[data-anchor='call:tell-1']").isVisible(), true, `${size.name}: one call alone stays its own line`);
    const order = await page.locator(".chat-sheet .transcript-column > :is(article, details)").evaluateAll(elements => elements.map(element =>
      element.classList.contains("tool-group") ? `group:${element.querySelectorAll(".tool-strip").length}` : element.classList.contains("tool-strip") ? element.getAttribute("data-anchor") : element.getAttribute("data-anchor")));
    assert.deepEqual(order, ["1.0", "1.1", "group:3", "1.8", "2.0", "group:2", "2.5", "call:tell-1", "2.8"], `${size.name}: nothing moves; prose and messages stand between the runs`);
    for (const text of ["Looking at what runs first.", "That id was wrong; composer room is the one working now."]) assert.ok(await page.getByText(text).isVisible(), `${size.name}: prose stays whole`);

    // a failure is on the folded line, in error ink, and names the failed call
    assert.equal(await isOpen(second), false, `${size.name}: a run with a failure stays folded`);
    const failure = second.locator(":scope > summary .tool-state.failure");
    assert.equal(await failure.textContent(), "1 failed");
    const bad = await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("span")); probe.style.color = "var(--bad)"; const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(await failure.evaluate(element => getComputedStyle(element).color), bad, `${size.name}: the failure in error ink`);
    assert.match(await second.locator(":scope > summary").getAttribute("aria-label") ?? "", /^2 tools called, 1 failed: tell /, `${size.name}: the failed call is named`);

    // keyboard: enter opens; the failed call stands open inside; the choice holds through frames
    await second.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(second), true, `${size.name}: enter opens a run`);
    const failedStrip = second.locator(".tool-strip[data-anchor='call:tell-bad']");
    assert.equal(await isOpen(failedStrip), true, `${size.name}: the failed call stands open`);
    assert.ok(await failedStrip.getByText("no thread [zzzzzzzz] in this chat").isVisible(), `${size.name}: its error is shown`);
    if (shots) await page.screenshot({ path: path.join(shots, `tool-groups-${engine}-${base.name}-open.png`) });
    host.set([...history, user("3.0", "thanks")], { state: "completed" });
    await page.getByText("thanks", { exact: true }).waitFor();
    assert.equal(await isOpen(second), true, `${size.name}: the opened run stays open through a frame`);
    assert.equal(await isOpen(first), false, `${size.name}: the folded run stays folded`);
    await second.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(second), false, `${size.name}: enter folds it again`);

    // a spawn folded into a run keeps its thread note by the run's line
    if (!size.touch) {
      const note = page.locator(".margin-note", { hasText: "find why the artifact browser test is flaky" });
      await page.waitForFunction(() => document.querySelector(".margin-note.level .note-title")?.textContent?.includes("flaky"));
      const [noteTop, groupTop] = [(await note.boundingBox())!.y, (await summary.boundingBox())!.y];
      assert.ok(Math.abs(noteTop - groupTop) < 6, `${size.name}: the note stands by the run's line (${noteTop} vs ${groupTop})`);
      // the note's way back to its message opens the run and focuses the spawn
      await note.locator(".note-head").click();
      await note.getByRole("button", { name: "the message that started it" }).click();
      await page.waitForFunction(() => document.activeElement?.closest(".tool-strip")?.getAttribute("data-anchor") === "call:spawn-1");
      assert.equal(await isOpen(first), true, `${size.name}: the way back opens the run and focuses the spawn`);
      await summary.click();
      assert.equal(await isOpen(first), false, `${size.name}: and the reader folds it again`);
    } else {
      const inline = page.locator(".chat-sheet .sheet-note.inline", { hasText: "find why the artifact browser test is flaky" });
      assert.ok(await inline.isVisible(), `${size.name}: the spawn's thread line stands under the folded run`);
      assert.equal(await inline.evaluate(element => !!element.closest("details.tool-group")), false, `${size.name}: outside the fold`);
    }

    // streaming: a run grows a call at a time and keeps the reader's choice
    const asked = [...history, user("3.0", "thanks"), user("4.0", "check the composer thread again")];
    host.set([...asked, call("4.1", "threads-3", "threads", {})], { state: "working" });
    await page.locator(".tool-strip[data-anchor='call:threads-3']").waitFor();
    assert.equal(await groups(page).count(), 2, `${size.name}: one call streaming: still its own line`);
    host.set([...asked, call("4.1", "threads-3", "threads", {}), result("4.2", "threads-3", "threads", "…"), call("4.3", "zoom-3", "zoom", { id: 40 })], { state: "working" });
    const live = groups(page).nth(2);
    await live.waitFor();
    assert.match(await live.locator(":scope > summary").innerText(), /^2 tools called\s+waiting\s+zoom\s+\{"id":40\}\s*$/, `${size.name}: the call that waits is named`);
    await live.locator(":scope > summary").click();
    assert.equal(await isOpen(live), true, `${size.name}: a press opens the live run`);
    host.set([...asked, call("4.1", "threads-3", "threads", {}), result("4.2", "threads-3", "threads", "…"), call("4.3", "zoom-3", "zoom", { id: 40 }),
      result("4.4", "zoom-3", "zoom", "half", false, false)], { state: "working" });
    await live.locator(":scope > summary .tool-state", { hasText: "running" }).waitFor();
    host.set([...asked, call("4.1", "threads-3", "threads", {}), result("4.2", "threads-3", "threads", "…"), call("4.3", "zoom-3", "zoom", { id: 40 }),
      result("4.4", "zoom-3", "zoom", "whole"), call("4.5", "threads-4", "threads", {}), result("4.6", "threads-4", "threads", "…"), agent("4.7", "Composer room is still working.")], { state: "completed" });
    await page.getByText("Composer room is still working.", { exact: true }).waitFor();
    assert.equal(await live.locator(":scope > summary .tool-group-count").textContent(), "3 tools called", `${size.name}: the count grows as calls arrive`);
    assert.equal(await isOpen(live), true, `${size.name}: the reader's choice holds as the run grows`);
    assert.equal(await live.locator(":scope > summary .tool-state").count(), 0, `${size.name}: done says nothing`);

    assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), true, `${size.name}: nothing scrolls sideways`);
    if (shots) {
      await live.locator(":scope > summary").click();
      await page.screenshot({ path: path.join(shots, `tool-groups-${engine}-${base.name}.png`) });
    }
    console.log(`ok: ${size.name}: runs of calls fold to a line, failures print on it, prose stays whole`);
    await context.close();
    await host.close();
  }
  // Tells folded into a run (#288): the thread's note stands once, at the newest tell it took,
  // drawn by the run's line while it is folded and by the tell's own line once it is open.
  const flaky = ID.flaky.slice(0, 8);
  const told: ThreadEvent[] = [...history,
    user("5.0", "tell the flaky one to keep going, then check on it"),
    call("5.1", "tell-a", "tell", { id: flaky, message: "keep going" }),
    result("5.2", "tell-a", "tell", `sent to [${flaky}]; its report comes back as a message starting "[${flaky}] "`),
    call("5.3", "threads-5", "threads", {}),
    result("5.4", "threads-5", "threads", `[${flaky}] working · find why the artifact browser test is flaky`),
    call("5.5", "tell-b", "tell", { id: flaky, message: "and rebase on main" }),
    result("5.6", "tell-b", "tell", `queued for [${flaky}], which is working: it reads it after its current tool call`),
    agent("5.7", "Told it twice; it is working."),
    // room under the run: near the page's end the margin lifts notes to stay inside it
    ...Array.from({ length: 6 }, (_, index) => [user(`6.${index}a`, `question ${index + 1}: anything new?`), agent(`6.${index}b`, "Nothing new: the runners answered within the last minute and nothing needs you.")]).flat(),
  ];
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    const wide = !base.touch;
    const host = await ScriptedHost.start();
    host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: told };
    host.overview = overview({ flaky: "working" });
    host.threads = threads;
    host.artifacts = artifacts;
    host.bodies = bodies;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${size.name}: ${String(error)}`));
    await page.goto(`${host.url}/#/chat`);
    await page.getByText("Told it twice; it is working.").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("[data-anchor='5.0']").evaluate(element => element.scrollIntoView({ block: "start" }));

    const run = groups(page).filter({ has: page.locator("[data-anchor='call:tell-b']") });
    assert.equal(await isOpen(run), false, `${size.name}: the tells' run comes folded`);
    assert.equal(await run.locator(":scope > summary .tool-group-count").textContent(), "3 tools called");
    const notes = page.locator(wide ? ".margin-notes > [data-note]" : ".transcript-column .sheet-note.inline[data-note]")
      .filter({ has: page.locator(".note-head", { hasText: "find why the artifact browser test is flaky" }) });
    await notes.first().waitFor();
    assert.deepEqual(await notes.evaluateAll(all => all.map(note => note.getAttribute("data-note"))), ["call:tell-b"], `${size.name}: one note for the thread, at the newest tell it took`);
    const note = notes.first();
    const top = async (locator: Locator) => (await locator.boundingBox())!.y;
    if (wide) {
      await page.locator(".margin-note.level[data-note='call:tell-b']").waitFor();
      // folded, the note stands by the run's line
      await page.waitForFunction(() => {
        const note = document.querySelector(".margin-note[data-note='call:tell-b']"), line = document.querySelector("details.tool-group:has([data-anchor='call:tell-b']) > summary");
        return !!note && !!line && Math.abs(note.getBoundingClientRect().top - line.getBoundingClientRect().top) < 6;
      }, null, { timeout: 5000 });
      await run.locator(":scope > summary").click();
      await page.waitForFunction(() => {
        const note = document.querySelector(".margin-note[data-note='call:tell-b']"), strip = document.querySelector("[data-anchor='call:tell-b']");
        return !!note && !!strip && Math.abs(note.getBoundingClientRect().top - strip.getBoundingClientRect().top) < 6;
      });
      assert.ok(await note.evaluate(element => element.classList.contains("level")), `${size.name}: opened, the note stands by the tell itself`);
      await run.locator(":scope > summary").click();
      await page.waitForFunction(() => {
        const note = document.querySelector(".margin-note[data-note='call:tell-b']"), line = document.querySelector("details.tool-group:has([data-anchor='call:tell-b']) > summary");
        return !!note && !!line && Math.abs(note.getBoundingClientRect().top - line.getBoundingClientRect().top) < 6;
      });
    } else {
      assert.ok(await note.isVisible(), `${size.name}: the note stands under the folded run`);
      assert.ok(await note.evaluate(element => element.previousElementSibling?.matches("details.tool-group:has([data-anchor='call:tell-b'])") ?? false), `${size.name}: right after the run, outside the fold`);
      await run.locator(":scope > summary").click();
      assert.ok(await note.isVisible(), `${size.name}: still there with the run open`);
      assert.ok(await top(note) > await top(run.locator(".tool-strip[data-anchor='call:tell-b']")), `${size.name}: under the tell it belongs to`);
      await run.locator(":scope > summary").click();
    }
    assert.equal(await notes.count(), 1, `${size.name}: still one note after opening and folding`);
    if (shots) await page.screenshot({ path: path.join(shots, `tool-groups-tells-${engine}-${base.name}.png`) });
    console.log(`ok: ${size.name}: a tell in a folded run keeps its thread's note, once, by the run's line or the tell's`);
    await context.close();
    await host.close();
  }

  assert.deepEqual(errors, [], "no script errors");
  console.log("tool groups browser: ok");
} finally {
  for (const [, browser] of engines) await browser.close();
}
process.exit(0);
