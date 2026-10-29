/** A thread folds each run of consecutive tool calls into one line, as the
 * chat does (tool-groups-browser-test), against the scripted host (the data
 * is mocked; the UI is the built one): nine commands in a row are `9 tools
 * called` with the failure in error ink and the failed command named; the
 * answer around them stays whole and in its place, and one call alone stays
 * its own line. Enter opens the run; inside, each call is its own line that
 * opens on its own, the failed one standing open with its output. While
 * the thread works a run grows a call at a time, its line says `waiting`
 * or `running` and names the command that moves, and the reader's choice
 * holds; a message steered in mid-run splits it; a stopped run says `no
 * result`. Nothing scrolls sideways under a long command. Desktop and
 * phone, Chromium and WebKit where Playwright has it. Screenshots go to
 * CUBE_SCREENSHOTS when it is set. Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, type Browser, type Locator, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary } from "../../src/lib/types.ts";
import { ACTIVE } from "./monitor.ts";
import { ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
const call = (id: string, callId: string, command: string): ThreadEvent => ({ type: "tool-call", id, callId, name: "bash", input: { command }, final: true });
const result = (id: string, callId: string, output: string, isError = false, final = true): ThreadEvent => ({ type: "tool-result", id, callId, name: "bash", output, isError, final });

const LONG = `node packages/server/test/gateway-test.ts --filter ${"upstream-handshake-".repeat(8)}`;
const COMMANDS = ["git status --short", "ls packages/gateway/src", "rg -n 'handshake' packages/gateway/src", "sed -n 1,80p packages/gateway/src/proxy.ts",
  LONG, "pnpm --filter gateway typecheck", "git log --oneline -5 -- packages/gateway", "cat packages/gateway/package.json", "pnpm --filter gateway test"];
const FAILED = 4;
const history: ThreadEvent[] = [
  user("1.0", "why does the gateway test fail on main?"),
  agent("1.1", "Looking at the gateway first."),
  ...COMMANDS.flatMap((command, index) => [call(`1.${2 + 2 * index}`, `k${index}`, command),
    result(`1.${3 + 2 * index}`, `k${index}`, index === FAILED ? "AssertionError: expected 200, got 502\n    at upstream handshake" : `ok ${index}`, index === FAILED)]),
  agent("1.30", "The gateway test fails because the upstream handshake answers 502 before the proxy is ready."),
  user("2.0", "and does lint pass?"),
  call("2.1", "lint", "pnpm lint"), result("2.2", "lint", "no problems"),
  agent("2.3", "Lint passes."),
];
const thread: ThreadSummary = {
  id: "t1", title: "find why the gateway test fails", state: "ready", error: null,
  createdAt: Date.now(), archived: false, project: { id: "p1", name: "cube" },
  workspaceBase: { remote: "https://github.com/cubeyard/cube", ref: "refs/heads/main", oid: "ab3b52c6ab3b52c6" },
};

const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
const errors: string[] = [];
const groups = (page: Page) => page.locator(`${ACTIVE} .transcript-column > details.tool-group`);
const isOpen = (locator: Locator) => locator.evaluate(element => (element as HTMLDetailsElement).open);
const noSideways = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth);

try {
  for (const [engine, browser] of engines) for (const base of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const size = { ...base, name: `${engine} ${base.name}` };
    const host = await ScriptedHost.start();
    host.transcript = { agent: "pi", owner: null, status: { state: "completed", run: "r", error: null }, events: history };
    host.thread = thread;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch && engine === "chromium", hasTouch: !!size.touch });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${size.name}: ${String(error)}`));
    await page.goto(`${host.url}/#/t/t1`);
    await page.locator(ACTIVE).getByText("Lint passes.").waitFor();
    await page.evaluate(() => document.fonts.ready);

    // history: nine commands fold to one line; the lone call and the prose stand as they were
    assert.equal(await groups(page).count(), 1, `${size.name}: one run, one line`);
    const run = groups(page).first();
    const summary = run.locator(":scope > summary");
    assert.equal(await isOpen(run), false, `${size.name}: a run comes folded, its failure too`);
    assert.match(await summary.innerText(), /^9 tools called\s+1 failed\s+bash\s+node packages\/server\/test\/gateway-test\.ts/, `${size.name}: the count, the failure and the failed command`);
    assert.ok((await summary.getAttribute("aria-label"))!.startsWith("9 tools called, 1 failed: bash node packages/server/test/gateway-test.ts --filter"), `${size.name}: the line's accessible name says it`);
    const failure = summary.locator(".tool-state.failure");
    const bad = await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("span")); probe.style.color = "var(--bad)"; const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(await failure.evaluate(element => getComputedStyle(element).color), bad, `${size.name}: the failure in error ink`);
    const lineBox = (await summary.boundingBox())!;
    assert.ok(lineBox.height <= (size.touch ? 48 : 28), `${size.name}: one line (${lineBox.height}px)`);
    if (size.touch) assert.ok(lineBox.height >= 43.5, `${size.name}: a fingertip's height (${lineBox.height}px)`);
    assert.ok(Math.abs((await run.boundingBox())!.height - lineBox.height) < 1, `${size.name}: its calls are not shown`);
    const order = await page.locator(`${ACTIVE} .transcript-column > :is(article, details)`).evaluateAll(elements => elements.map(element =>
      element.classList.contains("tool-group") ? `group:${element.querySelectorAll(".tool-strip").length}` : element.getAttribute("data-anchor")));
    assert.deepEqual(order, ["1.0", "1.1", "group:9", "1.30", "2.0", "call:lint", "2.3"], `${size.name}: nothing moves; the answer follows the run`);
    assert.ok(await page.locator(ACTIVE).getByText("The gateway test fails because the upstream handshake answers 502").isVisible(), `${size.name}: the answer stays whole`);
    assert.equal(await noSideways(page), true, `${size.name}: a long command does not push the page sideways`);
    if (shots) await page.screenshot({ path: path.join(shots, `thread-tool-groups-${engine}-${base.name}.png`) });

    // keyboard: enter opens the run; each call is its own line, the failed one open with its output
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(run), true, `${size.name}: enter opens a run`);
    const strips = run.locator(".tool-strip");
    assert.equal(await strips.count(), 9, `${size.name}: all nine calls inside`);
    assert.deepEqual(await strips.evaluateAll(all => all.map(strip => (strip as HTMLDetailsElement).open)), COMMANDS.map((_, index) => index === FAILED),
      `${size.name}: the failed call stands open, the others are lines`);
    assert.ok(await run.getByText("AssertionError: expected 200, got 502").isVisible(), `${size.name}: its output is shown`);
    const firstStrip = strips.first();
    await firstStrip.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(firstStrip), true, `${size.name}: a call inside opens on its own`);
    assert.ok(await firstStrip.getByText("ok 0").isVisible(), `${size.name}: and shows its output`);
    assert.equal(await noSideways(page), true, `${size.name}: opened, nothing scrolls sideways`);
    if (shots) await page.screenshot({ path: path.join(shots, `thread-tool-groups-${engine}-${base.name}-open.png`) });
    host.set([...history, user("3.0", "thanks")], { state: "completed" });
    await page.locator(ACTIVE).getByText("thanks", { exact: true }).waitFor();
    assert.equal(await isOpen(run), true, `${size.name}: the opened run stays open through a frame`);
    assert.equal(await isOpen(firstStrip), true, `${size.name}: and so does the call opened inside it`);
    await summary.focus();
    await page.keyboard.press("Enter");
    assert.equal(await isOpen(run), false, `${size.name}: enter folds it again`);

    // streaming: one call is its own open line; a second folds them, the moving one named
    const asked = [...history, user("3.0", "thanks"), user("4.0", "run the gateway tests again")];
    host.set([...asked, call("4.1", "s0", "pnpm --filter gateway build")], { state: "working" });
    const lone = page.locator(`${ACTIVE} .transcript-column > .tool-strip[data-anchor='call:s0']`);
    await lone.waitFor();
    assert.equal(await isOpen(lone), true, `${size.name}: one call waiting stands open, as before`);
    host.set([...asked, call("4.1", "s0", "pnpm --filter gateway build"), result("4.2", "s0", "built"), call("4.3", "s1", "pnpm --filter gateway test")], { state: "working" });
    const live = groups(page).nth(1);
    await live.waitFor();
    assert.match(await live.locator(":scope > summary").innerText(), /^2 tools called\s+waiting\s+bash\s+pnpm --filter gateway test\s*$/, `${size.name}: the waiting command is named`);
    assert.equal(await isOpen(live), false, `${size.name}: a live run comes folded`);
    assert.ok(await page.locator(`${ACTIVE} .working-line`, { hasText: "working…" }).isVisible(), `${size.name}: the thread still says it works`);
    host.set([...asked, call("4.1", "s0", "pnpm --filter gateway build"), result("4.2", "s0", "built"), call("4.3", "s1", "pnpm --filter gateway test"),
      result("4.4", "s1", "1 passing", false, false)], { state: "working" });
    await live.locator(":scope > summary .tool-state", { hasText: "running" }).waitFor();
    await live.locator(":scope > summary").click();
    assert.equal(await isOpen(live), true, `${size.name}: a press opens the live run`);
    assert.ok(await live.getByText("1 passing").isVisible(), `${size.name}: inside, the running call shows its output as it streams`);
    // a message steered in mid-run splits it: nothing groups across it
    const ran = [...asked, call("4.1", "s0", "pnpm --filter gateway build"), result("4.2", "s0", "built"), call("4.3", "s1", "pnpm --filter gateway test"),
      result("4.4", "s1", "AssertionError: expected 200, got 502", true), call("4.5", "s2", "pnpm --filter gateway test --verbose"), result("4.6", "s2", "1 failing", true)];
    host.set([...ran, user("m7", "also check the proxy log"), call("4.8", "s3", "tail -n 50 /tmp/proxy.log"), result("4.9", "s3", "502 upstream"),
      call("4.10", "s4", "rg -n 502 packages/gateway/src"), result("4.11", "s4", "proxy.ts:88"), agent("4.12", "The proxy answers 502 while the upstream connects.")], { state: "completed" });
    await page.locator(ACTIVE).getByText("The proxy answers 502 while the upstream connects.").waitFor();
    assert.equal(await groups(page).count(), 3, `${size.name}: the steered message splits the run in two`);
    assert.equal(await live.locator(":scope > summary .tool-group-count").textContent(), "3 tools called", `${size.name}: the count grows as calls arrive`);
    assert.equal(await live.locator(":scope > summary .tool-state.failure").textContent(), "2 failed", `${size.name}: the failures are counted`);
    assert.equal(await isOpen(live), true, `${size.name}: the reader's choice holds as the run grows and ends`);
    assert.equal(await groups(page).nth(2).evaluate(element => element.previousElementSibling?.getAttribute("data-anchor")), "m7", `${size.name}: the next run follows the steered message`);

    // stopped: a run without its last result says so
    host.set([...ran, user("5.0", "try once more"), call("5.1", "x0", "git pull"), result("5.2", "x0", "up to date"), call("5.3", "x1", "pnpm --filter gateway test")], { state: "stopped" });
    await page.locator(`${ACTIVE} .working-line`, { hasText: "stopped" }).waitFor();
    assert.match(await groups(page).last().locator(":scope > summary").innerText(), /^2 tools called\s+no result\s+bash\s+pnpm --filter gateway test\s*$/, `${size.name}: the run that ended without a result says so`);

    assert.equal(await noSideways(page), true, `${size.name}: nothing scrolls sideways`);
    console.log(`ok: ${size.name}: a thread's runs of commands fold to a line, failures and moving work print on it, the answer stays whole`);
    await context.close();
    await host.close();
  }
  assert.deepEqual(errors, [], "no script errors");
  console.log("thread tool groups browser: ok");
} finally {
  for (const [, browser] of engines) await browser.close();
}
process.exit(0);
