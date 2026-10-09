/** The skills settings page in a real browser against the real cubed, with a
 * local default source: the sources, the skills in effect with their
 * surface and provenance, skipped folders with their reason; disabling and
 * enabling a skill, kept over a reload; a branch name and a URL with a token
 * refused without saving; no sideways scroll at 390px and 320px.
 * CUBE_SCREENSHOTS=<dir> keeps a picture of each state. Needs a built UI
 * (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-skills-browser-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8" }).trim();
const files: Record<string, string> = {
  "skills/prove-it-works/SKILL.md": "---\nname: prove-it-works\ndescription: Check the real thing before reporting it done.\n---\n",
  "skills/briefing-a-thread/SKILL.md": "---\nname: briefing-a-thread\ndescription: Brief a new thread.\nmetadata:\n  cube:\n    surface: optchat\n---\n",
  "skills/odd/SKILL.md": "---\nname: other\ndescription: Mismatched.\n---\n",
};
for (const [file, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
git("init", "-q", "--initial-branch=main");
git("add", "-A");
git("commit", "-qm", "skills");
const source = { url: `file://${root}`, commit: git("rev-parse", "HEAD"), path: "skills" };

const errors: string[] = [];
const browser = await chromium.launch();
const host = await startChatHost({ skillSource: source });
const noSideways = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth);
const names = (page: Page) => page.locator(".skills .skill .name").allTextContents();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${host.url}/#/settings/providers`);
  await page.getByRole("navigation", { name: "settings" }).getByRole("link", { name: "skills" }).click();
  await page.waitForURL(/#\/settings\/skills$/);
  await page.locator(".skills .skill").first().waitFor();
  assert.equal(await page.title(), "skills · settings · cube");
  assert.equal(await page.locator(".default-source").textContent().then(text => text?.replace(/\s+/g, " ").trim()),
    `file://${root} @${source.commit.slice(0, 12)} /skills cube's default`);
  assert.deepEqual(await names(page), ["briefing-a-thread", "prove-it-works"]);
  assert.deepEqual(await page.locator(".skills .skill .tag").allTextContents(), ["chat (not read yet)", "threads"]);
  assert.match(await page.locator(".skills .skill .provenance").last().textContent() ?? "", new RegExp(`@${source.commit.slice(0, 12)} /skills/prove-it-works`));
  assert.match(await page.locator(".skipped").textContent() ?? "", /skills\/odd: SKILL.md names "other", not its folder odd/);
  await shoot(page, "desktop-skills");
  console.log("ok: the page shows the default source, each skill with its surface and provenance, and the skipped folder");

  await page.locator(".skill", { hasText: "prove-it-works" }).getByRole("button", { name: "disable" }).click();
  await page.locator(".disabled li", { hasText: "prove-it-works" }).waitFor();
  assert.deepEqual(await names(page), ["briefing-a-thread"]);
  await page.reload();
  await page.locator(".disabled li", { hasText: "prove-it-works" }).waitFor();
  assert.deepEqual(await names(page), ["briefing-a-thread"], "kept over a reload");
  await page.locator(".disabled li", { hasText: "prove-it-works" }).getByRole("button", { name: "enable" }).click();
  await page.locator(".skills .skill", { hasText: "prove-it-works" }).waitFor();
  assert.equal(await page.locator(".disabled").count(), 0);
  console.log("ok: disable and enable a skill, kept over a reload");

  await page.getByLabel("repository url").fill("https://github.com/me/skills");
  await page.getByLabel("commit").fill("main");
  await page.getByRole("button", { name: "add" }).click();
  await page.locator(".save-error", { hasText: "full 40-character commit, not a branch or tag" }).waitFor();
  await page.getByLabel("repository url").fill("https://me:ghp_secret@github.com/me/skills");
  await page.getByLabel("commit").fill(source.commit);
  await page.getByRole("button", { name: "add" }).click();
  await page.locator(".save-error", { hasText: "must not carry credentials" }).waitFor();
  assert.doesNotMatch(await page.locator(".save-error").textContent() ?? "", /ghp_secret/);
  assert.equal(await page.locator(".user-source").count(), 0, "nothing was added");
  assert.equal(await page.getByLabel("commit").inputValue(), source.commit, "the form keeps what was typed");
  await shoot(page, "desktop-skills-refused");
  console.log("ok: a branch name and a URL with a token are refused, nothing is saved, the form keeps its input");

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
    const small = await browser.newPage({ viewport });
    small.on("pageerror", error => errors.push(String(error)));
    await small.goto(`${host.url}/#/settings/skills`);
    await small.locator(".skills .skill").first().waitFor();
    await small.waitForTimeout(300);
    assert.ok(await noSideways(small), `no sideways scroll at ${viewport.width}px`);
    const keys = await small.locator(".settings-rail .rail-item").evaluateAll(items => items.map(item => item.getBoundingClientRect()).map(box => ({ top: Math.round(box.top), right: box.right })));
    assert.equal(new Set(keys.map(key => key.top)).size, 1, "the rail is one row");
    assert.ok(keys.every(key => key.right <= viewport.width), `every key is on screen at ${viewport.width}px`);
    await shoot(small, `phone${viewport.width}-skills`);
    await small.close();
  }
  console.log("ok: no sideways scroll at 390px and 320px; the rail keeps its keys in one row");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await host.close();
  fs.rmSync(root, { recursive: true, force: true });
}
