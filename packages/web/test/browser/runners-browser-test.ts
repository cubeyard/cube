/** The runners on a project's page in a real browser against the real
 * cubed, at desktop and phone width: each runner's protocol (p4 vm in the
 * pool, p4 host by name only, p3 no longer supported and never checked),
 * p4's slots, the p3 runners still enrolled and their unarchived threads,
 * and which numbers are not current (a stale report, a runner that never
 * reported). Runner reports are faked through
 * cubed's probe. CUBE_SCREENSHOTS=<dir> keeps a picture of each width.
 * Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Locator, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";
import type { TrustedRunnerHealth } from "../../../server/src/runner-types.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const errors: string[] = [];
/** An element's text colour, and the theme's error ink, as the browser computes them. */
const inkOf = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).color);
const badInk = (page: Page) => page.evaluate(() => {
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.color = "var(--bad)";
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
});
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 1, runningVms: 1, maxActiveVms: 3,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.9.0", protocolVersion: 4, kind: "vm", platform: "linux-x86_64", capabilities: [] };
// Only pool-a answers; the others' probes fail. The p3 runners are never asked.
const asked: string[] = [];
const host = await startChatHost({ runnerHealth: async runner => {
  asked.push(runner.nodeId);
  if (runner.nodeId === "pool-a") return { ...health };
  throw new Error("NODE_UNAVAILABLE");
} });
const browser = await chromium.launch();
try {
  const { registry } = host;
  registry.saveProject({ id: "p", name: "runners", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const binding = (id: string, maxActiveVms: number) => ({ nodeId: id, environmentId: 1, threadId: id, configPath: `/nonexistent/${id}.json`, configHash: id, maxActiveVms });
  registry.enrollRunner({ ...binding("pool-a", 3), protocol: 4, kind: "vm" });
  registry.enrollRunner({ ...binding("berth-vm", 2), protocol: 4, kind: "vm" });
  registry.enrollRunner({ ...binding("berth-host", 1), protocol: 4, kind: "host" });
  // Two protocol-3 runners from before, one with a report it sent then.
  registry.enrollRunner(binding("old-a", 3));
  registry.enrollRunner(binding("old-b", 1));
  registry.recordRunnerProbe("old-a", { health: { ...health, protocolVersion: 3, kind: undefined, softwareVersion: "0.8.4" } });
  // berth-vm answered once; the page's own check fails, so that report is stale.
  registry.recordRunnerProbe("berth-vm", { health: { ...health, softwareVersion: "0.1.0", maxActiveVms: 2 } });
  const model = { provider: "fixture", id: "m" };
  for (const id of ["one", "two"]) registry.createThread("p", id, model, id, "pi", undefined, { runnerId: "pool-a" });
  registry.createThread("p", "named", model, "named", "pi", undefined, { runnerId: "berth-vm" });
  // A thread old-a took before protocol 3 was retired, still open: its row says protocol 4 while it is made.
  const sqlite = new DatabaseSync(path.join(host.state, "registry.sqlite"));
  sqlite.prepare("UPDATE runner SET data=json_set(data,'$.protocol',4,'$.kind','vm') WHERE id='old-a'").run();
  registry.createThread("p", "legacy", model, "legacy", "pi", undefined, { runnerId: "old-a" });
  sqlite.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='old-a'").run();
  // An archived thread of old-b whose disk was kept: it stays on that host.
  sqlite.prepare("UPDATE runner SET data=json_set(data,'$.protocol',4,'$.kind','vm') WHERE id='old-b'").run();
  const kept = registry.createThread("p", "kept", model, "kept", "pi", undefined, { runnerId: "old-b" });
  sqlite.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='old-b'").run();
  sqlite.close();
  registry.updateThreadVm(kept.id, { retain: true, retainReason: "dirty: work not pushed" });
  registry.beginRelease(kept.id);
  registry.finishRelease(kept.id);
  // A project whose check failed: its status word is a failure, in error ink.
  // Its one thread (made while it was ready, archived since) has a store
  // that cannot be read: its usage is unknown.
  const broken = { id: "broken", name: "broken", status: "ready" as const, error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] };
  registry.saveProject(broken);
  const unread = registry.createThread("broken", "unread", { provider: "fixture", id: "m" }, "unread", "pi", undefined, { runnerId: "pool-a" });
  fs.mkdirSync(path.join(host.state, "threads", unread.id), { recursive: true });
  fs.writeFileSync(path.join(host.state, "threads", unread.id, "pi.sqlite"), "not a store");
  registry.beginRelease(unread.id);
  registry.finishRelease(unread.id);
  registry.saveProject({ ...broken, status: "error", error: "github: repository not found" });

  for (const [viewport, name] of [[{ width: 1280, height: 900 }, "desktop"], [{ width: 390, height: 844 }, "phone"]] as const) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${host.url}/#/projects/p`);
    const panel = page.locator(".runner-panel");
    // After the page's own check of every runner.
    await panel.locator(".runner-row", { hasText: "berth-vm" }).locator(".runner-evidence strong", { hasText: "unreachable" }).waitFor();
    await panel.locator(".capacity-late", { hasText: "berth-vm (stale report)" }).waitFor();
    assert.equal(await panel.locator("h2#runner-heading").textContent(), "runners");
    const label = (node: string) => panel.locator(".runner-row", { hasText: node }).locator(".runner-protocol").textContent();
    assert.equal(await label("pool-a"), "p4 vm · pool");
    assert.equal(await label("berth-vm"), "p4 vm · pool");
    assert.equal(await label("berth-host"), "p4 host · unsandboxed, by name only");
    assert.equal(await label("old-a"), "p3 · no longer supported");
    assert.equal(await label("old-b"), "p3 · no longer supported");
    assert.match(await panel.locator(".runner-row", { hasText: "old-a" }).textContent() ?? "", /protocol 3: cube no longer contacts this runner/);
    const oldB = panel.locator(".runner-row", { hasText: "old-b" });
    assert.equal(await oldB.locator("button", { hasText: "check" }).count(), 0, "a p3 runner has no check");
    assert.equal(await oldB.locator("button", { hasText: "retire" }).isEnabled(), true, "a p3 runner with no open thread can be retired without a check");
    assert.match(await panel.locator(".runner-row", { hasText: "old-a" }).locator(".runner-blocked").textContent() ?? "", /retirement waits until its threads are archived/);
    const keptRow = page.locator(".runner-row", { hasText: "dirty: work not pushed" });
    await keptRow.waitFor();
    assert.match(await keptRow.textContent() ?? "", /on a protocol-3 runner: cube no longer reaches it, so the disk stays on that runner's host/);
    assert.equal(await keptRow.locator("button", { hasText: "discard" }).count(), 0, "no discard for a disk on a p3 runner");
    // pool-a reported 3 slots and holds 2 open threads; berth-vm 2 with 1 from its stale report.
    assert.equal(await panel.locator(".capacity-p4").textContent(), "p4 · vm pool 2 free of 5 slots · host by name 1 free of 1 slot");
    assert.equal(await panel.locator(".capacity-p3").textContent(), "p3 · no longer supported: 2 runners still enrolled, never contacted · unarchived p3 threads: 1");
    assert.equal(await panel.locator(".capacity-late").textContent(), "not current: berth-vm (stale report), berth-host (never reported)");
    assert.match(await panel.locator(".capacity-note").textContent() ?? "", /a slot is an open thread in cube, not a machine on the runner/);
    assert.ok(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), `no sideways scroll (${name})`);
    // The page scrolls in its pane, under a sticky header: the capacity lines go mid-screen.
    await panel.locator(".runner-capacity").evaluate(element => element.scrollIntoView({ block: "center" }));
    await shoot(page, `${name}-runners`);

    if (shots) await panel.screenshot({ path: path.join(shots, `${name}-runners-panel.png`) });
    await page.close();
  }
  // The project in error: its status word in error ink, not quiet grey.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${host.url}/#/projects/broken`);
    const status = page.locator(".project-state-readout .error", { hasText: "error" });
    await status.waitFor();
    assert.equal(await inkOf(status), await badInk(page), "a project's error status is printed in error ink");
    // Its usage that could not be read: "usage unknown" in error ink, as its lamp was red.
    const unknown = page.locator(".usage-total strong.error", { hasText: "usage unknown" });
    await unknown.waitFor();
    assert.equal(await inkOf(unknown), await badInk(page), "usage unknown is printed in error ink");
    assert.notEqual(await inkOf(page.locator(".usage-total small")), await badInk(page), "the rest stays quiet");
    await page.close();
  }
} finally {
  await browser.close();
  await host.close();
}
assert.deepEqual(errors, [], "no script errors");
assert.ok(asked.length && !asked.some(node => node.startsWith("old-")), `the p3 runners are never checked: ${asked.join(" ")}`);
console.log("runners browser: ok");
process.exit(0);
