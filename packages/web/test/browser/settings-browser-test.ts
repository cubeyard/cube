/** The settings page in a real browser against the real cubed: reached from
 * the header, the compactor chosen, saved, kept over a reload and reset to
 * the chat's model; CUBED_OPTCHAT_COMPACTOR shown as winning; no sideways
 * scroll at phone width. CUBE_SCREENSHOTS=<dir> keeps a picture of each
 * state. Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const models = ["faux-chat", "faux-cheap", "faux-other"];
const errors: string[] = [];
const browser = await chromium.launch();

async function open(url: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${url}/#/chat`);
  await page.locator(".composer textarea").waitFor();
  await page.locator("header nav a", { hasText: "settings" }).click();
  await page.waitForURL(/#\/settings$/);
  await page.locator("h1", { hasText: "settings" }).waitFor();
  return page;
}
const text = (page: Page, name: string) => page.locator(`.settings-board .${name}`).textContent();
const noSideways = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth);
/** The header's link to this page is on screen, not scrolled out of its row. */
const linkInSight = (page: Page) => page.locator("header nav a.active").evaluate(link => {
  const box = link.getBoundingClientRect(), row = link.parentElement!.getBoundingClientRect();
  return box.left >= row.left - 1 && box.right <= row.right + 1 && box.right <= window.innerWidth;
});

let host = await startChatHost({ models });
try {
  const page = await open(host.url, { width: 1280, height: 800 });
  assert.equal(await page.title(), "settings · cube");
  assert.equal(await page.locator("header nav a.active").textContent(), "settings");
  await page.locator(".settings-board .chat-model").filter({ hasText: "faux/faux-chat" }).waitFor();
  assert.equal(await text(page, "compactor-model"), "faux/faux-chat");
  assert.match(await page.locator(".readout").textContent() ?? "", /follows the chat model/);
  const select = page.getByLabel("compactor");
  const save = page.getByRole("button", { name: "save" });
  assert.equal(await select.inputValue(), "", "follows the chat model");
  assert.deepEqual(await select.locator("option").allTextContents(), ["follow the chat model", ...models]);
  assert.ok(await save.isDisabled(), "nothing to save");
  await shoot(page, "desktop-default");

  await select.selectOption({ label: "faux-cheap" });
  assert.ok(await save.isEnabled());
  await save.click();
  await page.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();
  assert.equal(await text(page, "chat-model"), "faux/faux-chat", "the chat keeps its model");
  assert.match(await page.locator(".readout").textContent() ?? "", /saved here/);
  assert.ok(await save.isDisabled());
  await shoot(page, "desktop-saved");

  await page.reload();
  await page.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();
  assert.equal(JSON.parse(await select.inputValue()).id, "faux-cheap", "kept over a reload");

  // Models that cannot be listed are not missing: the saved one stays in use and is not marked.
  const getAvailable = host.models.getAvailable.bind(host.models);
  host.models.getAvailable = async () => { throw new Error("credential store unreadable"); };
  try {
    // The page's own poll reads it (a reload would fail earlier: /api/state lists the models too).
    await page.locator(".settings-board .notice", { hasText: "the models could not be listed: credential store unreadable" }).waitFor({ timeout: 15_000 });
    assert.equal(await text(page, "compactor-model"), "faux/faux-cheap");
    assert.deepEqual(await select.locator("option").allTextContents(), ["follow the chat model", "faux/faux-cheap"]);
    assert.equal(JSON.parse(await select.inputValue()).id, "faux-cheap");
    assert.equal(await page.getByText("no models are available").count(), 0, "not told to connect a provider");
    assert.ok(await save.isDisabled());
    await shoot(page, "desktop-unlisted");
  } finally { host.models.getAvailable = getAvailable; }
  await page.reload();
  await page.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-cheap" }).waitFor();

  await select.selectOption({ label: "follow the chat model" });
  await save.click();
  await page.locator(".settings-board .compactor-model").filter({ hasText: "faux/faux-chat" }).waitFor();
  assert.match(await page.locator(".readout").textContent() ?? "", /follows the chat model/);

  const phone = await open(host.url, { width: 390, height: 844 });
  await phone.locator(".settings-board .chat-model").filter({ hasText: "faux/faux-chat" }).waitFor();
  assert.ok(await noSideways(phone), "no sideways scroll on a phone");
  for (let i = 0; !await linkInSight(phone); i++) { assert.ok(i < 40, "the settings link is in sight on a phone"); await phone.waitForTimeout(50); }
  await phone.getByLabel("compactor").selectOption({ label: "faux-other" });
  await shoot(phone, "phone-choosing");
  await phone.close();
  await page.close();
} finally {
  await host.close();
}

// The variable wins; the page says so and keeps the saved choice for later.
process.env.CUBED_OPTCHAT_COMPACTOR = "faux/faux-other";
host = await startChatHost({ models });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await open(host.url, viewport);
    await page.locator(".settings-board .compactor-override").waitFor();
    assert.equal(await text(page, "compactor-model"), "faux/faux-other");
    assert.match(await page.locator(".readout").textContent() ?? "", /from CUBED_OPTCHAT_COMPACTOR/);
    assert.match(await page.locator(".settings-board .compactor-override").textContent() ?? "", /wins over the choice saved here/);
    assert.ok(await noSideways(page), `no sideways scroll at ${viewport.width}px`);
    await shoot(page, `${viewport.width < 600 ? "phone" : "desktop"}-environment`);
    await page.close();
  }
} finally {
  delete process.env.CUBED_OPTCHAT_COMPACTOR;
  await host.close();
  await browser.close();
}
assert.deepEqual(errors, [], "no script errors");
console.log("settings browser: ok");
process.exit(0);
