import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentCache } from "../src/environment-cache.ts";
import { removeStoppedTree } from "@cube/sandbox";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "environment-cache-")); roots.push(value); return value; };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const builder = (fingerprint: string, contents = "x") => async (directory: string, warm?: string) => {
  fs.mkdirSync(path.join(directory, "workspace"));
  fs.writeFileSync(path.join(directory, "workspace", "file"), contents);
  return fingerprint + (warm ? `-from-${warm}` : "");
};

try {
  // Exact flights coalesce and snapshots persist across cache instances.
  {
    const directory = root(); let builds = 0; const gate = deferred();
    const cache = new EnvironmentCache(directory, 1_000, async () => {});
    const build = async (dir: string) => { builds++; await gate.promise; return builder("image")(dir); };
    const a = cache.use("family", 1, 10, build, async (f) => f);
    const b = cache.use("family", 1, 10, build, async (f) => f);
    gate.resolve();
    assert.deepEqual(await Promise.all([a, b]), ["image", "image"]);
    assert.equal(builds, 1);
    const restarted = new EnvironmentCache(directory, 1_000, async () => {});
    assert.equal(await restarted.use("family", 1, 10, async () => { throw new Error("rebuilt"); }, async (f) => f), "image");
  }

  // Revisions in one family warm; another family does not. Failed builds publish nothing.
  {
    const directory = root(); const cache = new EnvironmentCache(directory, 10_000, async () => {});
    await cache.use("a", 1, 0, builder("one"), async () => {});
    let warm: string | undefined;
    await cache.use("a", 2, 0, async (dir, value) => { warm = value; return builder("two")(dir); }, async () => {});
    assert.equal(warm, "one");
    await cache.use("b", 1, 0, async (dir, value) => { assert.equal(value, undefined); return builder("other")(dir); }, async () => {});
    await assert.rejects(cache.use("a", 3, 0, async (dir) => { fs.mkdirSync(path.join(dir, "workspace")); throw new Error("boom"); }, async () => {}), /boom/);
    assert.equal(fs.readdirSync(directory).filter((d) => fs.existsSync(path.join(directory, d, "manifest.json"))).length, 3);
  }

  // Actual workspace bytes plus reserved quota drive LRU; active leases survive eviction.
  {
    const directory = root(); const deleted: string[] = [];
    const cache = new EnvironmentCache(directory, 7, async (f) => { deleted.push(f); });
    const held = deferred(); const entered = deferred();
    const first = cache.use("a", 1, 3, builder("old", "12345"), async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    await cache.use("b", 1, 3, builder("new", "12345"), async () => {});
    assert.ok(!deleted.includes("old"), "leased snapshot was retained");
    held.resolve(); await first;
    await cache.prune();
    assert.ok(deleted.includes("old"));
  }

  // Prune failures after consumption are diagnostics, not provisioning failures.
  {
    const cache = new EnvironmentCache(root(), 0, async () => { throw new Error("delete failed"); });
    assert.equal(await cache.use("a", 1, 1, builder("image"), async () => "provisioned"), "provisioned");
    assert.match(String(cache.takeDiagnostics()[0]), /delete failed/);
  }

  // Interrupted eviction is completed before use, preventing directory reuse races.
  {
    const directory = root(); const seed = new EnvironmentCache(directory, 100, async () => {});
    await seed.use("a", 1, 0, builder("stale"), async () => {});
    const entryDir = path.join(directory, fs.readdirSync(directory)[0]!);
    fs.renameSync(path.join(entryDir, "manifest.json"), path.join(entryDir, "deleting.json"));
    const deletion = deferred(); let buildStarted = false;
    const recovered = new EnvironmentCache(directory, 100, async () => { await deletion.promise; });
    const use = recovered.use("a", 1, 0, async (dir) => { buildStarted = true; return builder("fresh")(dir); }, async (f) => f);
    await new Promise((r) => setImmediate(r)); assert.equal(buildStarted, false);
    deletion.resolve(); assert.equal(await use, "fresh");
  }

  // A truncated publication is not a usable cache and must reconcile the
  // deterministic image alias, including the publish-before-manifest window.
  {
    const directory = root();
    const key = "a".repeat(64);
    fs.mkdirSync(path.join(directory, key));
    fs.writeFileSync(path.join(directory, key, "manifest.tmp"), '{"key":');
    const orphanKeys: string[] = [];
    const cache = new EnvironmentCache(directory, 100, async () => {}, async (value) => { orphanKeys.push(value); });
    await cache.recover();
    assert.deepEqual(orphanKeys, [key]);
    assert.equal(fs.existsSync(path.join(directory, key)), false);
  }

  // Cleanup handles populated read-only directories without following links.
  {
    const source = root(), outside = root();
    fs.writeFileSync(path.join(source, "file"), "data");
    fs.writeFileSync(path.join(outside, "file"), "keep");
    fs.symlinkSync(outside, path.join(source, "link"));
    fs.chmodSync(outside, 0o555);
    fs.chmodSync(source, 0o555);
    removeStoppedTree(source);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(outside, "file"), "utf8"), "keep");
    assert.equal(fs.statSync(outside).mode & 0o777, 0o555);
    removeStoppedTree(outside);
  }
  console.log("PASS: environment cache coalescing, warming, leases, budget, recovery, and safe cleanup");
} finally {
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
}
