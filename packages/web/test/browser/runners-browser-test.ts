/** The runners on a project's page in a real browser against the real
 * cubed, at desktop and phone width: each runner's protocol (p3, p4 vm or
 * p4 host, by name only), the p3 pool's free slots and open p3 threads, p4's
 * slots apart from the pool, and which numbers are not current (a stale
 * report, a runner that never reported). Runner reports are faked through
 * cubed's probe. CUBE_SCREENSHOTS=<dir> keeps a picture of each width.
 * Needs a built UI (pnpm build) and Playwright's Chromium. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { startChatHost } from "../../../server/test/chat-fixture.ts";
import type { TrustedRunnerHealth } from "../../../server/src/iroh-node.ts";

const shots = process.env.CUBE_SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const shoot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
const errors: string[] = [];
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 1, runningVms: 1, maxActiveVms: 3,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "0.9.0", protocolVersion: 3, platform: "linux-x86_64", capabilities: [] };
// Only pool-a answers; the others' probes fail.
const host = await startChatHost({ runnerHealth: async runner => {
  if (runner.nodeId === "pool-a") return { ...health };
  throw new Error("NODE_UNAVAILABLE");
} });
const browser = await chromium.launch();
try {
  const { registry } = host;
  registry.saveProject({ id: "p", name: "runners", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const binding = (id: string, maxActiveVms: number) => ({ nodeId: id, environmentId: 1, threadId: id, configPath: `/nonexistent/${id}.json`, configHash: id, maxActiveVms });
  registry.enrollRunner(binding("pool-a", 3));
  registry.enrollRunner(binding("pool-b", 1));
  registry.enrollRunner({ ...binding("berth-vm", 2), protocol: 4, kind: "vm" });
  registry.enrollRunner({ ...binding("berth-host", 1), protocol: 4, kind: "host" });
  // berth-vm answered once; the page's own check fails, so that report is stale.
  registry.recordRunnerProbe("berth-vm", { health: { ...health, protocolVersion: 4, kind: "vm", softwareVersion: "0.1.0", maxActiveVms: 2 } });
  const model = { provider: "fixture", id: "m" };
  for (const id of ["one", "two", "gone"]) registry.createThread("p", id, model, id, "pi", undefined, { runnerId: "pool-a" });
  registry.finishRelease(registry.threadByRequest("p", "gone")!.id);
  registry.createThread("p", "named", model, "named", "pi", undefined, { runnerId: "berth-vm" });

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
    assert.equal(await label("pool-a"), "p3");
    assert.equal(await label("pool-b"), "p3");
    assert.equal(await label("berth-vm"), "p4 vm · by name only");
    assert.equal(await label("berth-host"), "p4 host · unsandboxed, by name only");
    // pool-a reported 3 slots and holds 2 open threads (the archived one is not); pool-b's one slot is assumed.
    assert.equal(await panel.locator(".capacity-p3").textContent(), "p3 pool · 2 free of 4 slots on 2 runners · open p3 threads: 2");
    assert.equal(await panel.locator(".capacity-p4").textContent(), "p4 by name · vm 1 free of 2 slots · host 1 free of 1 slot");
    assert.equal(await panel.locator(".capacity-late").textContent(), "not current: berth-vm (stale report), pool-b (never reported), berth-host (never reported)");
    assert.match(await panel.locator(".capacity-note").textContent() ?? "", /a slot is an open thread in cube, not a machine on the runner/);
    assert.ok(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth), `no sideways scroll (${name})`);
    // The page scrolls in its pane, under a sticky header: the capacity lines go mid-screen.
    await panel.locator(".runner-capacity").evaluate(element => element.scrollIntoView({ block: "center" }));
    await shoot(page, `${name}-runners`);
    if (shots) await panel.screenshot({ path: path.join(shots, `${name}-runners-panel.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  await host.close();
}
assert.deepEqual(errors, [], "no script errors");
console.log("runners browser: ok");
process.exit(0);
