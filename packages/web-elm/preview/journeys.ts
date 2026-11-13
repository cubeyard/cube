/** Drives the Elm prototype the way a user does, against a preview host of
 * its own (preview/host.ts: real cubed, scripted model, no VM), and keeps
 * screenshots and a step log.
 *
 * node packages/web-elm/preview/journeys.ts --out DIR [--port N] */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "../../web/node_modules/playwright";

const { chromium } = await import(path.resolve(import.meta.dirname, "../../web/node_modules/playwright/index.mjs")) as typeof import("../../web/node_modules/playwright");
const { values } = parseArgs({ options: { out: { type: "string" }, port: { type: "string" } } });
if (!values.out) throw new Error("usage: journeys.ts --out DIR [--port N]");
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
const port = Number(values.port ?? 7811);
const url = `http://127.0.0.1:${port}`;
const scratch = path.join(os.tmpdir(), `elm-journeys-${Date.now()}`);

const log: string[] = [];
const step = (text: string) => { log.push(text); console.log(text); };
let shots = 0;
const shot = async (page: Page, name: string) => {
  const file = `${String(++shots).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(out, file) });
  step(`  shot ${file}`);
};

const host = spawn("node", [path.join(import.meta.dirname, "host.ts"), "--scratch", scratch, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve, reject) => {
  host.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready ")) resolve(); });
  host.once("exit", code => reject(new Error(`the preview host exited with ${code}`)));
});
const api = async (route: string) => (await fetch(`${url}${route}`)).json() as Promise<any>;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
const watch = (page: Page) => { page.on("pageerror", error => errors.push(error.message)); return page; };
const page = watch(await context.newPage());

const row = (target: Page, id: string) => target.locator(`.bays a.card[data-thread="${id}"]`);
const inGroup = (target: Page, state: string, id: string) => target.locator(`.bays a.card.${state}[data-thread="${id}"]`);
const phase = async (target: Page, id: string) => row(target, id).getAttribute("data-phase");
async function newThread(target: Page, project: string, text: string): Promise<string> {
  await target.goto(`${url}/#/`);
  await target.locator("#desk-target option", { hasText: `a new thread in ${project}` }).waitFor({ state: "attached" });
  await target.locator("#desk-target").selectOption({ label: `a new thread in ${project}` });
  await target.locator("#desk").fill(text);
  await target.getByRole("button", { name: "start thread" }).click();
  await target.waitForURL(/#\/t\//);
  return decodeURIComponent(target.url().split("#/t/")[1]!);
}

let failed: unknown = null;
try {
  step("journey: run-state comprehension (synthetic rows, labeled)");
  await page.goto(`${url}/#/`);
  await row(page, "syn-working").waitFor();
  for (const [id, group, words] of [["syn-working", "working", "working"], ["syn-background", "working", "background work"], ["syn-reported", "foryou", "turn ended · unread"],
    ["syn-failed", "failed", "machine failed"], ["syn-run-failed", "failed", "run failed"], ["syn-unreachable", "failed", "machine failed"],
    ["syn-starting", "readying", "starting machine"], ["syn-queued", "readying", "waiting for a slot"]] as const) {
    await inGroup(page, group, id).waitFor();
    assert.equal(await phase(page, id), words);
    step(`  ${id}: in "${group}", says "${words}"`);
  }
  assert.match(await row(page, "syn-working").locator(".card-doing").innerText(), /^(bash|edit|writing|read)/);
  assert.match(await row(page, "syn-queued").locator(".card-doing").innerText(), /no free slot/);
  assert.match(await row(page, "syn-starting").locator(".card-doing").innerText(), /build-prepare/);
  assert.match(await page.locator(".banner.preview").innerText(), /preview instance/);
  assert.match(await page.locator('.bay[data-runner="mac-synthetic"]').innerText(), /not answering for 10 d/i);
  assert.equal(await page.locator('.bay[data-runner="server-synthetic"] .slots a.card').count(), 6, "six cards hold the six slots of server-synthetic");
  assert.equal(await page.locator('.bay[data-runner="server-synthetic"] .shelf a.card').count(), 2, "one queued and one suspended card sit under the slots");
  assert.equal(await page.locator('.bay[data-runner="preview-local"] .slot.free').count(), 4);
  assert.equal(await page.locator(".tray a.tray-item").count(), 5);
  step("  bays: server-synthetic holds 6 cards in 6 slots, 1 queued, 1 suspended; preview-local shows 4 free slots; mac-synthetic says it is not answering");
  step(`  tally: ${(await page.locator(".tally").innerText()).replace(/\n/g, " · ")}; title: ${await page.title()}`);
  await shot(page, "floor-desktop");

  step("journey: a real thread, from start to read (project demo, scripted model, real shell commands)");
  const work = await newThread(page, "demo", "demo work");
  await page.locator(".strip .state", { hasText: "working" }).waitFor({ timeout: 30000 });
  await page.locator('.work.live .step[data-tool="bash"]').first().waitFor();
  step(`  thread ${work} is working; its live step shows`);
  await shot(page, "thread-working");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForURL(/#\/$/);
  await inGroup(page, "working", work).waitFor();
  const doing = await row(page, work).locator(".card-doing").innerText();
  assert.match(doing, /bash/);
  step(`  on the floor its card is blue in the preview-local bay and says: ${doing}`);
  await shot(page, "floor-real-working");
  await inGroup(page, "foryou", work).waitFor({ timeout: 60000 });
  await page.locator(`.tray a[data-tray="${work}"]`).waitFor();
  assert.equal(await phase(page, work), "turn ended · unread");
  step("  its turn ended while it was not open: its card turned yellow and it is listed under For you");
  const note = path.join(scratch, "machines", work, "workspace", "preview-note.txt");
  assert.ok(fs.existsSync(note), `the scripted command wrote ${note}`);
  step("  side effect: preview-note.txt exists in the thread's workspace on disk");
  await row(page, work).click();
  await page.locator(".message.assistant", { hasText: "Done (scripted)" }).waitFor();
  await page.locator(".step", { hasText: "cat README.md" }).locator("summary").click();
  assert.match(await page.locator(".step", { hasText: "cat README.md" }).innerText(), /# demo/);
  step("  opening the README step shows its output: the demo project's README");
  await shot(page, "thread-ended");
  await page.goto(`${url}/#/`);
  await inGroup(page, "quiet", work).waitFor();
  assert.equal(await page.locator(`.tray a[data-tray="${work}"]`).count(), 0);
  assert.equal(await phase(page, work), "turn ended");
  step("  after reading it, its card is plain (turn ended) and it left For you");

  step("journey: steer and stop (project atlas)");
  const slow = await newThread(page, "atlas", "demo slow");
  await page.locator(".strip .state", { hasText: "working" }).waitFor({ timeout: 30000 });
  await page.locator(".work.live .step.is-running").waitFor();
  await page.locator("#composer").fill("after the stop: say hello");
  assert.ok(await page.locator(".composer button.primary").isDisabled(), "a working thread's composer holds the draft");
  assert.match(await page.locator(".composer-blocked").innerText(), /only between runs/);
  const refused = await fetch(`${url}/api/threads/${slow}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", requestId: "probe-steer" }) });
  step(`  cubed refuses a direct message to a working thread (${refused.status}: ${(await refused.json()).error}); the composer holds the draft and says why`);
  await shot(page, "thread-working-hold");
  await page.getByRole("button", { name: "stop" }).click();
  await page.locator(".strip .state", { hasText: /stopped|turn ended/ }).waitFor({ timeout: 30000 });
  await page.locator(".composer button.primary").click();
  await page.locator(".message.assistant", { hasText: "you said: after the stop: say hello" }).waitFor({ timeout: 30000 });
  step("  after the stop the held draft was sent and answered");
  step(`  after stop the strip says: ${await page.locator(".strip .state").innerText()}; history status: ${JSON.stringify((await api(`/api/threads/${slow}/history?tail=1`)).status)}`);
  await shot(page, "thread-stopped");

  step("journey: a failed run");
  const bad = await newThread(page, "demo", "please fail");
  await page.locator(".strip .state", { hasText: "run failed" }).waitFor({ timeout: 30000 });
  assert.match(await page.locator(".strip").innerText(), /the provider refused/);
  await shot(page, "thread-run-failed");

  step("journey: a synthetic thread refuses a control instead of pretending");
  await page.goto(`${url}/#/t/syn-working`);
  await page.getByRole("button", { name: "stop" }).click();
  await page.locator(".banner.notice.lost", { hasText: "synthetic thread" }).waitFor();
  step(`  notice: ${await page.locator(".banner.notice").innerText()}`);
  await page.goto(`${url}/#/t/syn-failed`);
  await page.locator(".panel pre", { hasText: "ERR_PNPM_OUTDATED_LOCKFILE" }).waitFor();
  assert.ok(await page.locator("#composer").isDisabled());
  await shot(page, "thread-machine-failed");

  step("journey: optchat spawns a thread and gets its report");
  await page.goto(`${url}/#/chat`);
  await page.locator("#composer").fill("spawn atlas: demo work");
  await page.keyboard.press("Enter");
  await page.locator('.step[data-tool="spawn"]').waitFor({ timeout: 30000 });
  await page.locator(".message.report").waitFor({ timeout: 90000 });
  const spawned = (await api("/api/optchat/threads")).threads[0];
  assert.equal(spawned.project.name, "atlas");
  step(`  optchat started ${spawned.id} in atlas and its report came back into the chat`);
  await shot(page, "chat-report");
  assert.match((await api(`/api/threads/${spawned.id}/history`)).events.map((event: any) => event.output ?? "").join("\n"), /# atlas/);
  assert.match((await api(`/api/threads/${work}/history`)).events.map((event: any) => event.output ?? "").join("\n"), /# demo/);
  step("  isolation: the atlas thread read atlas's README, the demo thread demo's");

  step("journey: project filter");
  await page.goto(`${url}/#/`);
  await page.locator("#project-filter").selectOption({ label: "atlas" });
  const tags = await page.locator(".floor a.card[data-thread] .card-foot span:first-child").allInnerTexts();
  assert.ok(tags.length > 0 && tags.every(tag => tag === "atlas"), `only atlas rows: ${tags.join(",")}`);
  step(`  with the atlas filter every row is atlas's (${tags.length} rows)`);
  await shot(page, "floor-filter-atlas");
  await page.locator("#project-filter").selectOption({ label: "all projects" });

  step("journey: an artifact, a comment on its text, sent to its author");
  const writer = await newThread(page, "demo", "demo artifact");
  step("  (a real queue first: the runner's 4 slots are taken by the 4 threads above)");
  await page.locator(".strip .state", { hasText: "waiting for a slot" }).waitFor({ timeout: 30000 });
  assert.ok(await page.locator("#composer").isDisabled());
  assert.match(await page.locator(".strip").innerText(), /hosts as many machines as it may/);
  await shot(page, "thread-real-queue");
  assert.equal((await fetch(`${url}/api/threads/${slow}`, { method: "DELETE" })).status, 200);
  step("  archiving another thread (api) freed a slot");
  await page.locator(".message.assistant", { hasText: "artifact written" }).waitFor({ timeout: 60000 });
  step("  the queued thread started by itself and its conversation opened without a reload");
  await page.goto(`${url}/#/artifacts`);
  await page.locator("a.entry", { hasText: "Preview plan (synthetic)" }).click();
  await page.locator("#artifact-body li", { hasText: "Text you can select" }).waitFor();
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById("artifact-body")!, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode()!;
    while (!node.textContent!.startsWith("Text you can select")) node = walker.nextNode()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 19);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator(".new-comment textarea").fill("make this bolder");
  await page.getByRole("button", { name: "add as draft" }).click();
  await page.locator(".comment.draft", { hasText: "make this bolder" }).waitFor();
  await shot(page, "artifact-draft-comment");
  await page.getByRole("button", { name: "send 1 to the author" }).click();
  await page.locator(".comment", { hasText: /queued|delivered/ }).waitFor({ timeout: 30000 });
  await page.waitForFunction(async id => (await (await fetch(`/api/threads/${id}/history`)).json()).events.some((event: any) => event.type === "user-message" && event.text.startsWith("[artifact")), writer, { timeout: 30000 });
  step("  the comment reached the author thread as a message starting \"[artifact\"");
  await shot(page, "artifact-comment-sent");

  step("journey: two windows");
  const other = watch(await context.newPage());
  await other.goto(`${url}/#/`);
  await page.goto(`${url}/#/`);
  await inGroup(page, "foryou", "syn-reported").waitFor();
  await inGroup(other, "foryou", "syn-reported").waitFor();
  await other.goto(`${url}/#/t/syn-reported`);
  await other.locator(".message.assistant", { hasText: "Outcome: found" }).waitFor();
  await inGroup(page, "quiet", "syn-reported").waitFor({ timeout: 10000 });
  step("  reading a report in one window turned its card from yellow to plain in the other, without a reload");
  const twin = await newThread(other, "atlas", "hello from the second window");
  await row(page, twin).waitFor({ timeout: 10000 });
  step("  a thread started in one window appeared in the other");
  await other.close();

  step("journey: keyboard");
  await page.goto(`${url}/#/`);
  await row(page, "syn-working").waitFor();
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  await page.waitForURL(/#\/runners/);
  await page.locator('.entry[data-runner="server-synthetic"]').waitFor();
  await shot(page, "runners");
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keys" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  await page.waitForURL(/#\/$/);
  await page.keyboard.press("j");
  await page.locator("a.card.cursor").waitFor();
  const marked = await page.locator("a.card.cursor").getAttribute("data-thread");
  await page.keyboard.press("Enter");
  await page.waitForURL(url => url.hash === `#/t/${marked}`);
  step(`  g r, ?, esc, g f, j, enter: opened ${marked}`);

  step("journey: archive, then history");
  await page.goto(`${url}/#/t/${bad}`);
  await page.getByRole("button", { name: "archive" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "archive" }).click();
  await page.waitForURL(/#\/$/);
  await page.goto(`${url}/#/history`);
  await page.locator("#search").fill("please fail");
  await page.locator(".entry", { hasText: "please fail" }).waitFor();
  assert.equal(await page.locator(".ledger .entry").count(), 1);
  await page.locator("#search").fill("synthetic");
  await page.locator(".entry", { hasText: "disk kept" }).waitFor();
  await shot(page, "history");
  assert.equal((await api("/api/threads")).threads.some((thread: any) => thread.id === bad), false);
  step("  the archived thread left the open list (api) and is found in history");

  step("journey: cubed unreachable, then back");
  await page.goto(`${url}/#/t/syn-working`);
  await page.locator(".stream.live").waitFor();
  await context.setOffline(true);
  await page.locator(".banner.lost", { hasText: "can't reach cubed" }).waitFor({ timeout: 15000 });
  step(`  banner: ${(await page.locator(".banner.lost").first().innerText()).slice(0, 110)}`);
  await shot(page, "unreachable");
  await context.setOffline(false);
  await page.locator(".banner.lost").waitFor({ state: "detached", timeout: 15000 });
  await page.locator(".stream.live").waitFor({ timeout: 15000 });
  step("  the banner left and the stream is live again");

  step("journey: other pages");
  for (const name of ["projects", "settings"]) {
    await page.goto(`${url}/#/${name}`);
    await page.locator(".entry").first().waitFor();
    assert.equal(await page.locator(".problem").count(), 0, `${name} shows no problem`);
    await shot(page, name);
  }

  step("journey: phone (390x844)");
  const phone = watch(await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage());
  for (const [route, name, ready] of [["/", "floor", ".bays a.card[data-thread]"], ["/t/syn-working", "thread", ".work"], ["/chat", "chat", ".message"], ["/runners", "runners", "[data-runner]"]] as const) {
    await phone.goto(`${url}/#${route}`);
    await phone.locator(ready).first().waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${name} does not scroll sideways (${overflow}px)`);
    assert.ok(await phone.locator(".masthead nav a", { hasText: "optchat" }).isVisible());
    await phone.screenshot({ path: path.join(out, `phone-${name}.png`) });
    step(`  ${name}: no sideways scroll, navigation visible; shot phone-${name}.png`);
  }
  await phone.goto(`${url}/#/t/syn-working`);
  await phone.getByRole("button", { name: "machine" }).click();
  await phone.locator(".panel", { hasText: "where it runs" }).waitFor();
  await phone.screenshot({ path: path.join(out, "phone-thread-machine.png") });

  assert.deepEqual(errors, [], "no page errors");
  step("PASS");
} catch (error) {
  failed = error;
  step(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
} finally {
  fs.writeFileSync(path.join(out, "steps.log"), `${log.join("\n")}\n`);
  await browser.close();
  host.kill("SIGTERM");
  await new Promise(resolve => host.once("exit", resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
