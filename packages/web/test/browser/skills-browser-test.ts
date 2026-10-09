/** The skills settings page in a real browser against the real cubed, with a
 * local default source: the sources, the skills in effect with their
 * surface and provenance, skipped folders with their reason; a SKILL.md name
 * unlike its folder shown as the display name while the folder stays the id
 * that is disabled and saved; disabling and enabling a skill, kept over a
 * reload; a branch name and a URL with a token
 * refused without saving; checking the default source for an update (up to
 * date, a new exact commit with what it changes, cancel, a failed check,
 * confirming it, kept over a reload with the disabled skill); no sideways
 * scroll at 390px and 320px.
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
  "skills/poteto-mode/SKILL.md": "---\nname: Poteto Mode\ndescription: poteto's agent style.\n---\n",
  "skills/odd/SKILL.md": "---\nname: \"\"\ndescription: No name.\n---\n",
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
    `file://${root} @${source.commit.slice(0, 12)} /skills cube's default · pinned by this cube check for update`);
  assert.deepEqual(await names(page), ["briefing-a-thread", "poteto-mode", "prove-it-works"]);
  assert.deepEqual(await page.locator(".skills .skill .title").allTextContents(), ["Poteto Mode"], "only a SKILL.md name unlike its id is shown apart");
  assert.deepEqual(await page.locator(".skills .skill .tag").allTextContents(), ["chat (not read yet)", "threads", "threads"]);
  assert.match(await page.locator(".skills .skill .provenance").last().textContent() ?? "", new RegExp(`@${source.commit.slice(0, 12)} /skills/prove-it-works`));
  assert.match(await page.locator(".skipped").textContent() ?? "", /skills\/odd: SKILL.md name must be 1 to 64 characters/);
  await shoot(page, "desktop-skills");
  console.log("ok: the page shows the default source, each skill with its surface and provenance, and the skipped folder");

  await page.locator(".skill", { hasText: "prove-it-works" }).getByRole("button", { name: "disable" }).click();
  await page.locator(".disabled li", { hasText: "prove-it-works" }).waitFor();
  assert.deepEqual(await names(page), ["briefing-a-thread", "poteto-mode"]);
  await page.reload();
  await page.locator(".disabled li", { hasText: "prove-it-works" }).waitFor();
  assert.deepEqual(await names(page), ["briefing-a-thread", "poteto-mode"], "kept over a reload");
  await page.locator(".disabled li", { hasText: "prove-it-works" }).getByRole("button", { name: "enable" }).click();
  await page.locator(".skills .skill", { hasText: "prove-it-works" }).waitFor();
  assert.equal(await page.locator(".disabled").count(), 0);
  console.log("ok: disable and enable a skill, kept over a reload");

  const savedDisabled = async () => (await (await fetch(`${host.url}/api/settings/skills`)).json() as { saved: { disabled: string[] } }).saved.disabled;
  await page.locator(".skill", { hasText: "Poteto Mode" }).getByRole("button", { name: "disable" }).click();
  await page.locator(".disabled li", { hasText: "poteto-mode" }).waitFor();
  assert.deepEqual(await savedDisabled(), ["poteto-mode"], "the id is saved, not the display name");
  assert.deepEqual(await names(page), ["briefing-a-thread", "prove-it-works"]);
  await page.locator(".disabled li", { hasText: "poteto-mode" }).getByRole("button", { name: "enable" }).click();
  await page.locator(".skills .skill", { hasText: "Poteto Mode" }).waitFor();
  assert.deepEqual(await savedDisabled(), []);
  console.log("ok: a skill named \"Poteto Mode\" in poteto-mode/ shows its display name and is disabled by its id");

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

  // The default source's update: looked up as an exact commit, shown, and
  // saved only on confirmation; cancel and errors save nothing.
  const saved = async () => (await (await fetch(`${host.url}/api/settings/skills`)).json() as { saved: { defaultCommit?: string; disabled: string[] } }).saved;
  await page.getByRole("button", { name: "check for update" }).click();
  await page.locator(".update-status", { hasText: `up to date: main is at @${source.commit.slice(0, 12)}` }).waitFor();
  await page.locator(".update").getByRole("button", { name: "close" }).click();
  assert.equal(await page.locator(".update").count(), 0);

  fs.mkdirSync(path.join(root, "skills/new-skill"));
  fs.writeFileSync(path.join(root, "skills/new-skill/SKILL.md"), "---\nname: new-skill\ndescription: Added upstream.\n---\n");
  fs.rmSync(path.join(root, "skills/briefing-a-thread"), { recursive: true });
  git("add", "-A");
  git("commit", "-qm", "update");
  const next = git("rev-parse", "HEAD");
  await page.getByRole("button", { name: "check for update" }).click();
  await page.locator(".update code.candidate", { hasText: next }).waitFor();
  assert.match(await page.locator(".update-status").textContent() ?? "", new RegExp(`main is now at ${next}; in use: @${source.commit.slice(0, 12)}`));
  assert.deepEqual(await page.locator(".update-changes li").allTextContents(),
    ["new threads gain: new-skill", "new threads lose: briefing-a-thread", "from the new commit: poteto-mode, prove-it-works"]);
  await shoot(page, "desktop-skills-update");
  await page.locator(".update").getByRole("button", { name: "cancel" }).click();
  assert.equal(await page.locator(".update").count(), 0);
  assert.equal((await saved()).defaultCommit, undefined, "cancel saves nothing");
  assert.match(await page.locator(".default-source").textContent() ?? "", new RegExp(`@${source.commit.slice(0, 12)}`));
  console.log("ok: check for update shows the exact commit and what changes; up to date and cancel save nothing");

  fs.renameSync(root, `${root}-away`);
  await page.getByRole("button", { name: "check for update" }).click();
  await page.locator(".update-error", { hasText: `checking file://${root} for an update failed` }).waitFor();
  fs.renameSync(`${root}-away`, root);
  assert.equal((await saved()).defaultCommit, undefined, "a failed check saves nothing");

  await page.locator(".skill", { hasText: "prove-it-works" }).getByRole("button", { name: "disable" }).click();
  await page.locator(".disabled li", { hasText: "prove-it-works" }).waitFor();
  await page.getByRole("button", { name: "check for update" }).click();
  await page.locator(".update code.candidate", { hasText: next }).waitFor();
  await page.getByRole("button", { name: `use @${next.slice(0, 12)}` }).click();
  await page.locator(".default-source", { hasText: `@${next.slice(0, 12)}` }).waitFor();
  assert.match(await page.locator(".default-source .pin").textContent() ?? "", /commit chosen here/);
  assert.deepEqual(await names(page), ["new-skill", "poteto-mode"], "the new commit's skills, prove-it-works still disabled");
  await page.reload();
  await page.locator(".default-source", { hasText: `@${next.slice(0, 12)}` }).waitFor();
  assert.deepEqual(await saved(), { sources: [], disabled: ["prove-it-works"], defaultCommit: next }, "kept over a reload, with the disabled skill");
  await shoot(page, "desktop-skills-updated");
  console.log("ok: a failed check saves nothing; confirming pins the exact commit, keeps disabled skills and survives a reload");

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
    const small = await browser.newPage({ viewport });
    small.on("pageerror", error => errors.push(String(error)));
    await small.goto(`${host.url}/#/settings/skills`);
    await small.locator(".default-source").waitFor();
    await small.waitForTimeout(300);
    assert.ok(await noSideways(small), `no sideways scroll at ${viewport.width}px`);
    const fields = await small.locator(".add .field").evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().height)));
    assert.ok(fields.every(height => height < 90), `the form's fields keep their height on a phone: ${fields.join(", ")}`);
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
