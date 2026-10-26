/** Thread names ("🦦 calm otter") where the chat labels its threads, against
 * the scripted host with chat-sheet-data's log: a folded report line and a
 * tell's tool line call a thread by its name; a margin note (inline on a
 * phone), the opened report, the index and the thread's own bar put it
 * before the title, which stays as it is; the index finds a thread by its
 * name; a thread older than names shows its title alone. The name adds no
 * width: the chat's column and composer keep theirs. Desktop and phone.
 * Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import type { ThreadSummary } from "../../src/lib/types.ts";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

const OTTER = { emoji: "🦦", words: "calm otter" };
const FOX = { emoji: "🦊", words: "plucky fox" };
// composer room and the flaky test have names; java trust is older than names.
const names: Record<string, typeof OTTER> = { [ID.composer]: OTTER, [ID.flaky]: FOX };
const named = <T extends { id: string }>(thread: T): T => names[thread.id] ? { ...thread, name: names[thread.id] } : thread;
const composerTitle = "composer room: measure the mobile composer and propose more space";

const browser = await chromium.launch();
const errors: string[] = [];
const width = (page: Page, selector: string) => page.locator(selector).first().evaluate(element => element.getBoundingClientRect().width);

/** The chat with the given threads; the composer thread also opens on its own. */
async function open(size: { width: number; height: number; touch?: boolean }, withNames: boolean): Promise<{ page: Page; host: ScriptedHost; close: () => Promise<void> }> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents() };
  const view = overview();
  host.overview = withNames ? { ...view, threads: view.threads.map(named) } : view;
  const listed: ThreadSummary[] = withNames ? threads.map(named) : threads;
  host.thread = listed[0]!;
  host.threads = listed.slice(1);
  host.artifacts = artifacts;
  host.bodies = bodies;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${host.url}/#/chat`);
  await page.getByText("Here it is:").waitFor();
  return { page, host, close: async () => { await context.close(); await host.close(); } };
}

try {
  for (const size of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    // Without names, for the widths the names must not change.
    const plain = await open(size, false);
    const column = await width(plain.page, ".chat-sheet .composer");
    await plain.close();

    const { page, close } = await open(size, true);
    const wide = size.width >= 76 * 16;

    // A folded report calls the thread by its name; opened, the name leads the title.
    const flaky = page.locator(".chat-sheet details.report-line[data-anchor='3.0']");
    await page.locator(".report-title", { hasText: "🦊 plucky fox" }).first().waitFor();
    assert.equal(await flaky.locator(".report-title").innerText(), "🦊 plucky fox", `${size.name}: the report line's name`);
    assert.ok(await flaky.locator(".report-title").evaluate(element => element.scrollWidth <= element.clientWidth), `${size.name}: the name is not cut`);
    assert.match(await flaky.locator("summary").getAttribute("aria-label") ?? "", /^report from 🦊 plucky fox, turn ended: /, `${size.name}: its accessible name`);
    await flaky.locator("summary").click();
    const label = flaky.locator(".report-body .report-name");
    assert.equal(await label.textContent(), "🦊 plucky fox, find why the artifact browser test is flaky", `${size.name}: opened, the name before the title`);
    assert.equal(await label.locator(".thread-emoji").getAttribute("aria-hidden"), "true", `${size.name}: the emoji is not read out twice`);
    assert.equal(await label.getAttribute("href"), `#/t/${ID.flaky}`);

    // A tell's tool line names the thread it told.
    assert.ok(await page.locator(".chat-sheet .tool-said", { hasText: "told 🦦 calm otter" }).first().isVisible(), `${size.name}: told by name`);

    // The margin (inline under the spawn on a phone): the name, then the title; the older thread its title alone.
    const notes = wide ? page.locator(".sheet-margin") : page.locator(".chat-sheet .sheet-note.inline");
    const otter = notes.locator(".note-title", { hasText: "calm otter" }).first();
    await otter.waitFor();
    assert.equal(await otter.locator(".thread-name").innerText(), "🦦 calm otter", `${size.name}: the note's name`);
    assert.match(await otter.innerText(), new RegExp(`calm otter[,\\s]*${composerTitle}`), `${size.name}: the title after it`);
    const older = notes.locator(".note-title", { hasText: "java trusts runner ca" }).first();
    assert.equal(await older.locator(".thread-name").count(), 0, `${size.name}: a thread older than names has none`);

    // The index finds a thread by its name and shows it before the title.
    await page.locator(".chat-sheet .composer textarea").focus();
    await page.keyboard.press("Control+k");
    const filter = page.locator(".chat-index input[type='search'], .chat-index input").first();
    await filter.waitFor();
    await filter.fill("plucky");
    const rows = page.locator(".chat-index .index-row[href^='#/t/']");
    assert.equal(await rows.count(), 1, `${size.name}: one thread matches its name`);
    assert.equal(await rows.first().getAttribute("href"), `#/t/${ID.flaky}`);
    assert.equal(await rows.first().locator(".index-title .thread-name").innerText(), "🦊 plucky fox");
    await page.keyboard.press("Escape");

    // The chat's column and composer keep their width with names in it.
    assert.equal(await width(page, ".chat-sheet .composer"), column, `${size.name}: the composer's width`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${size.name}: nothing runs past the screen`);

    // The thread's own sheet: its bar leads with the name, the tab says both.
    await page.goto(`${page.url().split("#")[0]}#/t/${ID.composer}`);
    const heading = page.locator(".bar-title h1.strip-title");
    await heading.waitFor();
    assert.equal(await heading.locator(".thread-name").innerText(), "🦦 calm otter", `${size.name}: the bar's name`);
    assert.equal(await heading.getAttribute("title"), `🦦 calm otter · ${composerTitle}`, `${size.name}: the whole name in its tooltip`);
    assert.equal(await page.title(), `🦦 calm otter · ${composerTitle} · cube`);
    const box = (await heading.boundingBox())!;
    assert.ok(box.height < 30, `${size.name}: the bar's title stays one line (${box.height}px)`);
    await close();
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log("ok: thread names in the report line, tell line, margin, index, thread bar and tab; none for an older thread; no width taken");
} finally {
  await browser.close();
}
