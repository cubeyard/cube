/** Mermaid diagrams drawn by Pele in a real browser, in the chat and in an
 * artifact. The chat (a scripted host, so every streamed frame is the
 * test's): several fences in one message, one that does not parse (its
 * error shown as text, its source opened), hostile labels and links inert,
 * a table beside them; a message streamed frame by frame, its open fence
 * shown as growing source, never as a broken drawing, and drawn once
 * closed while the message still streams; a phone without sideways scroll.
 * An artifact (the real cubed): a revision written before cubed checked
 * diagrams, with one that does not parse beside one that does, shows the
 * error and draws the other. Nothing is fetched for a diagram but Pele's
 * own code. Needs a built UI and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startDiagramHost } from "../../../server/test/diagram-host.ts";
import type { ThreadEvent, ThreadTranscript } from "../../src/lib/types.ts";
import { ScriptedHost } from "./scripted-host.ts";

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string, final = true): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final });
const idle: ThreadTranscript["status"] = { state: "completed", run: "r0", error: null };
const shots = process.env.CUBE_SCREENSHOTS ?? null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

const DIAGRAMS = [
  "Three diagrams and a table.",
  "```mermaid\nflowchart LR\n  draft[draft] --> review{review} --> merged([merged])\n```",
  "```mermaid\nsequenceDiagram\n  You->>cubed: write\n  cubed-->>You\n```",
  "```mermaid\nflowchart TD\n  A[\"<img src=x onerror=window.__pwned=true>\"] --> B\n  click A call alert(1)\n  click B \"javascript:window.__pwned=true\"\n```",
  "| step | where |\n| --- | --- |\n| check | cubed |\n| draw | the browser |",
].join("\n\n");

/** What the page shows for its diagrams, and anything that should not be there. */
const state = (page: Page) => page.evaluate(() => {
  const figures = [...document.querySelectorAll<HTMLElement>(".transcript figure.diagram-figure, article.artifact-body figure.diagram-figure")];
  return {
    figures: figures.map(figure => figure.querySelector("img") ? "drawn" : figure.querySelector(".diagram-growing") ? "growing"
      : figure.querySelector(".diagram-note.bad") ? `error: ${figure.querySelector(".diagram-note.bad")!.textContent}` : figure.querySelector("[aria-busy]") ? "busy" : "?"),
    opened: figures.map(figure => figure.querySelector("details.diagram-source")?.hasAttribute("open") ?? null),
    images: [...document.querySelectorAll<HTMLImageElement>("figure.diagram-figure img")].map(image => image.src.slice(0, 26)),
    pwned: (window as { __pwned?: boolean }).__pwned ?? false,
    scripts: document.querySelectorAll(".transcript script, article.artifact-body script").length,
    links: [...document.querySelectorAll("figure.diagram-figure a")].length,
    tables: document.querySelectorAll(".transcript table td, article.artifact-body table td").length,
  };
});

const browser = await chromium.launch();
const dialogs: string[] = [];
let failed = false;
async function scenario(name: string, run: (page: Page) => Promise<void>, viewport = { width: 1280, height: 800 }, mobile = false): Promise<void> {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  // Nothing leaves the page for a diagram: every request goes to the host under test.
  const outside: string[] = [];
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1:") && !request.url().startsWith("data:")) outside.push(request.url()); });
  try {
    await run(page);
    assert.deepEqual(errors, [], "no script errors");
    assert.deepEqual(outside, [], "no request outside the host");
    console.log(`ok - ${name} (${viewport.width}x${viewport.height})`);
  } catch (error) {
    failed = true;
    console.error(`not ok - ${name} (${viewport.width}x${viewport.height})\n`, error);
  } finally {
    await page.close();
  }
}

for (const [viewport, mobile] of [[{ width: 1280, height: 800 }, false], [{ width: 390, height: 844 }, true]] as const) {
  await scenario("chat: several diagrams, one that does not parse, hostile labels, a table", async page => {
    const host = await ScriptedHost.start();
    try {
      host.transcript = { ...host.transcript, status: idle, events: [user("1.0", "draw it"), agent("2.0.0", DIAGRAMS)] };
      await page.goto(`${host.url}/#/chat`);
      await page.locator(".transcript figure.diagram-figure img").first().waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !document.querySelector(".transcript figure.diagram-figure [aria-busy]"));
      const shown = await state(page);
      assert.deepEqual(shown.figures, ["drawn", "error: diagram could not be drawn (line 3, column 15): Parse error on line 3: Expecting 'TXT', got 'NEWLINE'", "drawn"]);
      assert.deepEqual(shown.opened, [false, true, false], "the source of the one that does not parse is open");
      assert.deepEqual(shown.images, ["data:image/svg+xml;charset", "data:image/svg+xml;charset"], "pictures are images of their SVG");
      assert.deepEqual({ pwned: shown.pwned, scripts: shown.scripts, links: shown.links, tables: shown.tables }, { pwned: false, scripts: 0, links: 0, tables: 4 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
      await page.locator(".transcript figure.diagram-figure").first().scrollIntoViewIfNeeded();
      await shoot(page, `chat-diagrams-${viewport.width}`);
      await page.locator(".transcript figure.diagram-figure").nth(1).scrollIntoViewIfNeeded();
      await shoot(page, `chat-diagram-error-${viewport.width}`);
    } finally { await host.close(); }
  }, viewport, mobile);
}

await scenario("chat: a diagram streamed frame by frame", async page => {
  const host = await ScriptedHost.start();
  try {
    host.transcript = { ...host.transcript, status: idle, events: [user("1.0", "earlier"), agent("2.0.0", "an earlier answer")] };
    await page.goto(`${host.url}/#/chat`);
    await page.getByText("an earlier answer").waitFor();
    const first = "```mermaid\nflowchart LR\n  plan[plan] --> build[build] --> ship[ship]\n```";
    const second = "```mermaid\nsequenceDiagram\n  participant chat\n  participant pele\n  chat->>pele: source\n  pele-->>chat: picture\n```";
    const whole = `Here is the plan.\n\n${first}\n\nAnd the exchange:\n\n${second}\n\nThat is all.`;
    const base = [user("1.0", "earlier"), agent("2.0.0", "an earlier answer"), user("3.0", "stream it")];
    // Frames cut anywhere, the fences' own markers too: the chat never breaks, an open fence is source.
    const cuts = [10, 20, 30, 40, 60, first.length + 19, first.length + 21, whole.indexOf("And"), whole.indexOf("sequenceDiagram") - 2, whole.indexOf("chat->>"), whole.indexOf("pele-->>") + 6, whole.indexOf("That") - 3];
    const seen = new Set<string>();
    let shownText = "";
    for (const cut of cuts) {
      host.set([...base, agent("4.0.0", whole.slice(0, cut), false)], { state: "working", run: "r1" });
      // The frame is on the page once the message's text changes (a cut inside a fence marker may not change it).
      await page.waitForFunction(before => document.querySelector(".transcript .conversation-message.assistant:last-of-type")?.textContent !== before, shownText, { timeout: 1_000 }).catch(() => {});
      shownText = await page.evaluate(() => document.querySelector(".transcript .conversation-message.assistant:last-of-type")?.textContent ?? "");
      const shown = await state(page);
      for (const figure of shown.figures) seen.add(figure);
      if (cut > first.length + 21) {
        await page.waitForFunction(() => !!document.querySelector(".transcript figure.diagram-figure img"));
      }
      if (shown.figures.some(figure => figure.startsWith("error"))) throw new Error(`a broken drawing while streaming at ${cut}: ${JSON.stringify(shown.figures)}`);
    }
    assert.ok(seen.has("growing"), "an open fence shows its growing source");
    // The first diagram is drawn while the message still streams on, and the second fence still grows.
    const mid = await state(page);
    assert.equal(mid.figures[0], "drawn", "drawn once closed, mid-stream");
    assert.equal(mid.figures[1], "growing", "the open fence is not drawn yet");
    await page.locator(".transcript .diagram-growing").scrollIntoViewIfNeeded();
    await shoot(page, "chat-diagram-streaming");
    host.set([...base, agent("4.0.0", whole)], { state: "completed", run: "r1" });
    await page.waitForFunction(() => document.querySelectorAll(".transcript figure.diagram-figure img").length === 2, undefined, { timeout: 30_000 });
    assert.deepEqual((await state(page)).figures, ["drawn", "drawn"]);
    await page.locator(".transcript figure.diagram-figure").nth(1).scrollIntoViewIfNeeded();
    await shoot(page, "chat-diagram-streamed");
  } finally { await host.close(); }
});

// An artifact revision from before diagrams were checked: the page shows the error and draws the rest.
const legacy = await startDiagramHost({ web: path.resolve(import.meta.dirname, "../../dist"), title: "an older plan",
  body: "# an older plan\n\nWritten before cubed checked diagrams.\n\n```mermaid\nflowchart LR\n  A[old] --> B[new]\n```\n\n```mermaid\nzenuml\n  title not drawn here\n```\n\nThe sentence after the diagrams." });
try {
  for (const scheme of ["light", "dark"] as const) {
    await scenario(`artifact: an older revision's diagram that does not parse (${scheme})`, async page => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${legacy.url}/#/a/${legacy.id}`);
      await page.locator("article.artifact-body h1", { hasText: "an older plan" }).waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !document.querySelector("article.artifact-body figure.diagram-figure [aria-busy]"), undefined, { timeout: 30_000 });
      const shown = await state(page);
      assert.deepEqual(shown.figures, ["drawn", "error: diagram could not be drawn: No diagram type detected for the given text."]);
      assert.deepEqual(shown.opened, [false, true]);
      assert.ok(await page.getByText("The sentence after the diagrams.").isVisible());
      await page.locator("article.artifact-body figure.diagram-figure").nth(1).scrollIntoViewIfNeeded();
      await shoot(page, `artifact-legacy-error-${scheme}`);
    });
  }
} finally { await legacy.close(); }

await browser.close();
if (dialogs.length) { console.error("dialogs opened:", dialogs); failed = true; }
if (failed) process.exit(1);
console.log("diagram browser: ok");
