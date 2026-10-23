/** Thread names in a real browser: each thread's emoji and name ("🦦 calm
 * otter") beside its title, never in its place, wherever a thread is shown:
 * the thread list, the thread's strip and sidebar, the tab title, and on a
 * phone the thread switch; a thread created before names reads the one its
 * id gives. Against the real cubed (its registry names the threads), then
 * the chat against a scripted host: a thread's report and the chat's
 * threads panel carry the name. Desktop and phone. CUBE_SCREENSHOTS=<dir>
 * keeps a picture of each. Needs a built UI (pnpm build) and Playwright's
 * Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";
import { threadIdentity } from "../../../server/src/thread-names.ts";
import type { ThreadEvent } from "../../src/lib/types.ts";
import { ScriptedHost } from "./scripted-host.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `names-${name}.png`) }); };
const errors: string[] = [];
const sizes = [[{ width: 1280, height: 800 }, "desktop"], [{ width: 390, height: 844 }, "phone"]] as const;
const text = async (page: Page, selector: string) => (await page.locator(selector).first().textContent())?.replace(/\s+/g, " ").trim() ?? "";

const browser = await chromium.launch();
const host = await startChatHost();
try {
  const { registry } = host;
  registry.saveProject({ id: "p", name: "demo", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "pool", environmentId: 1, threadId: "pool", configPath: "/nonexistent/pool.json", configHash: "pool", protocol: 4, kind: "vm", maxActiveVms: 4 });
  const model = { provider: "fixture", id: "m" };
  const named = registry.createThread("p", "named", model, "fix the flaky gateway test");
  const name = named.identity!;
  // A thread from before names: its record has none, and nothing writes one.
  const legacyId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
  const sqlite = new DatabaseSync(path.join(host.state, "registry.sqlite"));
  const { identity: _named, ...record } = JSON.parse(String((sqlite.prepare("SELECT data FROM thread WHERE id=?").get(named.id) as { data: string }).data)) as Record<string, unknown>;
  sqlite.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(legacyId, "p", "pool", JSON.stringify({ ...record, id: legacyId, title: "an older thread",
    createdAt: 1, vm: { vmId: "0123456789abcdef", placeholders: {} } }));
  const legacy = threadIdentity(legacyId);

  for (const [viewport, size] of sizes) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", error => errors.push(String(error)));
    // The list: the title leads; the name opens the line beneath it.
    await page.goto(`${host.url}/#/threads`);
    const row = page.locator(".module", { hasText: "fix the flaky gateway test" });
    await row.waitFor();
    assert.equal(await row.locator(".module-title").textContent(), "fix the flaky gateway test", "the title stays the task");
    assert.equal(await row.locator(".module-meta .thread-name").textContent(), `${name.emoji}${name.name}`);
    assert.equal(await row.locator(".thread-name-emoji").getAttribute("aria-hidden"), "true", "a screen reader hears the words once");
    const old = page.locator(".module", { hasText: "an older thread" });
    assert.equal(await old.locator(".module-meta .thread-name").textContent(), `${legacy.emoji}${legacy.name}`, "an older thread reads the name its id gives");
    await shoot(page, `${size}-list`);

    // The thread: its strip and the tab name it beside the title.
    await page.goto(`${host.url}/#/t/${named.id}`);
    await page.locator(".thread-strip:not(.hidden)").waitFor();
    assert.equal(await page.title(), `${name.emoji} fix the flaky gateway test · cube`);
    if (size === "desktop") {
      assert.equal(await text(page, ".strip-title"), "fix the flaky gateway test");
      assert.equal(await text(page, ".strip-name"), `${name.emoji}${name.name}`);
      assert.equal(await page.locator(".strip-name").isVisible(), true);
      const sidebarRow = page.locator(".thread-sidebar-row", { hasText: "fix the flaky gateway test" });
      assert.equal(await sidebarRow.locator(".thread-sidebar-title").textContent(), "fix the flaky gateway test");
      assert.equal(await sidebarRow.locator(".thread-sidebar-meta .thread-name").textContent(), `${name.emoji}${name.name}`);
    } else {
      // The phone's switch carries the emoji before the title; the name is a tap away, in the details.
      assert.equal(await text(page, ".mobile-thread-switch"), `${name.emoji} fix the flaky gateway test`);
      assert.equal(await page.locator(".strip-name").isVisible(), false);
      await page.locator(".strip-details-key").click();
      assert.equal(await page.locator(".strip-name").isVisible(), true, "the details show the name");
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `nothing pushes the page sideways (${size})`);
    await shoot(page, `${size}-thread`);
    await page.close();
  }
  // Reading the threads wrote nothing into the older thread's record.
  assert.equal((sqlite.prepare("SELECT json_extract(data, '$.identity') AS identity FROM thread WHERE id=?").get(legacyId) as { identity: unknown }).identity, null);
  sqlite.close();
} finally {
  await host.close();
}

// The chat: a thread's report is labelled with its name and short id, and
// the threads panel shows the name beside the id.
const otter = { name: "calm otter", emoji: "🦦" };
for (const [viewport, size] of sizes) {
  const scripted = await ScriptedHost.start();
  const events: ThreadEvent[] = [
    { type: "user-message", id: "1", text: "please fix the gateway test" },
    { type: "assistant-text", id: "2", text: "starting a thread for it", reasoning: false, final: true },
    { type: "user-message", id: "3", text: "[abcdef12] ended: the test is fixed in PR #212", from: "abcdef12", fromIdentity: otter },
    { type: "user-message", id: "4", text: "[0123abcd] ended: an older report", from: "0123abcd" },
  ];
  scripted.transcript = { agent: "pi", owner: null, status: { state: "idle", run: null, error: null }, events };
  scripted.overview = { threads: [{ id: "abcdef12-0000-4000-8000-000000000001", title: "fix the gateway test", identity: otter, project: { id: "p", name: "demo" },
    state: "completed", archived: false, spawned: 1 }], archived: { shown: 0, total: 0 }, unknown: 0 };
  const page = await browser.newPage({ viewport });
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${scripted.url}/#/chat`);
    const report = page.locator(".conversation-message.report", { hasText: "the test is fixed" });
    await report.waitFor();
    assert.equal((await report.locator(".message-label").textContent())?.replace(/\s+/g, " ").trim(), "🦦calm otter · thread abcdef12");
    assert.equal((await report.locator(".message-copy").textContent())?.trim(), "ended: the test is fixed in PR #212", "the report's text without its id");
    const unnamed = page.locator(".conversation-message.report", { hasText: "an older report" });
    assert.equal((await unnamed.locator(".message-label").textContent())?.trim(), "thread 0123abcd", "a report without a name keeps its label");
    if (size === "phone") await page.locator(".work-head button").first().click();
    const panelRow = page.locator(".work-thread", { hasText: "fix the gateway test" });
    await panelRow.waitFor();
    assert.equal(await panelRow.locator(".work-title").textContent(), "fix the gateway test");
    assert.equal(await panelRow.locator(".thread-name").textContent(), "🦦calm otter");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `nothing pushes the page sideways (${size})`);
    await shoot(page, `${size}-chat`);
  } finally {
    await page.close();
    await scripted.close();
  }
}
await browser.close();
assert.deepEqual(errors, [], "no script errors");
console.log("thread names browser: ok");
process.exit(0);
