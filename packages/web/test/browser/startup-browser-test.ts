/** A thread's machine start in a real browser against the real cubed with
 * local guests: while the machine starts the thread shows its steps, the
 * running hook's log as it grows, a try the OOM killer stopped (its full
 * error, the memory, the end of its log, and the advice with a link to the
 * project's machine size), the next try; once the machine is ready the
 * steps fold away and the machine label opens them again. The project page
 * sets the machine size. Desktop and phone, in Chromium and, when
 * Playwright has it, WebKit. Screenshots go to CUBE_SCREENSHOTS when it is
 * set. Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { STARTUP_PRE_SETUP, startStartupHost } from "../../../server/test/startup-fixture.ts";

const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const host = await startStartupHost();
const url = host.url;
const project = { id: host.projectId };

let browser: Browser = await chromium.launch();
const errors: string[] = [];
async function open(width: number, height: number, hash: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${url}/${hash}`);
  return page;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

const engines = fs.existsSync(webkit.executablePath()) ? [chromium, webkit] : [chromium];
if (engines.length === 1) console.log("SKIP: webkit (install it: pnpm --filter @cube/web exec playwright install webkit)");
try {
  for (const engine of engines) {
  if (engine !== chromium) { await browser.close(); browser = await engine.launch(); }
  const name = engine.name();
  for (const [layout, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]] as const) {
    const size = `${name}-${layout}`;
    const thread = await host.thread(size);
    const guest = () => host.guest(thread);
    const page = await open(width, height, `#/t/${thread}`);
    const panel = page.locator("section.startup");

    // While the first try runs: its step and its hook's log as it grows.
    await panel.waitFor();
    const first = panel.locator("details.startup-step", { hasText: "prepare · try 1" });
    await first.locator(".lamp.on-amber.blink").waitFor();
    await first.locator("pre.startup-log", { hasText: "building the services" }).waitFor({ timeout: 15_000 });
    assert.match(await first.locator(".startup-log-head").innerText(), /^pre-setup log$/);
    await shot(page, `${size}-1-running`);

    // The OOM killer stops it: the full error, the memory, its log, the advice.
    fs.writeFileSync(path.join(guest(), "oom"), "");
    await first.locator(".lamp.on-red").waitFor({ timeout: 20_000 });
    assert.equal(await first.locator(".startup-detail.bad").innerText(),
      "pre-setup was stopped: the machine ran out of memory (this command used up to 3.5 GB; the machine has 3.8 GB); cube tries again");
    assert.match(await first.locator(".startup-detail:not(.bad)").innerText(), /^memory: this command used up to 3\.5 GB; the machine has 3\.8 GB; 1 process was killed for want of memory$/);
    assert.match(await first.locator("pre.startup-log").innerText(), /installing postgresql\nbuilding the services/);
    const advice = panel.locator(".strip-note.bad");
    assert.match(await advice.innerText(), /the machine ran out of memory during prepare · try 1 \(it used up to 3\.5 GB; the machine has 3\.8 GB\)/);
    assert.equal(await advice.locator("a.key", { hasText: "machine size" }).getAttribute("href"), `#/projects/${project.id}`);
    await shot(page, `${size}-2-out-of-memory`);

    // The next try (the recovery loop's, here at once) and its log.
    host.retry(thread);
    const second = panel.locator("details.startup-step", { hasText: "prepare · try 2" });
    await second.locator("pre.startup-log", { hasText: "second try: services up to date" }).waitFor({ timeout: 15_000 });
    await shot(page, `${size}-3-second-try`);
    assert.equal(await first.getAttribute("open"), null, "the failed try folds while the next one runs");
    assert.equal(await second.getAttribute("open"), "", "the running try is open, with its log");
    await first.locator("summary").click();
    assert.equal(await first.getAttribute("open"), "", "the reader opens the failed try again");
    await page.waitForTimeout(3500);
    assert.equal(await first.getAttribute("open"), "", "and the next poll keeps it open");
    // The composer stays on screen under the panel.
    assert.ok(await page.locator(".composer textarea").isVisible(), "the composer stays reachable");

    // Ready: the steps fold away; the machine label opens them again.
    fs.writeFileSync(path.join(guest(), "go"), "");
    await panel.waitFor({ state: "detached", timeout: 20_000 });
    if (layout === "phone") await page.locator(".strip-details-key").click();
    const label = page.locator("button.strip-machine");
    await label.waitFor();
    // (A local guest records no disk preparation, so the label names the steps.)
    assert.equal(await label.innerText(), "machine startup");
    await label.click();
    await panel.waitFor();
    assert.deepEqual(await panel.locator("details.startup-step code").allInnerTexts(), ["prepare · try 1", "prepare · try 2", "resume"]);
    await shot(page, `${size}-4-reopened`);
    await panel.locator("button.startup-close").click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await label.getAttribute("aria-expanded"), "false");
    await page.close();
    await host.archive(thread);
    console.log(`ok (${size}): steps, the live log, the out-of-memory try with its advice, the next try, and the steps after ready`);
  }
  }

  // The project page sets the machine size; new threads get it.
  const page = await open(1280, 800, `#/projects/${project.id}`);
  const memory = page.locator("select[aria-label='machine memory']");
  await memory.waitFor();
  assert.equal(await memory.locator("option").first().innerText(), "cube default · 4 GB");
  await memory.selectOption("8192");
  await page.locator("button.key.primary", { hasText: "save changes" }).click();
  await page.locator(".key-reason", { hasText: "saved" }).waitFor();
  assert.deepEqual(host.project().machine, { memoryMiB: 8192 });
  assert.equal(host.project().hooks!.preSetup, STARTUP_PRE_SETUP, "the hooks stay as they were");
  await page.locator("#machine-size").scrollIntoViewIfNeeded();
  await shot(page, "project-machine-size");
  console.log("ok: the project page sets the machine size and keeps the hooks");
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await browser.close();
  await host.close();
}
console.log("startup browser: ok");
