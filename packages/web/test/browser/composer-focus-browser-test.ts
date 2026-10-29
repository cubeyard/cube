/** The composer keeps the focus, the draft and the caret, against a scripted
 * host (the data is mocked; the UI is the built one): a run streaming, tool
 * calls folding and polls going on while the user types change none of them,
 * and a press on the send or stop key (disabled too) leaves the focus in the
 * field, so the next words typed or inserted (as a dictation app pastes them)
 * land in it, once. Stop or send by a key gives the focus to the field; a
 * send's end takes the focus back only from the page or the send key, never
 * from where the user went meanwhile, and a tap with the field left raises
 * no keyboard. The chat and a thread, desktop and phone, Chromium and WebKit where
 * Playwright has it. A real window switch and an operating system's
 * dictation are not simulated here: Playwright keeps every page focused.
 * Needs a built UI (pnpm build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit, type Browser, type Locator, type Page } from "playwright";
import type { ThreadEvent, ThreadSummary } from "../../src/lib/types.ts";
import { gate, ScriptedHost } from "./scripted-host.ts";

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const agent = (id: string, text: string, final = true): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final });
const call = (id: string, callId: string, command: string): ThreadEvent => ({ type: "tool-call", id, callId, name: "bash", input: { command }, final: true });
const result = (id: string, callId: string, output: string): ThreadEvent => ({ type: "tool-result", id, callId, name: "bash", output, isError: false, final: true });
const history = [user("1.0", "earlier"), agent("1.1", "an earlier answer")];
const thread: ThreadSummary = { id: "t1", title: "composer focus", state: "ready", error: null, createdAt: Date.now(), archived: false, project: { id: "cube", name: "cube" } };

const engines: Array<[string, Browser]> = [["chromium", await chromium.launch()]];
if (fs.existsSync(webkit.executablePath())) engines.push(["webkit", await webkit.launch()]);
else console.log("SKIP: webkit (install it: bash scripts/setup-browsers.sh webkit)");
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** The field's focus, text and caret. */
const field = (locator: Locator) => locator.evaluate((element: HTMLTextAreaElement) =>
  ({ focused: document.activeElement === element, value: element.value, caret: [element.selectionStart, element.selectionEnd] }));
let failed = false;

try {
  for (const [engine, browser] of engines) for (const phone of [false, true]) for (const place of ["chat", "thread"] as const) {
    const name = `${engine} ${phone ? "phone" : "desktop"} ${place}`;
    const host = await ScriptedHost.start();
    host.transcript = { ...host.transcript, status: { state: "completed", run: "r0", error: null }, events: history };
    if (place === "thread") { host.thread = thread; host.chat = { ...host.transcript }; }
    const context = await browser.newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: engine === "chromium", hasTouch: true }
      : { viewport: { width: 1280, height: 800 }, ...engine === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {} });
    const page = await context.newPage();
    const errors: string[] = [];
    // WebKit may report the follow-the-bottom observer's resize settling over a frame: a notice, not a failure
    page.on("pageerror", error => { if (!/ResizeObserver loop/.test(String(error))) errors.push(String(error)); });
    const press = (locator: Locator) => phone ? locator.tap() : locator.click();
    try {
      await page.goto(`${host.url}/#/${place === "chat" ? "chat" : "t/t1"}`);
      const composer = page.locator(place === "chat" ? ".chat-sheet .composer textarea" : ".page-panel .composer textarea");
      const keys = page.locator(place === "chat" ? ".chat-sheet .composer" : ".page-panel .composer");
      await page.getByText("an earlier answer").last().waitFor();
      await press(composer);
      await composer.pressSequentially("hello world");
      await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));

      // a run streams, its calls fold into one line, it ends; the chat's polls go on meanwhile
      const events = [...history, user("2.0", "go")];
      host.set(events, { state: "working" });
      for (const text of ["on", "on it", "on it, reading"]) { host.set([...events, agent("2.1", text, false)], { state: "working" }); await settle(page); }
      events.push(agent("2.1", "on it, reading"), call("2.2", "c1", "ls"), result("2.3", "c1", "a"));
      host.set(events, { state: "working" }); await settle(page);
      events.push(call("2.4", "c2", "ls -la"), result("2.5", "c2", "b"), agent("2.6", "done"));
      host.set(events, { state: "completed" });
      await page.locator(`${place === "chat" ? ".chat-sheet" : ".page-panel"} .composer[aria-busy=false]`).waitFor();
      await delay(3200);
      assert.deepEqual(await field(composer), { focused: true, value: "hello world", caret: [5, 5] }, `${name}: a run and polls leave the focus, the draft and the caret`);
      // words inserted as a dictation app's are, at the caret, once
      await page.keyboard.insertText(" said");
      assert.deepEqual(await field(composer), { focused: true, value: "hello said world", caret: [10, 10] }, `${name}: inserted words land at the caret`);
      if (engine === "chromium" && !phone) {
        await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
        await page.keyboard.press("ControlOrMeta+V");
        assert.deepEqual(await field(composer), { focused: true, value: "hello said pasted world", caret: [17, 17] }, `${name}: a paste lands at the caret, once`);
      }
      const before = await field(composer);
      const at = before.caret[0]!;
      const draft = `${before.value.slice(0, at)}!${before.value.slice(at)}`;

      // stop pressed while the field has the focus: the key goes disabled and then away, the focus stays
      host.set([...events, user("3.0", "again")], { state: "working" });
      const stopKey = keys.locator(".stop-key");
      await stopKey.waitFor();
      await press(stopKey);
      await settle(page);
      assert.equal((await field(composer)).focused, true, `${name}: the stop key's press leaves the focus in the field`);
      host.set([...events, user("3.0", "again")], { state: "stopped" });
      await stopKey.waitFor({ state: "detached" });
      await page.keyboard.insertText("!");
      assert.deepEqual(await field(composer), { focused: true, value: draft, caret: [at + 1, at + 1] }, `${name}: after the stop, words land at the caret`);

      // the send key pressed while the field has the focus: words said while the send is on its way stay for the next message
      const held = gate();
      host.onPrompt = async ({ text }) => { await held.promise; host.set([...events, user("3.0", "again"), user("4.0", text)], { state: "working" }); };
      await press(keys.locator(".send-key"));
      await page.locator(".conversation-message.user.sending").last().waitFor();
      assert.equal((await field(composer)).focused, true, `${name}: the send key's press leaves the focus in the field`);
      await page.keyboard.insertText("next");
      held.open();
      await page.locator(".conversation-message.user.sending").waitFor({ state: "detached" });
      await settle(page);
      assert.deepEqual(await field(composer), { focused: true, value: "next", caret: [4, 4] }, `${name}: words said during the send wait in the field`);
      assert.deepEqual(host.prompts.map(prompt => prompt.text), [draft], `${name}: one message sent, without the later words`);
      let shown = [...events, user("3.0", "again"), user("4.0", draft)];
      /** A send the host holds until `open`; accepted, the transcript shows it. */
      const holdSend = () => {
        const next = gate();
        host.onPrompt = async ({ text, requestId }) => { await next.promise; shown = [...shown, user(`u.${requestId}`, text)]; host.set(shown, { state: "completed" }); };
        return next;
      };
      const sent = async (hold: { open: () => void }) => {
        hold.open();
        await page.locator(".conversation-message.user.sending").waitFor({ state: "detached" });
        await settle(page);
      };
      const sendKey = keys.locator(".send-key");

      // the send key pressed while it is disabled (an empty draft): the field keeps the focus and the caret
      await composer.fill("");
      assert.equal(await sendKey.isDisabled(), true, `${name}: an empty draft holds the send key`);
      if (phone) await sendKey.tap({ force: true }); else await sendKey.click({ force: true });
      assert.deepEqual(await field(composer), { focused: true, value: "", caret: [0, 0] }, `${name}: a press on the disabled send key leaves the focus in the field`);

      // stop by a key: the key goes disabled and away, the focus goes to the field beside it
      host.set([...shown, user("5.0", "once more")], { state: "working" });
      await stopKey.waitFor();
      await composer.fill("kept");
      await stopKey.focus();
      await page.keyboard.press("Enter");
      await settle(page);
      assert.equal((await field(composer)).focused, true, `${name}: stop by a key gives the focus to the field`);
      shown = [...shown, user("5.0", "once more")];
      host.set(shown, { state: "stopped" });
      await stopKey.waitFor({ state: "detached" });
      assert.deepEqual(await field(composer), { focused: true, value: "kept", caret: [4, 4] }, `${name}: after a stop by a key, the field has the focus and the draft`);

      // a send the user leaves while it is on its way: its end takes the focus nowhere
      let hold = holdSend();
      await composer.press("Enter");
      await page.locator(".conversation-message.user.sending").last().waitFor();
      const elsewhere = place === "chat" ? page.locator(".sheet-bar .name-key") : page.locator(".page-panel h1.strip-title");
      await elsewhere.focus();
      await sent(hold);
      assert.equal(await elsewhere.evaluate(element => document.activeElement === element), true, `${name}: a send's end leaves the focus where the user took it`);

      // the send key by a key: the focus goes to the field as the key goes disabled, and stays
      await composer.fill("by a key");
      hold = holdSend();
      await sendKey.focus();
      await page.keyboard.press("Enter");
      await page.locator(".conversation-message.user.sending").last().waitFor();
      assert.equal((await field(composer)).focused, true, `${name}: the send key by a key gives the focus to the field`);
      await sent(hold);
      assert.equal((await field(composer)).focused, true, `${name}: and it stays there after the send`);

      // the send key pressed with the field left: a mouse brings the focus back to the field, a tap raises no keyboard
      await composer.fill("from outside");
      await composer.evaluate(element => element.blur());
      hold = holdSend();
      await press(sendKey);
      await page.locator(".conversation-message.user.sending").last().waitFor();
      await sent(hold);
      assert.equal((await field(composer)).focused, !phone, `${name}: ${phone ? "a tap on send with the field left leaves it unfocused" : "a click on send gives the field the focus"}`);

      if (engine === "chromium" && !phone) {
        // a word still being composed (an input method's marked text) goes with the send once, and leaves nothing behind
        await composer.fill("");
        await composer.focus();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.imeSetComposition", { text: "wor", selectionStart: 3, selectionEnd: 3 });
        hold = holdSend();
        await sendKey.click();
        await page.locator(".conversation-message.user.sending").last().waitFor();
        await sent(hold);
        await page.keyboard.insertText("x");
        assert.deepEqual(await field(composer), { focused: true, value: "x", caret: [1, 1] }, `${name}: no composed text comes back after the send`);
      }
      assert.deepEqual(host.prompts.map(prompt => prompt.text), [draft, "kept", "by a key", "from outside", ...engine === "chromium" && !phone ? ["wor"] : []], `${name}: each message sent once`);
      assert.deepEqual(errors, [], `${name}: no script errors`);
      console.log(`ok - ${name}`);
    } catch (error) {
      failed = true;
      console.error(`not ok - ${name}\n`, error);
    } finally {
      await context.close();
      await host.close();
    }
  }
} finally {
  for (const [, browser] of engines) await browser.close();
}
if (failed) process.exit(1);
