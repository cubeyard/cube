/** A long conversation in a real browser against a scripted host: it opens
 * at its newest turns from a small window, reads older ones a page at a
 * time as the reader scrolls up without moving what they look at, keeps a
 * message sent meanwhile shown at once and once, and reconnects from the
 * same start. Needs a built UI (pnpm build) and Playwright's Chromium;
 * WebKit too when installed. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary, ThreadTranscript } from "../../src/lib/types.ts";
import { assertSend, monitor } from "./monitor.ts";
import { gate, ScriptedHost } from "./scripted-host.ts";

const TURNS = 150;
const pad = (n: number) => String(n).padStart(3, "0");
const body = "The runner answered, the gateway attached the machine and the thread went on with its work as planned. ".repeat(3);
const turn = (n: number): ThreadEvent[] => [
  { type: "user-message", id: `${n * 10 + 1}.0`, text: `turn ${pad(n)}` },
  { type: "tool-call", id: `${n * 10 + 2}.0.0`, callId: `c${n}`, name: "history", input: { id: `t${n}` }, final: true },
  { type: "tool-result", id: `${n * 10 + 3}.0`, callId: `c${n}`, name: "history", output: `history of t${n}`, isError: false, final: true },
  { type: "assistant-text", id: `${n * 10 + 4}.0.0`, text: `answer ${pad(n)}\n\n${body}`, reasoning: false, final: true },
];
const turns = (count: number, from = 0) => Array.from({ length: count }, (_, i) => turn(from + i)).flat();
const idle: ThreadTranscript["status"] = { state: "completed", run: "r0", error: null };
const thread: ThreadSummary = {
  id: "t1", title: "a long thread", state: "ready", error: null, createdAt: Date.now(), archived: false, project: { id: "p1", name: "cube" },
  workspaceBase: { remote: "https://github.com/cubeyard/cube", ref: "refs/heads/main", oid: "ab3b52c6ab3b52c6" },
};

type Viewport = { width: number; height: number };
const desktop: Viewport = { width: 1280, height: 800 };
const phone: Viewport = { width: 390, height: 844 };
let failed = false;

async function scenario(browser: Browser, engine: string, name: string, viewport: Viewport, route: "chat" | "t/t1",
  run: (page: Page, host: ScriptedHost, watch: Awaited<ReturnType<typeof monitor>>) => Promise<void>): Promise<void> {
  const host = await ScriptedHost.start();
  host.transcript = { ...host.transcript, status: idle, events: turns(TURNS) };
  host.thread = thread;
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  const label = `${engine} ${name} (${route}, ${viewport.width}x${viewport.height})`;
  try {
    const watch = await monitor(page);
    await page.goto(`${host.url}/#/${route}`);
    await page.locator(".composer textarea").waitFor();
    await page.getByText(`answer ${pad(TURNS - 1)}`).waitFor();
    await run(page, host, watch);
    assert.deepEqual(errors, [], "no script errors");
    console.log(`ok - ${label}`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${label}\n`, error);
  } finally {
    await page.close();
    await host.close();
  }
}

/** The user's messages shown, in order. */
const users = (page: Page) => page.locator(".transcript .conversation-message.user .message-copy").allTextContents();
/** Every message shows once. */
async function assertOnce(page: Page): Promise<string[]> {
  const shown = await users(page);
  assert.deepEqual(shown, [...new Set(shown)], "no message shows twice");
  return shown;
}
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const toTop = (page: Page) => page.locator(".transcript").evaluate(element => { element.scrollTop = 0; });
const top = (page: Page, text: string) => page.getByText(text, { exact: true }).evaluate(element => element.getBoundingClientRect().top);
const olderRequests = (host: ScriptedHost) => host.queries.filter(query => query.includes("before="));
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
};

async function suite(type: BrowserType, engine: string): Promise<void> {
  const browser = await type.launch();
  for (const route of ["chat", "t/t1"] as const) for (const viewport of [desktop, phone]) {
    await scenario(browser, engine, "a long conversation opens at its newest turns from a small window", viewport, route, async (page, host) => {
      const base = route === "chat" ? "/api/optchat" : "/api/threads/t1";
      const stream = host.queries.find(query => query.startsWith(`GET ${base}/stream`));
      assert.equal(stream, `GET ${base}/stream?tail=120`, "the stream asks for the newest events");
      assert.ok(!host.queries.some(query => query === `GET ${base}/history`), "nothing reads the whole transcript");
      const whole = Buffer.byteLength(JSON.stringify(host.transcript));
      assert.ok(host.sent[0]! * 4 < whole, `the first frame is a small part of the whole: ${host.sent[0]} of ${whole} bytes`);
      const shown = await assertOnce(page);
      assert.equal(shown.at(-1), `turn ${pad(TURNS - 1)}`);
      assert.ok(shown.length < 40, `only the newest turns: ${shown.length}`);
      await page.locator(".transcript-earlier button", { hasText: "show earlier messages" }).waitFor();
      const gap = await page.locator(".transcript").evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
      assert.ok(gap < 4, `the view is at the newest turn: ${gap}`);
    });

    await scenario(browser, engine, "scrolling up reads older pages and keeps what the reader looks at in place", viewport, route, async (page, host) => {
      let held = gate();
      host.onOlder = () => held.promise;
      let shown = await users(page);
      for (let pages = 0; shown[0] !== "turn 000"; pages++) {
        assert.ok(pages < 10, "the first turn is reached");
        const anchor = shown[0]!;
        const asked = olderRequests(host).length;
        await toTop(page);
        await until(() => olderRequests(host).length > asked, "a request for older messages");
        await page.locator(".transcript-earlier [role=status]", { hasText: "reading earlier messages" }).waitFor();
        await settle(page);
        const before = await top(page, anchor);
        held.open();
        await until(async () => (await users(page))[0] !== anchor, "the older page shown");
        await settle(page);
        const after = await top(page, anchor);
        assert.ok(Math.abs(after - before) < 2, `the reader's place stays: ${anchor} moved from ${before} to ${after}`);
        held = gate();
        host.onOlder = () => held.promise;
        shown = await assertOnce(page);
      }
      held.open();
      assert.equal(shown.length, TURNS, "every turn shows once");
      assert.equal(await page.locator(".transcript-earlier").count(), 0, "nothing earlier to read");
      const pages = olderRequests(host);
      assert.ok(pages.every(query => /before=\d+&limit=120$/.test(query)), `pages are asked before the first shown: ${pages.join(", ")}`);
    });
  }

  await scenario(browser, engine, "a message sent while an older page loads shows at once, once, and stays", desktop, "chat", async (page, host, watch) => {
    const held = gate();
    host.onOlder = () => held.promise;
    const logged = gate();
    host.onPrompt = async ({ text, requestId }) => {
      host.set([...host.transcript.events, { type: "user-message", id: `pending.${requestId}`, text }], { state: "working", run: "pending" });
      await logged.promise;
    };
    await toTop(page);
    await until(() => olderRequests(host).length === 1, "a request for older messages");
    await page.locator(".composer textarea").fill("hello while it reads");
    await watch.mark("send");
    await page.locator(".composer textarea").press("Enter");
    await page.getByText("hello while it reads").waitFor();
    held.open();
    await page.getByText(`turn ${pad(TURNS - 31)}`, { exact: true }).waitFor();
    const events = host.transcript.events.filter(event => !event.id.startsWith("pending."));
    host.set([...events, { type: "user-message", id: "2001.0", text: "hello while it reads" }, { type: "assistant-text", id: "2002.0.0", text: "read you", reasoning: false, final: true }], { state: "working", run: "r1" });
    logged.open();
    host.set(host.transcript.events, { state: "completed", run: "r1" });
    await page.getByText("read you").waitFor();
    await settle(page);
    assertSend(await watch.since("send"), "hello while it reads");
    await assertOnce(page);
  });

  await scenario(browser, engine, "a lost stream reconnects from the same start; the older pages and the new turn show once", desktop, "chat", async (page, host) => {
    await toTop(page);
    await page.getByText(`turn ${pad(TURNS - 31)}`, { exact: true }).waitFor();
    const before = await assertOnce(page);
    const first = host.queries.find(query => query.includes("/stream?"))!;
    host.drop();
    host.transcript = { ...host.transcript, events: [...host.transcript.events, ...turn(TURNS)] };
    await page.getByText(`answer ${pad(TURNS)}`).waitFor();
    await until(() => host.queries.filter(query => query.includes("/stream?")).length === 2, "the stream reconnected");
    const reconnect = host.queries.filter(query => query.includes("/stream?")).at(-1)!;
    assert.match(first, /tail=120$/);
    assert.match(reconnect, /from=\d+$/, `the reconnect asks from the pinned start: ${reconnect}`);
    const after = await assertOnce(page);
    assert.deepEqual(after, [...before, `turn ${pad(TURNS)}`], "the older pages stay; the new turn follows once");
  });

  await scenario(browser, engine, "a chat left open: a window grown far past its size starts later, its frames stay small and nothing goes", desktop, "chat", async (page, host) => {
    const first = (await users(page))[0]!;
    for (let n = TURNS; n < TURNS + 80; n += 10) {
      host.set([...host.transcript.events, ...turns(10, n)], { state: "completed" });
      await page.getByText(`answer ${pad(n + 9)}`).waitFor();
    }
    await until(() => host.queries.filter(query => query.includes("/stream?from=")).length > 0, "the stream started later");
    host.set([...host.transcript.events, ...turn(TURNS + 80)], { state: "completed" });
    await page.getByText(`answer ${pad(TURNS + 80)}`).waitFor();
    const whole = Buffer.byteLength(JSON.stringify(host.transcript));
    assert.ok(host.sent.at(-1)! * 4 < whole, `a frame stays a small part of the whole: ${host.sent.at(-1)} of ${whole} bytes`);
    const shown = await assertOnce(page);
    assert.equal(shown[0], first, "the turns the window held stay shown");
    assert.equal(shown.at(-1), `turn ${pad(TURNS + 80)}`);
  });

  await scenario(browser, engine, "a host that lost the window's start: the newest turns are read again, once", desktop, "chat", async (page, host) => {
    host.set(turns(40), { state: "completed" });
    await page.getByText(`answer ${pad(39)}`).waitFor();
    await until(async () => (await users(page)).at(-1) === `turn ${pad(39)}`, "the shorter transcript shown");
    const shown = await assertOnce(page);
    assert.ok(!shown.includes(`turn ${pad(TURNS - 1)}`), "nothing of the lost window stays");
    assert.equal(host.queries.filter(query => query.endsWith("/stream?tail=120")).length, 2, "the window is chosen again");
  });
  await browser.close();
}

await suite(chromium, "chromium");
if (fs.existsSync(webkit.executablePath())) await suite(webkit, "webkit");
else console.log("SKIP: webkit (install it: pnpm --filter @cube/web exec playwright install webkit)");
process.exit(failed ? 1 : 0);
