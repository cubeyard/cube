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
const { url, api, pull, merges, control, threadPrompts, releaseHold, SHA, close } = await startArtifactHost({ web: path.resolve(import.meta.dirname, "../../dist") });
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
/** The comment key under a selection of `text`: a mouse press near its edge
 * leaves it in place (it sinks a pixel), keeps the selection and opens the
 * composer on that text; a tap does too (a tap's click reaches the key even
 * if it moved, so only the mouse shows a jump). It follows the selection when
 * the document scrolls. Leaves no comment behind. */
async function steadyKey(page: Page, text: string, shot: string, touch = false): Promise<void> {
  await select(page, text);
  const key = page.locator(".artifact-select-key");
  await key.waitFor();
  // Read the key once it is drawn and the document has scrolled to the selection.
  await delay(200);
  const at = (await key.boundingBox())!;
  const below = await page.evaluate(() => document.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom);
  assert.ok(Math.abs(at.y - (below + 8)) <= 1, `the key sits under the selection (${at.y} vs ${below + 8})`);
  if (touch) {
    await shoot(page, shot);
    await page.touchscreen.tap(at.x + at.width * 0.15, at.y + at.height / 2);
  } else {
    await page.mouse.move(at.x + at.width * 0.15, at.y + at.height / 2);
    await page.mouse.down();
    await delay(200);
    const pressed = (await key.boundingBox())!;
    assert.ok(Math.abs(pressed.x - at.x) <= 0.5 && pressed.y - at.y >= 0 && pressed.y - at.y <= 1.5, `the pressed key stays put: ${JSON.stringify({ at, pressed })}`);
    assert.equal(await page.evaluate(() => document.getSelection()?.toString()), text, "pressing keeps the selection");
    await shoot(page, shot);
    await page.mouse.up();
  }
  await page.locator(".comment-composer .work-quote", { hasText: text }).waitFor({ timeout: 5_000 });
  await page.locator(".comment-composer button", { hasText: "cancel" }).click();
  // Scrolled, the key follows the selection.
  await select(page, text);
  await key.waitFor();
  await page.locator(".artifact-scroll").evaluate(scroller => { scroller.scrollTop += 60; });
  await until(async () => {
    const [box, bottom] = await Promise.all([key.boundingBox(), page.evaluate(() => document.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom)]);
    return Math.abs(box!.y - (bottom + 8));
  }, gap => gap <= 1, "the key follows the scrolled selection");
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await key.waitFor({ state: "detached" });
}
/** How far the comment key is from its place: under the selection, kept in
 * the document's view, and gone while the selection is out of it. 9999: a
 * key with no selection, a missing key, or one over text out of view. */
const keyGap = (page: Page) => page.evaluate(() => {
  const key = document.querySelector(".artifact-select-key")?.getBoundingClientRect();
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return 9999;
  const field = document.querySelector(".artifact-scroll")!.getBoundingClientRect();
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.bottom < field.top || rect.top > field.bottom) return key ? 9999 : 0;
  if (!key) return 9999;
  return Math.max(Math.abs(key.top - Math.min(Math.max(rect.bottom + 8, field.top + 8), field.bottom - 52)),
    Math.abs(key.left + key.width / 2 - Math.min(Math.max(rect.left + rect.width / 2, 60), innerWidth - 60)));
});
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

  await steadyKey(page, "Threads", "03a-comment-key-pressed");

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
  // A comment being written keeps its revision on screen while a newer one arrives.
  await page.goto(`${url}/#/a/${notes.id}`);
  await page.locator("article.artifact-body h1", { hasText: "machine notes" }).waitFor();
  await select(page, "The guest runs the helper as root");
  await page.locator(".artifact-select-key").click();
  await page.locator(".comment-composer textarea").fill("Name the helper.");
  await api(`/api/threads/${thread}/prompt`, { text: `publish the notes again ${notes.id}`, requestId: "again" });
  await until(() => api(`/api/artifacts/${notes.id}`), value => value.artifact.head === 2, "the thread's second revision");
  await page.locator(".strip-note", { hasText: "revision 1 of 2" }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("article.artifact-body", { hasText: "A newer revision" }).count(), 0, "the document did not change under the composer");
  await shoot(page, "07a-composing-pinned");
  await page.locator(".comment-composer button[type=submit]").click();
  await page.locator(".comment-item.draft", { hasText: "Name the helper." }).waitFor();
  const kept = (await api(`/api/artifacts/${notes.id}`)).comments.find((item: { body: string }) => item.body === "Name the helper.");
  assert.equal(kept.revision, 1, "the comment keeps the revision it was written on");
  assert.equal(kept.anchor.quote, "The guest runs the helper as root");
  // Saved, the page stays on that revision; "newest" then shows the newer one.
  await page.locator(".strip-note", { hasText: "revision 1 of 2" }).waitFor();
  await page.locator(".strip-note a", { hasText: "newest" }).click();
  await page.locator("article.artifact-body", { hasText: "A newer revision" }).waitFor();
  await page.goto(`${url}/#/t/${thread}`);
  await page.getByText("Thanks: the guest is the thread's own VM").waitFor({ timeout: 30_000 });
  await shoot(page, "07-thread-received");

  // A new revision: the old comments are found in it; the old revision reads as older.
  await page.goto(`${url}/#/chat`);
  await page.locator(".composer textarea").fill(`please revise the review ${(await api("/api/artifacts")).artifacts.find((item: { title: string }) => item.title.startsWith("post-merge")).id}`);
  await page.locator(".composer textarea").press("Enter");
  const isReview = (item: { title: string; head: number }) => item.title.startsWith("post-merge") && item.head === 2;
  const review = await until(() => api("/api/artifacts"), value => value.artifacts.some(isReview), "revision 2");
  const reviewId = review.artifacts.find(isReview).id;
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
  // GitHub fails once: the failure shows, nothing is marked done, and a second press merges.
  control.failMerge = true;
  await page.locator(".action-footer .key.primary").click();
  await page.locator(".action-problems", { hasText: "could not reach github" }).waitFor();
  assert.equal(await page.locator(".action-done").count(), 0);
  await shoot(page, "10a-merge-failed");
  await page.locator(".action-status", { hasText: "checked just now" }).waitFor();
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
  await until(async () => phone.locator(".diagram-picture[aria-busy]").count(), count => count === 0, "every diagram drawn on the phone");
  await steadyKey(phone, "the store keeps every revision", "12a-comment-key-phone", true);
  await phone.goto(`${url}/#/artifacts`);
  await phone.locator(".artifact-list li").first().waitFor();
  await shoot(phone, "13-list-phone");
  await phone.goto(`${url}/#/chat`);
  await phone.locator(".composer textarea").waitFor();
  await shoot(phone, "14-chat-phone");

  // The document moves under a selection without a scroll: diagrams drawn
  // late (mermaid held back, as on a slow first load), a resized window, and
  // the comments panel growing on a phone. The key moves with the text.
  async function lateDiagrams(viewport: { width: number; height: number }, mobile: boolean, shot: string): Promise<Page> {
    const late = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
    late.on("pageerror", error => errors.push(String(error)));
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    await late.route(/mermaid\.core-[^/]*\.js$/, async route => { await held; await route.continue(); });
    await late.goto(`${url}/#/a/${reviewId}`);
    await late.locator("article.artifact-body h1").waitFor();
    // No scroll anchoring, so no scroll event moves the key in its stead.
    await late.addStyleTag({ content: ".artifact-scroll { overflow-anchor: none; }" });
    await select(late, "the store keeps every revision");
    // The selection high in the view, so the text moved by the diagrams stays in it.
    await late.locator(".artifact-scroll").evaluate(scroller => {
      scroller.scrollTop += document.getSelection()!.getRangeAt(0).getBoundingClientRect().top - scroller.getBoundingClientRect().top - 60;
    });
    await late.locator(".artifact-select-key").waitFor();
    assert.ok(await late.locator(".diagram-picture[aria-busy]").count() > 0, "the text is selected before the diagrams are drawn");
    await until(() => keyGap(late), gap => gap <= 1, "the key under the selection");
    const top = () => late.evaluate(() => document.getSelection()!.getRangeAt(0).getBoundingClientRect().top);
    const from = await top();
    await shoot(late, `${shot}a-diagrams-pending`);
    release();
    await until(async () => late.locator(".diagram-picture[aria-busy]").count(), count => count === 0, "the late diagrams drawn");
    await until(top, at => at > from + 50, "the drawn diagrams move the selected text");
    await until(() => keyGap(late), gap => gap <= 1, "the key follows the text the diagrams moved, or leaves while it is out of view");
    await shoot(late, `${shot}b-diagrams-drawn`);
    // Back in view, the key is under it again.
    await late.evaluate(() => document.getSelection()!.getRangeAt(0).startContainer.parentElement!.scrollIntoView({ block: "center" }));
    await late.locator(".artifact-select-key").waitFor();
    await until(() => keyGap(late), gap => gap <= 1, "the key under the selection scrolled back");
    await shoot(late, `${shot}c-scrolled-back`);
    return late;
  }
  const wide = await lateDiagrams({ width: 1440, height: 900 }, false, "16");
  for (const width of [1000, 700]) {
    await wide.setViewportSize({ width, height: 800 });
    await until(() => keyGap(wide), gap => gap <= 1, `the key follows the text reflowed at ${width}px, or leaves while it is out of view`);
  }
  await shoot(wide, "16d-resized");
  await wide.close();
  const narrow = await lateDiagrams({ width: 390, height: 844 }, true, "17");
  // The selection near the foot of the document's view; then a new comment
  // grows the comments panel below it, and the view shrinks.
  await narrow.locator(".artifact-scroll").evaluate(scroller => {
    const bottom = document.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom;
    scroller.scrollTop += bottom - (scroller.getBoundingClientRect().bottom - 30);
  });
  await until(() => keyGap(narrow), gap => gap <= 1, "the key under the scrolled selection");
  const foot = async () => narrow.locator(".artifact-scroll").evaluate(scroller => scroller.getBoundingClientRect().bottom);
  // Selected backwards, as a drag from the end does; it keeps that direction.
  const backward = () => narrow.evaluate(() => {
    const selection = document.getSelection()!;
    const range = selection.getRangeAt(0);
    return selection.toString() !== "" && selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
  });
  await narrow.evaluate(() => {
    const selection = document.getSelection()!;
    const range = selection.getRangeAt(0);
    selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
  });
  assert.equal(await backward(), true, "selected backward");
  const before = await foot();
  await comment(page, "newest revision only", "A draft that grows the phone's panel.");
  await narrow.locator(".comment-item.draft").waitFor({ timeout: 15_000 });
  assert.ok(await foot() < before - 20, "the panel grew into the document's view");
  await until(() => keyGap(narrow), gap => gap <= 1, "the key stays in the view the panel shrank");
  assert.equal(await narrow.evaluate(() => document.getSelection()!.toString()), "the store keeps every revision", "the new comment's marks keep the selection");
  assert.equal(await backward(), true, "the kept selection keeps its direction");
  await shoot(narrow, "17d-panel-grown");
  await page.locator(".comment-item.draft .work-dismiss").click();
  await page.locator(".comment-item.draft").waitFor({ state: "detached" });
  await narrow.close();

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
