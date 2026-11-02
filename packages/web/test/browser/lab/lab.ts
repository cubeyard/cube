/** Lab: reload, reconnect and restart faults against a real cubed. Run:
 * node packages/web/test/browser/lab/lab.ts [scenario...] */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright";
import { startLab, words } from "../../../../server/test/lab-host.ts";

type Lab = Awaited<ReturnType<typeof startLab>>;
const OUT = process.env.LAB_OUT ?? "/tmp/lab-out";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const results: string[] = [];

const users = (page: Page, scope = "") => page.locator(`${scope} .conversation-message.user .message-copy`).allTextContents();
const agents = (page: Page, scope = "") => page.locator(`${scope} .conversation-message.assistant .message-copy`).allTextContents();
const idle = (page: Page, scope = "") => page.locator(`${scope} .composer[aria-busy=false]`).waitFor({ timeout: 30_000 });
const shot = async (page: Page, name: string) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

/** The server's view: user texts and final assistant texts. */
async function serverView(lab: Lab, base: string) {
  const history = await lab.api(`${base}/history`);
  return {
    status: history.status,
    users: history.events.filter((e: any) => e.type === "user-message" && !e.from).map((e: any) => e.text),
    agents: history.events.filter((e: any) => e.type === "assistant-text" && !e.reasoning).map((e: any) => e.text),
    raw: history,
  };
}

async function send(page: Page, text: string, scope = "") {
  const composer = page.locator(`${scope} .composer textarea`);
  await composer.fill(text);
  await page.locator(`${scope} .composer button.send-key:enabled`).waitFor({ timeout: 30_000 });
  await composer.press("Enter");
}

/** Waits until the shown assistant text contains `fragment`. */
const shows = (page: Page, fragment: string, timeout = 30_000, scope = "") =>
  page.locator(`${scope} .conversation-message.assistant`, { hasText: fragment }).first().waitFor({ timeout });

async function compare(page: Page, lab: Lab, base: string, label: string) {
  const server = await serverView(lab, base);
  const shownUsers = await users(page);
  const shownAgents = (await agents(page)).map(text => text.trim());
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify({ server: { status: server.status, users: server.users, agents: server.agents }, shownUsers, shownAgents }, null, 2));
  assert.deepEqual(shownUsers, server.users, `${label}: user messages match the host`);
  assert.deepEqual(shownAgents, server.agents.map((t: string) => t.trim()), `${label}: agent messages match the host`);
  return server;
}

const ACTIVE = ":is(dialog.page-panel[open], #app:not(:has(> dialog.page-panel[open])))";
const bash = (command: string) => `tool ${JSON.stringify({ name: "bash", args: { command } })}`;
async function newThread(lab: Lab, text: string): Promise<string> {
  const { id } = await lab.post("/api/threads", { projectId: lab.projectId, requestId: `r-${Date.now()}`, text, model: lab.model });
  return id;
}
async function compareThread(page: Page, lab: Lab, id: string, label: string) {
  const server = await serverView(lab, `/api/threads/${id}`);
  const shownUsers = await users(page, ACTIVE);
  const shownAgents = (await agents(page, ACTIVE)).map(text => text.replace(/\s+/g, ""));
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify({ server: { status: server.status, users: server.users, agents: server.agents }, shownUsers, shownAgents, events: server.raw.events }, null, 2));
  assert.deepEqual(shownUsers, server.users, `${label}: user messages match the host`);
  assert.deepEqual(shownAgents, server.agents.map((t: string) => t.replace(/\s+/g, "")), `${label}: agent messages match the host`);
  return server;
}

const SCENARIOS: Record<string, (lab: Lab) => Promise<void>> = {
  async "chat-reload-mid-stream"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "words 120");
    await shows(page, "w10 ");
    await page.reload();
    await shows(page, "w30 ");
    await shows(page, " end");
    await idle(page);
    await compare(page, lab, "/api/optchat", "chat-reload-mid-stream");
    await shot(page, "chat-reload-mid-stream");
    await page.close();
  },
  async "chat-drop-mid-stream"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "words 150");
    await shows(page, "w10 ");
    lab.drop();
    await shows(page, "w40 ");
    lab.down();
    await delay(2500);
    lab.restore();
    await shows(page, " end", 40_000);
    await idle(page);
    await compare(page, lab, "/api/optchat", "chat-drop-mid-stream");
    await page.close();
  },
  async "chat-two-windows"(lab) {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.goto(`${lab.url}/#/chat`);
    await b.goto(`${lab.url}/#/chat`);
    await idle(a); await idle(b);
    await send(a, "words 60");
    await shows(b, "w5 ");
    await b.reload();
    await shows(a, " end"); await shows(b, " end");
    await idle(a); await idle(b);
    await compare(a, lab, "/api/optchat", "chat-two-windows-a");
    await compare(b, lab, "/api/optchat", "chat-two-windows-b");
    await a.close(); await b.close();
  },
  async "chat-stop-then-reload"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "words 300");
    await shows(page, "w10 ");
    await page.getByRole("button", { name: /stop/ }).click();
    await idle(page);
    const before = await serverView(lab, "/api/optchat");
    await page.reload();
    await idle(page);
    const server = await compare(page, lab, "/api/optchat", "chat-stop-then-reload");
    assert.equal(server.status.state, "stopped", `stopped: ${JSON.stringify(server.status)} (before reload ${JSON.stringify(before.status)})`);
    await page.close();
  },
  async "chat-restart-mid-stream"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "words 300");
    await shows(page, "w10 ");
    await lab.restart();
    const after = await serverView(lab, "/api/optchat");
    fs.writeFileSync(path.join(OUT, "chat-restart-mid-stream-server.json"), JSON.stringify(after.raw, null, 2));
    await delay(3000);
    await idle(page);
    await shot(page, "chat-restart-mid-stream");
    await compare(page, lab, "/api/optchat", "chat-restart-mid-stream");
    assert.notEqual(after.status.state, "working", `after a restart the run is not working: ${JSON.stringify(after.status)}`);
    await send(page, "after restart");
    await shows(page, "ok: after restart");
    await idle(page);
    await compare(page, lab, "/api/optchat", "chat-restart-mid-stream-2");
    await page.close();
  },
  async "chat-send-while-down"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await idle(page);
    lab.down();
    await send(page, "sent while down").catch(error => { throw new Error(`send while down: ${error}`); });
    await delay(1500);
    await shot(page, "chat-send-while-down-1");
    const note = await page.locator(".conversation-error, .conversation-note").allTextContents();
    lab.restore();
    await delay(3000);
    await shot(page, "chat-send-while-down-2");
    fs.writeFileSync(path.join(OUT, "chat-send-while-down-notes.json"), JSON.stringify({ note, draft: await page.locator(".composer textarea").inputValue() }));
    await page.close();
  },
  async "chat-fail-reload"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "please fail");
    await page.locator(".conversation-error", { hasText: "refused" }).waitFor();
    await page.reload();
    await page.locator(".conversation-error", { hasText: "refused" }).waitFor();
    await idle(page);
    await compare(page, lab, "/api/optchat", "chat-fail-reload");
    await page.close();
  },

  async "thread-reload-starting-and-tool"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/projects/${lab.projectId}`);
    await page.getByRole("button", { name: "new thread" }).click();
    const dialog = page.locator("dialog.new-thread-dialog");
    await dialog.getByRole("textbox", { name: "first message" }).fill(bash("for i in 1 2 3 4 5 6 7 8; do echo line$i; sleep 0.5; done"));
    await dialog.getByRole("button", { name: "start thread" }).click();
    await page.waitForURL(/#\/t\/[^/]+$/);
    const id = decodeURIComponent(page.url().split("#/t/")[1]!);
    await page.reload();
    await page.locator(".conversation", { hasText: "line2" }).first().waitFor({ timeout: 30_000 });
    await page.reload();
    lab.drop();
    await page.locator(".conversation", { hasText: "result: line1" }).first().waitFor({ timeout: 30_000 });
    await idle(page, ACTIVE);
    await shot(page, "thread-reload-starting-and-tool");
    await compareThread(page, lab, id, "thread-reload-starting-and-tool");
    await page.close();
  },
  async "thread-restart-mid-tool"(lab) {
    const id = await newThread(lab, bash("echo begin; sleep 6; echo finished > done.txt; echo finished"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "begin" }).first().waitFor({ timeout: 30_000 });
    await lab.restart();
    await delay(4000);
    await shot(page, "thread-restart-mid-tool-1");
    const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
    const server = await serverView(lab, `/api/threads/${id}`);
    fs.writeFileSync(path.join(OUT, "thread-restart-mid-tool-server.json"), JSON.stringify({ list, history: server.raw }, null, 2));
    await idle(page, ACTIVE);
    await compareThread(page, lab, id, "thread-restart-mid-tool");
    await send(page, "after restart", ACTIVE);
    await shows(page, "ok: after restart", 30_000);
    await idle(page, ACTIVE);
    await compareThread(page, lab, id, "thread-restart-mid-tool-2");
    await page.close();
  },
  async "thread-archive-other-window"(lab) {
    const id = await newThread(lab, bash("sleep 3; echo hi"));
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.goto(`${lab.url}/#/t/${id}`);
    await b.goto(`${lab.url}/#/t/${id}`);
    await a.locator(".conversation", { hasText: "result: hi" }).first().waitFor({ timeout: 30_000 });
    await idle(a, ACTIVE);
    await a.locator(`${ACTIVE} .strip-details-key`).click();
    await a.getByRole("button", { name: "archive thread" }).click();
    await a.getByRole("button", { name: "confirm: archive this thread" }).click();
    await a.waitForURL(url => !url.hash.startsWith(`#/t/${id}`), { timeout: 30_000 });
    await delay(5000);
    await shot(b, "thread-archive-other-window-b");
    const aria = await b.locator("body").ariaSnapshot();
    fs.writeFileSync(path.join(OUT, "thread-archive-other-window-b.aria.yml"), aria);
    const reconnecting = await b.locator(".conversation-note", { hasText: "reconnecting" }).count();
    assert.equal(reconnecting, 0, "the other window does not reconnect forever to an archived thread");
    await a.close(); await b.close();
  },
  async "thread-stop-mid-tool"(lab) {
    const id = await newThread(lab, bash("echo begin; sleep 20; echo late"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "begin" }).first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /stop/ }).first().click();
    await idle(page, ACTIVE);
    await page.reload();
    await idle(page, ACTIVE);
    await shot(page, "thread-stop-mid-tool");
    const server = await compareThread(page, lab, id, "thread-stop-mid-tool");
    assert.equal(server.status.state, "stopped");
    const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
    fs.writeFileSync(path.join(OUT, "thread-stop-mid-tool-list.json"), JSON.stringify(list, null, 2));
    await page.close();
  },
  async "thread-fail-reload"(lab) {
    const id = await newThread(lab, "please fail");
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation-error", { hasText: "refused" }).waitFor({ timeout: 30_000 });
    await page.reload();
    await page.locator(".conversation-error", { hasText: "refused" }).waitFor();
    await shot(page, "thread-fail-reload");
    const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
    fs.writeFileSync(path.join(OUT, "thread-fail-reload-list.json"), JSON.stringify(list, null, 2));
    await compareThread(page, lab, id, "thread-fail-reload");
    await page.close();
  },

  async "thread-restart-slow-boot"(lab) {
    const id = await newThread(lab, bash("echo first"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "result: first" }).first().waitFor({ timeout: 30_000 });
    await idle(page, ACTIVE);
    const states: string[] = [];
    await lab.restart(undefined, 12_000);
    for (let i = 0; i < 20; i++) {
      const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
      const note = (await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ");
      states.push(`${i}s list=${list?.state}/${list?.workspaceState ?? ""} ui=${note}`);
      await delay(1000);
    }
    fs.writeFileSync(path.join(OUT, "thread-restart-slow-boot-states.txt"), states.join("\n"));
    await shot(page, "thread-restart-slow-boot");
    await send(page, "after slow boot", ACTIVE);
    await shows(page, "ok: after slow boot", 30_000);
    await idle(page, ACTIVE);
    await compareThread(page, lab, id, "thread-restart-slow-boot");
    await page.close();
  },

  async "thread-fresh-load-during-boot"(lab) {
    const id = await newThread(lab, bash("echo first"));
    const warm = await browser.newPage();
    await warm.goto(`${lab.url}/#/t/${id}`);
    await warm.locator(".conversation", { hasText: "result: first" }).first().waitFor({ timeout: 30_000 });
    await idle(warm, ACTIVE);
    await warm.close();
    await lab.restart(undefined, 15_000);
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.goto(`${lab.url}/#/t/${id}`);
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const text = (await page.locator(`${ACTIVE} .conversation`).first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      seen.push(`${Date.now() - t0}ms ${text}`);
      if (text.includes("result: first") && i > 2) break;
      await delay(1000);
    }
    fs.writeFileSync(path.join(OUT, "thread-fresh-load-during-boot.txt"), seen.join("\n"));
    await shot(page, "thread-fresh-load-during-boot");
    await page.close();
  },

  async "thread-machine-failed-after-restart"(lab) {
    const id = await newThread(lab, bash("echo first"));
    const warm = await browser.newPage();
    await warm.goto(`${lab.url}/#/t/${id}`);
    await warm.locator(".conversation", { hasText: "result: first" }).first().waitFor({ timeout: 30_000 });
    await idle(warm, ACTIVE);
    await lab.restart(undefined, 2000, true);
    await delay(6000);
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await delay(4000);
    const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
    const fresh = (await page.locator(`${ACTIVE} .conversation`).first().innerText()).replace(/\s+/g, " ");
    const open = (await warm.locator(`${ACTIVE} .conversation`).first().innerText()).replace(/\s+/g, " ");
    let history: unknown; try { history = await lab.api(`/api/threads/${id}/history`); } catch (error) { history = String(error); }
    fs.writeFileSync(path.join(OUT, "thread-machine-failed-after-restart.json"), JSON.stringify({ list: { state: list?.state, workspaceState: list?.workspaceState, error: list?.error ?? list?.workspaceError }, fresh, open, history }, null, 2));
    await shot(page, "thread-machine-failed-after-restart-fresh");
    await shot(warm, "thread-machine-failed-after-restart-open");
    assert.ok(fresh.includes("result: first"), `a fresh load shows the stored transcript: ${fresh}`);
  },

  async "chat-send-response-lost"(lab) {
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await idle(page);
    let lost = 0;
    await page.route("**/api/optchat/prompt", async route => {
      if (lost++ === 0) { await route.fetch(); await route.abort("connectionreset"); return; }
      await route.continue();
    });
    await send(page, "words 20");
    await delay(2000);
    const draft1 = await page.locator(".composer textarea").inputValue();
    const notes1 = await page.locator(".conversation-error, .conversation-note").allTextContents();
    await shot(page, "chat-send-response-lost-1");
    const shownUsers1 = await users(page);
    let retried = false;
    if (draft1.trim()) { await page.locator(".composer textarea").press("Enter"); retried = true; }
    await shows(page, " end", 30_000);
    await idle(page);
    await delay(1000);
    const server = await serverView(lab, "/api/optchat");
    fs.writeFileSync(path.join(OUT, "chat-send-response-lost.json"), JSON.stringify({ draft1, notes1, shownUsers1, retried, prompts: lost, server: { users: server.users, agents: server.agents, status: server.status }, shownUsers: await users(page), notesAfter: await page.locator(".conversation-error, .conversation-note").allTextContents(), draftAfter: await page.locator(".composer textarea").inputValue() }, null, 2));
    await shot(page, "chat-send-response-lost-2");
    await compare(page, lab, "/api/optchat", "chat-send-response-lost");
    assert.deepEqual(server.users, ["words 20"], "the message is in the log once");
  },
  async "thread-send-response-lost"(lab) {
    const id = await newThread(lab, bash("echo first"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "result: first" }).first().waitFor({ timeout: 30_000 });
    await idle(page, ACTIVE);
    let lost = 0;
    await page.route(`**/api/threads/${id}/prompt`, async route => {
      if (lost++ === 0) { await route.fetch(); await route.abort("connectionreset"); return; }
      await route.continue();
    });
    await send(page, "words 20", ACTIVE);
    await delay(2000);
    const draft1 = await page.locator(`${ACTIVE} .composer textarea`).inputValue();
    const notes1 = await page.locator(".conversation-error, .conversation-note").allTextContents();
    await shot(page, "thread-send-response-lost-1");
    if (draft1.trim()) await page.locator(`${ACTIVE} .composer textarea`).press("Enter");
    await shows(page, " end", 30_000);
    await idle(page, ACTIVE);
    await delay(1000);
    const server = await serverView(lab, `/api/threads/${id}`);
    fs.writeFileSync(path.join(OUT, "thread-send-response-lost.json"), JSON.stringify({ draft1, notes1, prompts: lost, users: server.users, shownUsers: await users(page, ACTIVE), notesAfter: await page.locator(".conversation-error, .conversation-note").allTextContents() }, null, 2));
    await compareThread(page, lab, id, "thread-send-response-lost");
    assert.equal(server.users.filter((u: string) => u === "words 20").length, 1, "the message is in the log once");
  },

  async "thread-queued-then-starts"(lab) {
    const first = await newThread(lab, bash("echo first"));
    await delay(4000);
    const second = await newThread(lab, "words 10");
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${second}`);
    const seen: string[] = [];
    const sample = async (tag: string) => {
      const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === second);
      const text = (await page.locator(`${ACTIVE} .conversation`).first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
      const notes = (await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ");
      seen.push(`${tag} list=${list?.state} sleep=${JSON.stringify(list?.vm?.suspension ?? null)} ui=${text} notes=${notes}`);
    };
    for (let i = 0; i < 4; i++) { await sample(`q${i}`); await delay(1000); }
    await shot(page, "thread-queued-1");
    await lab.api(`/api/threads/${first}`, { method: "DELETE" });
    for (let i = 0; i < 40; i++) { await sample(`a${i}`); if (seen.at(-1)!.includes(" end")) break; await delay(1000); }
    fs.writeFileSync(path.join(OUT, "thread-queued-then-starts.txt"), seen.join("\n"));
    await shot(page, "thread-queued-2");
    await shows(page, " end", 30_000);
    await idle(page, ACTIVE);
    await compareThread(page, lab, second, "thread-queued-then-starts");
  },

  async "thread-steer-then-restart"(lab) {
    const id = await newThread(lab, bash("echo begin; sleep 8; echo finished"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "begin" }).first().waitFor({ timeout: 30_000 });
    await send(page, "steered words", ACTIVE);
    await page.locator(".conversation-message.user:not(.sending)", { hasText: "steered words" }).waitFor({ timeout: 10_000 });
    const before = await serverView(lab, `/api/threads/${id}`);
    await lab.restart();
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await serverView(lab, `/api/threads/${id}`);
      const notes = (await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ");
      seen.push(`${i}s state=${v.status.state} err=${v.status.error} users=${JSON.stringify(v.users)} agents=${JSON.stringify(v.agents.map((a: string) => a.slice(0, 40)))} notes=${notes}`);
      if (v.status.state !== "working" && i > 3) break;
      await delay(1000);
    }
    await idle(page, ACTIVE);
    await delay(1500);
    fs.writeFileSync(path.join(OUT, "thread-steer-then-restart.txt"), `before restart: ${JSON.stringify({ status: before.status, users: before.users })}\n${seen.join("\n")}\nshown users: ${JSON.stringify(await users(page, ACTIVE))}\nshown agents: ${JSON.stringify(await agents(page, ACTIVE))}\nnotes: ${(await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ")}`);
    await shot(page, "thread-steer-then-restart");
    await compareThread(page, lab, id, "thread-steer-then-restart");
  },

  async "crash-chat-mid-stream"(lab) {
    await lab.toChild();
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/chat`);
    await send(page, "words 300");
    await shows(page, "w20 ");
    await lab.crash();
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      const v = await serverView(lab, "/api/optchat");
      const busy = await page.locator(".composer").getAttribute("aria-busy");
      const notes = (await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ");
      seen.push(`${i}s state=${v.status.state} err=${v.status.error} agents=${v.agents.length}:${(v.agents.at(-1) ?? "").slice(-30)} busy=${busy} notes=${notes}`);
      if (v.status.state !== "working" && busy === "false" && i > 2) break;
      await delay(1000);
    }
    fs.writeFileSync(path.join(OUT, "crash-chat-mid-stream.txt"), seen.join("\n"));
    await shot(page, "crash-chat-mid-stream-1");
    await idle(page);
    await compare(page, lab, "/api/optchat", "crash-chat-mid-stream");
    await send(page, "after crash");
    await shows(page, "ok: after crash");
    await idle(page);
    await page.reload();
    await idle(page);
    await shot(page, "crash-chat-mid-stream-2");
    await compare(page, lab, "/api/optchat", "crash-chat-mid-stream-2");
  },
  async "crash-thread-mid-tool"(lab) {
    await lab.toChild();
    const id = await newThread(lab, bash("echo begin; sleep 6; echo finished >> runs.txt; echo finished"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "begin" }).first().waitFor({ timeout: 30_000 });
    await lab.crash();
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      let v: any; try { v = await serverView(lab, `/api/threads/${id}`); } catch (error) { v = { status: { state: String(error).slice(0, 120) }, agents: [] }; }
      const list = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id);
      const busy = await page.locator(`${ACTIVE} .composer`).getAttribute("aria-busy");
      const notes = (await page.locator(".conversation-note, .conversation-error").allTextContents()).join(" | ");
      seen.push(`${i}s list=${list?.state} state=${v.status.state} err=${v.status.error} agents=${JSON.stringify(v.agents.map((a: string) => a.slice(0, 50)))} busy=${busy} notes=${notes}`);
      if (v.status.state !== "working" && busy === "false" && i > 3) break;
      await delay(1000);
    }
    fs.writeFileSync(path.join(OUT, "crash-thread-mid-tool.txt"), seen.join("\n"));
    await shot(page, "crash-thread-mid-tool-1");
    await idle(page, ACTIVE);
    await compareThread(page, lab, id, "crash-thread-mid-tool");
    await send(page, bash("cat runs.txt"), ACTIVE);
    await page.locator(".conversation-message.assistant", { hasText: "result: finished" }).last().waitFor({ timeout: 30_000 });
    await idle(page, ACTIVE);
    await compareThread(page, lab, id, "crash-thread-mid-tool-2");
  },

  async "first-reply-enter"(lab) {
    const runs = Number(process.env.LAB_RUNS ?? 15);
    const lines: string[] = [];
    let ignored = 0;
    const page = await browser.newPage();
    for (let i = 0; i < runs; i++) {
      await page.goto(`${lab.url}/#/projects/${lab.projectId}`);
      await page.getByRole("button", { name: "new thread" }).click();
      const dialog = page.locator("dialog.new-thread-dialog");
      await dialog.getByRole("textbox", { name: "first message" }).fill(`hello ${i}`);
      await dialog.getByRole("button", { name: "start thread" }).click();
      await page.waitForURL(/#\/t\/[^/]+$/);
      const id = decodeURIComponent(page.url().split("#/t/")[1]!);
      await page.locator(`${ACTIVE} .conversation-message.assistant`, { hasText: `ok: hello ${i}` }).waitFor({ timeout: 30_000 });
      const composer = page.locator(`${ACTIVE} .composer textarea`);
      await composer.fill(`next ${i}`);
      const placeholder = await composer.getAttribute("placeholder");
      const listState = (await lab.api("/api/threads")).threads.find((t: any) => t.id === id)?.state;
      await composer.press("Enter");
      let sent = true;
      try { await page.locator(`${ACTIVE} .conversation-message.user`, { hasText: `next ${i}` }).waitFor({ timeout: 1000 }); } catch { sent = false; }
      if (!sent) ignored++;
      await page.locator(`${ACTIVE} .conversation-message.assistant`, { hasText: `ok: next ${i}` }).waitFor({ timeout: 15_000 }).catch(() => {});
      const server = await serverView(lab, `/api/threads/${id}`);
      lines.push(`run ${i}: placeholder="${placeholder}" api=${listState} sentWithin1s=${sent} hostUsers=${JSON.stringify(server.users)}`);
      if (server.users.filter((u: string) => u === `next ${i}`).length > 1) throw new Error(`duplicate send in run ${i}`);
      await lab.api(`/api/threads/${id}`, { method: "DELETE" }).catch(() => {});
    }
    fs.writeFileSync(path.join(OUT, `first-reply-enter-${process.env.LAB_TAG ?? "x"}.txt`), `${lines.join("\n")}\nignored ${ignored}/${runs}\n`);
    console.log(`ignored ${ignored}/${runs}`);
    if (ignored) throw new Error(`Enter ignored in ${ignored}/${runs} runs`);
  },

  async "thread-steer-then-stop"(lab) {
    const id = await newThread(lab, bash("echo begin; sleep 20; echo late"));
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await page.locator(".conversation", { hasText: "begin" }).first().waitFor({ timeout: 30_000 });
    await send(page, "please also check the logs", ACTIVE);
    await page.locator(".conversation-message.user:not(.sending)", { hasText: "please also check the logs" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /stop/ }).first().click();
    await idle(page, ACTIVE);
    await delay(500);
    const server = await serverView(lab, `/api/threads/${id}`);
    const shown = (await page.locator(`${ACTIVE} .conversation`).first().innerText()).replace(/\s+/g, " ");
    fs.writeFileSync(path.join(OUT, "thread-steer-then-stop.json"), JSON.stringify({ status: server.status, users: server.users, shownTail: shown.slice(-300) }, null, 2));
    await shot(page, "thread-steer-then-stop");
    if (server.status.error) assert.ok(shown.includes(server.status.error), `the run's reason shows: ${server.status.error}`);
  },
  async "crash-thread-mid-stream"(lab) {
    await lab.toChild();
    const id = await newThread(lab, "words 400");
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await shows(page, "w20 ", 30_000, ACTIVE);
    await lab.crash();
    await delay(6000);
    await idle(page, ACTIVE);
    const server = await serverView(lab, `/api/threads/${id}`);
    const shown = (await page.locator(`${ACTIVE} .conversation`).first().innerText()).replace(/\s+/g, " ");
    fs.writeFileSync(path.join(OUT, "crash-thread-mid-stream.json"), JSON.stringify({ status: server.status, shownTail: shown.slice(-300) }, null, 2));
    await shot(page, "crash-thread-mid-stream");
    await page.setViewportSize({ width: 390, height: 844 });
    await delay(500);
    await shot(page, "crash-thread-mid-stream-phone");
    if (server.status.error) assert.ok(shown.includes(server.status.error), `the run's reason shows: ${server.status.error}`);
  },

  async "thread-steer-mid-stream-then-stop"(lab) {
    const id = await newThread(lab, "words 400");
    const page = await browser.newPage();
    await page.goto(`${lab.url}/#/t/${id}`);
    await shows(page, "w10 ", 30_000, ACTIVE);
    await send(page, "one more thing", ACTIVE);
    await delay(300);
    const atStop = (await agents(page, ACTIVE)).at(-1)?.trim().split(/\s+/).at(-1);
    const t0 = Date.now();
    await page.getByRole("button", { name: /stop/ }).first().click();
    const stopRequests = () => 0;
    await idle(page, ACTIVE);
    const idleMs = Date.now() - t0;
    await delay(800);
    fs.writeFileSync(path.join(OUT, "steer-stop-timing.txt"), `last word at stop click: ${atStop}; idle after ${idleMs} ms; ${stopRequests()}`);
    const server = await serverView(lab, `/api/threads/${id}`);
    const shown = (await page.locator(`${ACTIVE} .conversation`).first().innerText()).replace(/\s+/g, " ");
    fs.writeFileSync(path.join(OUT, "thread-steer-mid-stream-then-stop.json"), JSON.stringify({ status: server.status, users: server.users, shownUsers: await users(page, ACTIVE), shownTail: shown.slice(-200) }, null, 2));
    await shot(page, "thread-steer-mid-stream-then-stop");
    if (server.status.error) assert.ok(shown.includes(server.status.error), `the run's reason shows: ${server.status.error}`);
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
for (const name of names) {
  const lab = await startLab(`/tmp/lab-scratch/${name}`, Number(process.env.LAB_TPS ?? 30));
  const t0 = Date.now();
  try {
    await SCENARIOS[name]!(lab);
    results.push(`ok ${name} (${Date.now() - t0} ms)`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    for (const [i, page] of browser.contexts().flatMap(c => c.pages()).entries()) await page.screenshot({ path: path.join(OUT, `${name}-failure-${i}.png`) }).catch(() => {});
  } finally {
    for (const page of browser.contexts().flatMap(c => c.pages())) await page.close().catch(() => {});
    await lab.close().catch(() => {});
  }
  console.log(results.at(-1));
}
await browser.close();
console.log(results.join("\n"));
void words;
process.exit(0);
