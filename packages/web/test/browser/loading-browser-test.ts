/** A page opened cold, with every answer slow, against the scripted host:
 * the waits before its first content read as one. The shell, the view and
 * its conversation each wait for their own answer in turn; each step says
 * the same `loading…` in the same ink on the same reading field, the line
 * stays where it was within a little, and it holds until the content is
 * there (no blank page between). Before, the steps said `loading…`,
 * `loading threads…`, `opening the chat…`, `reading thread…` and
 * `loading artifact…` in turn, from the top of the page to its middle, and
 * the shell's putty turned to the sheet's white as the view came in.
 * Desktop and phone. Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { artifacts, bodies, chatEvents, ID, overview, threads } from "./chat-sheet-data.ts";
import { ScriptedHost } from "./scripted-host.ts";

type Seen = { at: number; waits: { text: string; x: number; y: number }[]; content: number; background: string; ink: string[] };

const host = await ScriptedHost.start();
host.transcript = { ...host.transcript, status: { state: "completed", run: "r", error: null }, events: chatEvents().slice(0, 12) };
host.thread = { ...threads[0]!, id: "t1" };
host.threads = threads.slice(1);
host.artifacts = artifacts;
host.bodies = bodies;
host.overview = overview();
const browser = await chromium.launch();
const errors: string[] = [];
const routes = ["#/chat", "#/t/t1", "#/threads", "#/artifacts", `#/a/${ID.proposal}`, "#/projects"];
try {
  for (const size of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    for (const route of routes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(String(error)));
      // every answer comes 300ms late, so each wait is on screen long enough to see
      await page.route("**/api/**", async request => { await new Promise(resolve => setTimeout(resolve, 300)); await request.continue(); });
      await page.addInitScript(() => {
        const seen: Seen[] = [];
        (window as unknown as { seen: Seen[] }).seen = seen;
        const start = performance.now();
        let last = "";
        const look = () => {
          if (!document.body) return;
          const waits = [...document.querySelectorAll<HTMLElement>(".loading, .conversation-wait")].filter(element => element.getClientRects().length).map(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const box = range.getBoundingClientRect();
            return { text: element.textContent!.trim(), x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
          });
          const content = [...document.querySelectorAll("main h1:not(.sr-only), .transcript-column > article, .artifact-body")].filter(element => element.getClientRects().length).length;
          const ink = [...document.querySelectorAll<HTMLElement>(".loading, .conversation-wait")].map(element => getComputedStyle(element).color);
          const entry = { at: Math.round(performance.now() - start), waits, content, background: getComputedStyle(document.body).backgroundColor, ink };
          const key = JSON.stringify({ ...entry, at: 0 });
          if (key !== last) { seen.push(entry); last = key; }
        };
        new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      });
      await page.goto(`${host.url}/${route}`);
      await page.waitForFunction(() => (window as unknown as { seen: Seen[] }).seen.some(entry => entry.content > 0 && !entry.waits.length), undefined, { timeout: 20_000 });
      const seen = (await page.evaluate(() => (window as unknown as { seen: Seen[] }).seen)).filter(entry => entry.background !== "rgba(0, 0, 0, 0)");
      const label = `${route} on a ${size.name}`;
      const waiting = seen.filter(entry => entry.waits.length);
      assert.ok(waiting.length >= 1, `${label}: the slow answers show waits: ${JSON.stringify(seen)}`);
      assert.deepEqual([...new Set(waiting.flatMap(entry => entry.waits.map(wait => wait.text)))], ["loading…"], `${label}: one wording at every step`);
      assert.ok(waiting.every(entry => entry.waits.length === 1), `${label}: one wait on screen at a time`);
      assert.equal(new Set(seen.map(entry => entry.background)).size, 1, `${label}: the background never changes: ${[...new Set(seen.map(entry => entry.background))]}`);
      assert.equal(new Set(waiting.flatMap(entry => entry.ink)).size, 1, `${label}: the same ink at every step`);
      const ys = waiting.map(entry => entry.waits[0]!.y);
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 48, `${label}: the line stays where it was within a little: ${ys.join(" → ")}`);
      // from the first wait to the content, never an empty page
      const first = seen.findIndex(entry => entry.waits.length);
      const shown = seen.findIndex(entry => entry.content > 0 && !entry.waits.length);
      const between = seen.slice(first, shown);
      assert.ok(between.every(entry => entry.waits.length || entry.content), `${label}: no blank page between the wait and the content: ${JSON.stringify(between)}`);
      console.log(`ok: ${label}: ${waiting.length} waits, one line (${ys.join(" → ")}px), then the content`);
      await context.close();
    }
  }
  assert.deepEqual(errors, [], "no script errors");
  console.log("loading browser: ok");
} finally {
  await browser.close();
  await host.close();
}
process.exit(0);
