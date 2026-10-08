/** Settings in a real browser against the real cubed: one header entry, a
 * rail of pages (model providers, chat memory, system) with the old
 * addresses landing on theirs; the chat memory page chooses the compactor,
 * saves it, keeps it over a reload and resets it to the chat's model; models
 * that cannot be listed; CUBED_OPTCHAT_COMPACTOR shown as no longer read; the
 * first-run setup offering the choice; no sideways scroll at phone width.
 * CUBE_SCREENSHOTS=<dir> keeps a picture of each state. Needs a built UI
 * (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const models = ["faux-chat", "faux-cheap", "faux-other"];
const desktop = { width: 1280, height: 800 }, phone = { width: 390, height: 844 };
const errors: string[] = [];
const browser = await chromium.launch();

async function page(viewport: { width: number; height: number }): Promise<Page> {
  const opened = await browser.newPage({ viewport });
  opened.on("pageerror", error => errors.push(String(error)));
  return opened;
}
/** From the chat, through the header's one settings entry and the rail. */
async function memoryPage(url: string, viewport: { width: number; height: number }): Promise<Page> {
  const opened = await page(viewport);
  await opened.goto(`${url}/#/chat`);
  await opened.locator(".composer textarea").waitFor();
  await opened.locator("header nav a", { hasText: "settings" }).click();
  await opened.waitForURL(/#\/settings\/providers$/);
  await opened.locator("h1", { hasText: "model providers" }).waitFor();
  await opened.getByRole("navigation", { name: "settings" }).getByRole("link", { name: "chat memory" }).click();
  await opened.waitForURL(/#\/settings\/memory$/);
  await opened.locator("h1", { hasText: "chat memory" }).waitFor();
  return opened;
}
const text = (opened: Page, name: string) => opened.locator(`.settings-board .${name}`).textContent();
const noSideways = (opened: Page) => opened.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth);

let host = await startChatHost({ models });
try {
  const view = await memoryPage(host.url, desktop);
  assert.equal(await view.title(), "chat memory · settings · cube");
  assert.equal(await view.locator("header nav a.active").textContent(), "settings");
  assert.deepEqual(await view.locator("header nav a").allTextContents(), ["chat", "threads", "artifacts", "projects", "settings"], "models and system are under settings");
  assert.equal(await view.locator(".settings-rail [aria-current=page] .rail-long").textContent(), "chat memory");
  await view.locator(".settings-board .chat-model").filter({ hasText: "faux/faux-chat" }).waitFor();
  assert.equal(await text(view, "compactor-model"), "faux/faux-chat");
  assert.match(await view.locator(".readout").textContent() ?? "", /follows the chat model/);
  const select = view.getByLabel("compactor");
  const save = view.getByRole("button", { name: "save" });
  assert.equal(await select.inputValue(), "", "follows the chat model");
  assert.deepEqual(await select.locator("option").allTextContents(), ["follow the chat model", ...models]);
  assert.ok(await save.isDisabled(), "nothing to save");
  await shoot(view, "desktop-memory-default");

  await select.selectOption({ label: "faux-cheap" });
  await save.click();
  await view.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();
  assert.equal(await text(view, "chat-model"), "faux/faux-chat", "the chat keeps its model");
  assert.match(await view.locator(".readout").textContent() ?? "", /chosen here/);
  assert.ok(await save.isDisabled());
  await shoot(view, "desktop-memory-saved");

  await view.reload();
  await view.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();
  assert.equal(JSON.parse(await select.inputValue()).id, "faux-cheap", "kept over a reload");

  // Models that cannot be listed are not missing: the saved one stays in use and is not marked.
  const getAvailable = host.models.getAvailable.bind(host.models);
  host.models.getAvailable = async () => { throw new Error("credential store unreadable"); };
  try {
    // The page's own poll reads it (a reload would fail earlier: /api/state lists the models too).
    await view.locator(".settings-board .notice", { hasText: "the models could not be listed: credential store unreadable" }).waitFor({ timeout: 15_000 });
    assert.equal(await text(view, "compactor-model"), "faux/faux-cheap");
    assert.deepEqual(await select.locator("option").allTextContents(), ["follow the chat model", "faux/faux-cheap"]);
    assert.equal(await view.getByText("no models are available").count(), 0, "not told to connect a provider");
    assert.ok(await save.isDisabled());
    await shoot(view, "desktop-memory-unlisted");
  } finally { host.models.getAvailable = getAvailable; }
  await view.reload();
  await view.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();

  await select.selectOption({ label: "follow the chat model" });
  await save.click();
  await view.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-chat" }).waitFor();

  // The rail's other pages, and the old addresses, which land on theirs.
  const rail = view.getByRole("navigation", { name: "settings" });
  await rail.getByRole("link", { name: "system" }).click();
  await view.waitForURL(/#\/settings\/system$/);
  await view.locator("h1", { hasText: "system" }).waitFor();
  await shoot(view, "desktop-system");
  await view.goto(`${host.url}/#/models`);
  await view.waitForURL(/#\/settings\/providers$/);
  await view.locator("h1", { hasText: "model providers" }).waitFor();
  assert.equal(await view.title(), "model providers · settings · cube");
  await shoot(view, "desktop-providers");
  await view.goto(`${host.url}/#/system`);
  await view.waitForURL(/#\/settings\/system$/);
  await view.locator("h1", { hasText: "system" }).waitFor();
  for (const address of ["#/settings", "#/settings/nonsense"]) {
    await view.goto(`${host.url}/${address}`);
    await view.waitForURL(/#\/settings\/providers$/);
    await view.locator("h1", { hasText: "model providers" }).waitFor();
  }

  // Between phone and desktop: the bank lies flat until a page's tables fit beside it.
  for (const width of [641, 680, 740, 900]) {
    const middle = await page({ width, height: 800 });
    for (const route of ["system", "memory", "providers"]) {
      await middle.goto(`${host.url}/#/settings/${route}`);
      await middle.locator(".settings-pane h1").waitFor();
      await middle.waitForTimeout(300);
      assert.ok(await noSideways(middle), `no sideways scroll at ${width}px (${route})`);
      assert.ok(await middle.locator(".settings-pane").evaluate(pane => pane.scrollWidth <= pane.clientWidth), `the ${route} page fits its pane at ${width}px`);
    }
    if (width === 740) await shoot(middle, "tablet-system");
    await middle.close();
  }

  for (const route of ["memory", "providers", "system"]) {
    const small = await page(phone);
    await small.goto(`${host.url}/#/settings/${route}`);
    await small.locator(".settings-pane h1").waitFor();
    await small.waitForTimeout(300);
    assert.ok(await noSideways(small), `no sideways scroll on a phone (${route})`);
    const keys = small.locator(".settings-rail .rail-item");
    const boxes = await keys.evaluateAll(items => items.map(item => item.getBoundingClientRect()).map(box => ({ top: Math.round(box.top), right: box.right })));
    assert.equal(new Set(boxes.map(box => box.top)).size, 1, "the rail is one row on a phone");
    assert.ok(boxes.every(box => box.right <= 390), "every page's key is on screen");
    if (route === "memory") {
      await small.locator(".settings-board .chat-model").filter({ hasText: "faux/faux-chat" }).waitFor();
      await small.getByLabel("compactor").selectOption({ label: "faux-other" });
    }
    await shoot(small, `phone-${route}`);
    await small.close();
  }
  // The narrowest phones: every header destination on screen in the menu, nothing sideways.
  const narrow = await page({ width: 320, height: 700 });
  await narrow.goto(`${host.url}/#/settings/memory`);
  await narrow.locator(".settings-pane h1").waitFor();
  await narrow.waitForTimeout(300);
  assert.ok(await noSideways(narrow), "no sideways scroll at 320px");
  await narrow.locator(".nav-menu-key").click();
  const links = await narrow.locator("header nav a").evaluateAll(items => items.map(item => item.getBoundingClientRect()).map(box => ({ left: box.left, right: box.right, width: box.width })));
  assert.ok(links.length === 5 && links.every(box => box.width > 0 && box.left >= 0 && box.right <= 320), `every header destination is on screen at 320px: ${JSON.stringify(links)}`);
  await shoot(narrow, "phone320-memory");
  await narrow.close();
  await view.close();
} finally {
  await host.close();
}

// The variable is no longer read: the page says so, and the choice here decides.
process.env.CUBED_OPTCHAT_COMPACTOR = "faux/faux-other";
host = await startChatHost({ models });
try {
  const view = await memoryPage(host.url, desktop);
  await view.locator(".settings-board .compactor-ignored").waitFor();
  assert.equal(await text(view, "compactor-model"), "faux/faux-chat");
  assert.match(await view.locator(".settings-board .compactor-ignored").textContent() ?? "", /no longer reads it/);
  await shoot(view, "desktop-memory-ignored");
  await view.close();
} finally {
  delete process.env.CUBED_OPTCHAT_COMPACTOR;
  await host.close();
}

// First-run setup offers the choice, following the chat's model unless changed.
host = await startChatHost({ models, setup: true });
try {
  for (const [viewport, name] of [[phone, "phone"], [desktop, "desktop"]] as const) {
    const setup = await page(viewport);
    await setup.goto(`${host.url}/`);
    await setup.getByRole("button", { name: "not now" }).click();
    const choice = setup.getByLabel("chat memory");
    await choice.waitFor();
    assert.equal(await choice.inputValue(), "", "the default follows the chat's model");
    assert.ok(await noSideways(setup), `no sideways scroll in setup (${name})`);
    await shoot(setup, `${name}-setup`);
    if (name === "desktop") {
      await choice.selectOption({ label: "faux/faux-cheap" });
      await setup.getByRole("button", { name: "open the chat" }).click();
      await setup.locator(".composer textarea").waitFor();
      const saved = await (await fetch(`${host.url}/api/settings`)).json();
      assert.deepEqual(saved.compactor.saved, { provider: "faux", id: "faux-cheap" }, "setup saved the choice");
    }
    await setup.close();
  }
} finally {
  await host.close();
  await browser.close();
}
assert.deepEqual(errors, [], "no script errors");
console.log("settings browser: ok");
process.exit(0);
