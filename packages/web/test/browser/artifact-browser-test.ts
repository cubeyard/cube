/** Work artifacts in a real browser against the real cubed: OptChat writes a
 * post-merge review (show-me style, with hostile content an agent might
 * quote), a Pi thread writes notes over a local guest. The user opens the
 * review from the chat, selects text and comments, sends comments to the
 * chat and to a working thread (they wait until its turn ends), reads an
 * older revision, and confirms a merge after it is refused for a moved head.
 * Faux model and fake GitHub; disposable state. Screenshots go to
 * CUBE_SCREENSHOTS when it is set. Needs a built UI and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright";
import { startArtifactHost } from "../../../server/test/artifact-host.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const { url, api, pull, merges, threadPrompts, releaseHold, SHA, close } = await startArtifactHost({ web: path.resolve(import.meta.dirname, "../../dist") });
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + 30_000; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 1500)}`);
    await delay(100);
  }
  return value;
}
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** Selects `text` (its first occurrence) in the document, as a drag would. */
async function select(page: Page, text: string): Promise<void> {
  await page.evaluate(wanted => {
    const article = document.querySelector("article.artifact-body")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0) continue;
      node.parentElement!.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no text ${wanted}`);
  }, text);
}
async function comment(page: Page, text: string, body: string): Promise<void> {
  await select(page, text);
  await page.locator(".artifact-select-key").click();
  await page.locator(".comment-composer textarea").fill(body);
  await page.locator(".comment-composer button[type=submit]").click();
  await page.locator(".comment-item.draft", { hasText: body }).waitFor();
}

const browser = await chromium.launch();
const dialogs: string[] = [];
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  page.on("pageerror", error => errors.push(String(error)));
  const project = (await api("/api/projects")).projects.find((item: { name: string }) => item.name === "demo");
  const thread = (await api("/api/threads", { projectId: project.id, requestId: "notes", text: "publish the notes" })).id as string;

  // The chat writes the review; its reply links it, and the panel lists it.
  await page.goto(`${url}/#/chat`);
  await page.locator(".composer textarea").fill("please write the review of the work artifacts pull request");
  await page.locator(".composer textarea").press("Enter");
  const link = page.locator(".conversation-message a", { hasText: "post-merge review" });
  await link.waitFor({ timeout: 30_000 });
  // The thread's notes were written meanwhile; the panel lists both after a reload.
  await until(() => api("/api/artifacts"), value => value.artifacts.length === 2, "the thread's notes");
  await page.reload();
  await page.locator(".work-artifacts a.work-title", { hasText: "machine notes" }).waitFor({ timeout: 30_000 });
  await shoot(page, "01-chat-desktop");

  await link.click();
  await page.locator("article.artifact-body h1", { hasText: "post-merge review" }).waitFor();
  await page.locator(".diagram-picture img").first().waitFor({ timeout: 30_000 });
  await until(async () => page.locator(".diagram-picture[aria-busy]").count(), count => count === 0, "every diagram drawn");
  // Hostile content is inert: no script, no image fetch, no javascript link.
  const inert = await page.evaluate(() => ({
    pwned: (window as { __pwned?: boolean }).__pwned ?? false,
    scripts: document.querySelectorAll("article.artifact-body script").length,
    images: [...document.querySelectorAll("article.artifact-body img")].map(image => (image as HTMLImageElement).src.slice(0, 26)),
    javascript: [...document.querySelectorAll("article.artifact-body a")].filter(anchor => anchor.getAttribute("href")?.startsWith("javascript")).length,
    chatLink: document.querySelector("article.artifact-body a[href='#/chat']")?.getAttribute("target") ?? "none",
    external: document.querySelector("article.artifact-body a[href^='https://github.com']")?.getAttribute("rel"),
    escaped: document.querySelector("article.artifact-body")!.textContent!.includes("<script>window.__pwned = true</script>"),
  }));
  assert.deepEqual(inert, { pwned: false, scripts: 0, images: ["data:image/svg+xml;charset", "data:image/svg+xml;charset"], javascript: 0, chatLink: "none", external: "noopener noreferrer", escaped: true });
  await shoot(page, "02-review-desktop");
  await page.locator(".artifact-diagram").first().scrollIntoViewIfNeeded();
  await shoot(page, "03-review-diagram");

  // Two comments on selections, then sent to the chat as one message.
  await comment(page, "the store keeps every revision", "Say what happens to comments on an older revision.");
  await comment(page, "newest revision only", "Why only the newest? Explain in one line.");
  await page.locator("mark.anchor.draft, mark.anchor").first().waitFor();
  await shoot(page, "04-review-drafts");
  await page.locator(".comment-send").click();
  await page.locator(".comment-sent .comment-foot", { hasText: "sent to optchat" }).first().waitFor({ timeout: 30_000 });
  await shoot(page, "05-review-sent");
  const chat = await until(() => api("/api/optchat/history"), value => JSON.stringify(value).includes("Got your comments"), "the chat answers the comments");
  const delivered = (chat.events as Array<{ type: string; text?: string }>).find(event => event.type === "user-message" && event.text?.startsWith("[artifact "))!.text!;
  assert.match(delivered, /> the store keeps every revision/);
  assert.match(delivered, /comment: Why only the newest\?/);

  // The thread's notes: a comment waits while the thread works.
  const notes = (await api("/api/artifacts")).artifacts.find((item: { title: string }) => item.title === "machine notes");
  await api(`/api/threads/${thread}/prompt`, { text: "hold until released", requestId: "hold" });
  await until(() => api(`/api/threads/${thread}/history`), value => value.status?.state === "working", "the thread works");
  await page.goto(`${url}/#/a/${notes.id}`);
  await page.locator("article.artifact-body h1", { hasText: "machine notes" }).waitFor();
  await comment(page, "every command as agent", "Is the helper really root? Say why in the notes.");
  await page.locator(".comment-send").click();
  await page.locator(".comment-sent .comment-foot", { hasText: "thread is working" }).waitFor({ timeout: 30_000 });
  assert.equal(threadPrompts.filter(prompt => prompt.includes("[artifact ")).length, 0, "nothing interrupts a working thread");
  await shoot(page, "06-notes-waiting");
  releaseHold();
  await page.locator(".comment-sent .comment-foot", { hasText: "sent to thread" }).waitFor({ timeout: 30_000 });
  await until(async () => threadPrompts.filter(prompt => prompt.includes("[artifact ")).length, count => count === 1, "the thread gets the comment once");
  await page.goto(`${url}/#/t/${thread}`);
  await page.getByText("Thanks: the guest is the thread's own VM").waitFor({ timeout: 30_000 });
  await shoot(page, "07-thread-received");

  // A new revision: the old comments are found in it; the old revision reads as older.
  await page.goto(`${url}/#/chat`);
  await page.locator(".composer textarea").fill(`please revise the review ${(await api("/api/artifacts")).artifacts.find((item: { title: string }) => item.title.startsWith("post-merge")).id}`);
  await page.locator(".composer textarea").press("Enter");
  const review = await until(() => api("/api/artifacts"), value => value.artifacts.some((item: { head: number }) => item.head === 2), "revision 2");
  const reviewId = review.artifacts.find((item: { head: number }) => item.head === 2).id;
  await page.goto(`${url}/#/a/${reviewId}`);
  await page.locator(".comment-foot", { hasText: "on revision 1; found here" }).first().waitFor();
  await page.goto(`${url}/#/a/${reviewId}?rev=1`);
  await page.locator(".strip-note", { hasText: "revision 1 of 2" }).waitFor();
  await shoot(page, "08-older-revision");

  // The merge: refused while the head has moved, then confirmed once.
  await page.goto(`${url}/#/a/${reviewId}`);
  await page.locator(".artifact-provenance", { hasText: "revision 2" }).waitFor();
  pull.headSha = "0".repeat(40);
  await page.locator(".artifact-action button").click();
  await page.locator(".action-problems", { hasText: "head is now" }).waitFor();
  assert.equal(await page.locator(".action-footer .key.primary").isDisabled(), true);
  await shoot(page, "09-merge-refused");
  pull.headSha = SHA;
  await page.locator(".action-footer button", { hasText: "check again" }).click();
  await page.locator(".action-status", { hasText: "checked just now" }).waitFor();
  await shoot(page, "10-merge-confirm");
  await page.locator(".action-footer .key.primary").click();
  await page.locator(".action-done", { hasText: "merged cubeyard/demo#7" }).waitFor();
  assert.deepEqual(merges, [SHA]);
  await shoot(page, "11-merged");
  await page.locator(".action-footer button", { hasText: "close" }).click();
  await page.locator(".artifact-action button", { hasText: "done" }).waitFor();

  // The phone: the document first, its comments below, the chat with its panel.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", error => errors.push(String(error)));
  await phone.goto(`${url}/#/a/${reviewId}`);
  await phone.locator(".diagram-picture img").first().waitFor({ timeout: 30_000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  await shoot(phone, "12-review-phone");
  await phone.goto(`${url}/#/artifacts`);
  await phone.locator(".artifact-list li").first().waitFor();
  await shoot(phone, "13-list-phone");
  await phone.goto(`${url}/#/chat`);
  await phone.locator(".composer textarea").waitFor();
  await shoot(phone, "14-chat-phone");

  // The black edition: diagrams are drawn with mermaid's dark theme.
  const night = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  night.on("pageerror", error => errors.push(String(error)));
  await night.goto(`${url}/#/a/${reviewId}`);
  await night.locator(".diagram-picture img").first().waitFor({ timeout: 30_000 });
  await night.locator(".artifact-diagram").first().scrollIntoViewIfNeeded();
  await shoot(night, "15-review-dark");

  assert.deepEqual(dialogs, [], "nothing in a document opened a dialog");
  assert.deepEqual(errors, [], "no page errors");
  console.log("ok: artifacts in the browser: review from the chat, inert hostile content, diagrams, selection comments to the chat and to a working thread, older revision, merge refused then confirmed once, phone layout");
} finally {
  await browser.close();
  await close();
}
