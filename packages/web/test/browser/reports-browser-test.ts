/** A thread's report in the chat is one folded line, against the scripted
 * host with chat-sheet-data's log: the thread's name, `report`, its state in
 * cube's words and its first words; the chat's own answers stay whole. A
 * failed report stands open, its state in error ink. Enter or a press opens
 * one and the reader's choice holds while frames arrive; a new report comes
 * folded; the margin's way to a report opens it and puts focus on it. The
 * line's accessible name says all of it. Desktop (with the margin) and phone
 * (a fingertip's line), Chromium and WebKit where Playwright has it.
 * Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, webkit, type Browser, type Page } from "playwright";
import type { ThreadEvent } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const failed: ThreadEvent = { type: "user-message", id: "9.0", text: `[${ID.ca.slice(0, 8)}] failed: the provider refused; last reply: half done`, from: ID.ca.slice(0, 8) };
const answer: ThreadEvent = { type: "assistant-text", id: "9.1", text: "The java trust thread failed: the provider refused. I can start it again when you want.", reasoning: false, final: true };
const later: ThreadEvent = { type: "user-message", id: "10.0", text: `[${ID.flaky.slice(0, 8)}] ended its turn; nothing of it runs now: Rebased on main, CI green again.`, from: ID.flaky.slice(0, 8) };

const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
const errors: string[] = [];
const lines = (page: Page) => page.locator(".chat-sheet details.report-line");

try {
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    const host = await ScriptedHost.start();
    host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: [...chatEvents(), failed, answer] };
    host.overview = overview();
    host.threads = threads;
    host.artifacts = artifacts;
    host.bodies = bodies;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${host.url}/#/chat`);
    await page.getByText("I can start it again when you want.").waitFor();

    // folded by default: one line with name, kind, state and first words; the body not shown
    const flaky = lines(page).and(page.locator("[data-anchor='3.0']"));
    assert.equal(await flaky.evaluate(element => (element as HTMLDetailsElement).open), false, `${size.name}: a report comes folded`);
    const summary = flaky.locator("summary");
    assert.match(await summary.innerText(), /report\s+turn ended\s+The test waited on a 140ms settle-in animation/, `${size.name}: name, kind, state and first words`);
    assert.equal(await flaky.locator(".report-body").isVisible(), false, `${size.name}: the report's body is not shown`);
    assert.match(await summary.getAttribute("aria-label") ?? "", /^report from find why the artifact browser test is flaky, turn ended: The test waited/, `${size.name}: the line's accessible name says it all`);
    const lineBox = (await summary.boundingBox())!;
    assert.ok(lineBox.height <= (size.touch ? 48 : 28), `${size.name}: one line (${lineBox.height}px)`);
    if (size.touch) assert.ok(lineBox.height >= 43.5, `${size.name}: a fingertip's height (${lineBox.height}px)`);
    // the chat's own answers stay whole
    assert.ok(await page.locator(".chat-sheet .conversation-message.assistant", { hasText: "The flaky test is fixed in" }).isVisible(), `${size.name}: the chat's answer is whole`);

    // a failure stands open, its state in error ink, the chat's answer after it
    const fail = lines(page).and(page.locator("[data-anchor='9.0']"));
    assert.equal(await fail.evaluate(element => (element as HTMLDetailsElement).open), true, `${size.name}: a failed report stands open`);
    assert.ok(await fail.locator(".report-body").isVisible(), `${size.name}: its whole report is shown`);
    const bad = await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("span")); probe.style.color = "var(--bad)"; const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(await fail.locator(".report-state").evaluate(element => getComputedStyle(element).color), bad, `${size.name}: the failed state in error ink`);
    assert.equal(await fail.locator(".report-state").textContent(), "failed");

    // opened by the keyboard; the choice holds while frames arrive; a new report comes folded
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await flaky.evaluate(element => (element as HTMLDetailsElement).open), true, `${size.name}: enter opens it`);
    assert.ok(await flaky.locator(".report-body").isVisible(), `${size.name}: opened, the report is whole`);
    assert.equal(await flaky.locator(".report-summary").isVisible(), false, `${size.name}: its first words do not stand twice`);
    await fail.locator("summary").click();
    assert.equal(await fail.evaluate(element => (element as HTMLDetailsElement).open), false, `${size.name}: a failure folds when the reader folds it`);
    host.set([...host.transcript.events, later], { state: "completed" });
    const newer = lines(page).and(page.locator("[data-anchor='10.0']"));
    await newer.waitFor();
    assert.equal(await newer.evaluate(element => (element as HTMLDetailsElement).open), false, `${size.name}: a new report comes folded`);
    assert.equal(await flaky.evaluate(element => (element as HTMLDetailsElement).open), true, `${size.name}: the opened one stays open through a frame`);
    assert.equal(await fail.evaluate(element => (element as HTMLDetailsElement).open), false, `${size.name}: the folded failure stays folded through a frame`);
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await flaky.evaluate(element => (element as HTMLDetailsElement).open), false, `${size.name}: enter folds it again`);

    // the margin's way to a report opens it and puts focus on it (the margin is there at 76rem and wider)
    if (!size.touch) {
      await page.locator(".margin-note .note-head", { hasText: "find why the artifact browser test is flaky" }).click();
      await page.locator(".note-link", { hasText: "its report in the chat" }).click();
      await page.waitForFunction(() => document.activeElement?.closest("details.report-line")?.hasAttribute("open"));
      assert.ok(await newer.locator("summary").evaluate(element => element === document.activeElement), `${size.name}: focus is on the report the note named (its newest)`);
    }
    assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), true, `${size.name}: nothing scrolls sideways`);
    console.log(`ok: ${size.name}: reports fold to a line, failures stand open, one action opens one`);
    await context.close();
    await host.close();
  }
  assert.deepEqual(errors, [], "no script errors");
  console.log("reports browser: ok");
} finally {
  for (const [, browser] of engines) await browser.close();
}
process.exit(0);
