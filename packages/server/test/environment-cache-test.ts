import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentCache, EnvironmentCacheBusyError, EnvironmentCacheSuspendedError } from "../src/environment-cache.ts";
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
  // Unresolved entries occupy the host too: they count toward the budget at
  // the size their build was admitted with, and evict usable snapshots.
  {
    const directory = root(); const deleted: string[] = [];
    const stuck = "b".repeat(64);
    fs.mkdirSync(path.join(directory, stuck));
    fs.writeFileSync(path.join(directory, stuck, "publication.json"), "{}");
    fs.writeFileSync(path.join(directory, stuck, "reservation.json"), JSON.stringify({ reservedBytes: 6 }));
    const cache = new EnvironmentCache(directory, 10, async (f) => { deleted.push(f); }, async (key) => { if (key === stuck) throw new Error("image still publishing"); });
    await cache.recover();
    assert.deepEqual(cache.quarantined(), [{ key: stuck, reason: "unpublished", reservedBytes: 6 }]);
    assert.match(String(cache.takeDiagnostics()[0]), /still publishing/);
    await cache.use("a", 1, 3, builder("old"), async () => {});
    assert.deepEqual(deleted, [], "6 quarantined + 3 fits the budget of 10");
    await cache.use("b", 1, 3, builder("new"), async () => {});
    assert.deepEqual(deleted, ["old"], "6 quarantined + 3 + 3 does not: the LRU snapshot goes");
    assert.equal(fs.existsSync(path.join(directory, stuck)), true, "the ambiguous publication is never deleted by eviction");
  }

  // Sizes of unresolved entries: an interrupted eviction keeps its manifest's
  // reservation; a bare directory takes the configured unknown-entry size.
  {
    const directory = root();
    const evicting = "c".repeat(64), bare = "d".repeat(64);
    fs.mkdirSync(path.join(directory, evicting));
    fs.writeFileSync(path.join(directory, evicting, "deleting.json"), JSON.stringify({ key: evicting, family: "e".repeat(64), fingerprint: "gone", reservedBytes: 4, usedAt: 1 }));
    fs.mkdirSync(path.join(directory, bare));
    const cache = new EnvironmentCache(directory, 100, async (f) => { if (f === "gone") throw new Error("image busy"); }, async () => { throw new Error("no reconcile"); }, { unknownEntryBytes: 5 });
    await cache.recover();
    assert.deepEqual(cache.quarantined().sort((a, b) => a.key.localeCompare(b.key)), [
      { key: evicting, reason: "deleting", reservedBytes: 4 },
      { key: bare, reason: "unknown", reservedBytes: 5 },
    ]);
  }

  // maintain() retries quarantined cleanups; prune() only accounts for them.
  {
    const directory = root(); let attempts = 0;
    const stuck = "f".repeat(64);
    fs.mkdirSync(path.join(directory, stuck));
    fs.writeFileSync(path.join(directory, stuck, "publication.json"), "{}");
    const cache = new EnvironmentCache(directory, 100, async () => {}, async () => { attempts++; if (attempts < 3) throw new Error(`attempt ${attempts} failed`); });
    await cache.recover();
    assert.equal(attempts, 1); assert.equal(cache.quarantined().length, 1);
    await cache.prune();
    assert.equal(attempts, 1, "eviction passes do not retry");
    await cache.maintain();
    assert.equal(attempts, 2); assert.equal(cache.quarantined().length, 1);
    assert.equal(cache.takeDiagnostics().length, 2);
    await cache.maintain();
    assert.equal(attempts, 3); assert.deepEqual(cache.quarantined(), []);
    assert.equal(fs.existsSync(path.join(directory, stuck)), false);
  }

  // Past the unresolved limit no new build is admitted — an existing
  // snapshot is still served; a new key is refused with a typed error and
  // leaves nothing behind.
  {
    const directory = root();
    const seed = new EnvironmentCache(directory, 100, async () => {});
    await seed.use("keep", 1, 1, builder("kept"), async () => {});
    for (const digit of ["1", "2", "3", "4"]) {
      const key = digit.repeat(64);
      fs.mkdirSync(path.join(directory, key));
      fs.writeFileSync(path.join(directory, key, "publication.json"), "{}");
    }
    const cache = new EnvironmentCache(directory, 100, async () => {}, async () => { throw new Error("cannot reconcile"); });
    await cache.recover();
    assert.equal(cache.quarantined().length, 4);
    let built = false;
    await assert.rejects(
      cache.use("fresh", 1, 1, async (dir) => { built = true; return builder("x")(dir); }, async () => {}),
      EnvironmentCacheSuspendedError,
    );
    assert.equal(built, false);
    assert.equal(await cache.use("keep", 1, 1, async () => { throw new Error("rebuilt"); }, async (f) => f), "kept");
    assert.equal(fs.readdirSync(directory).length, 5, "the refused key left no directory");
    // A build that was admitted records what it was admitted with.
    const kept = fs.readdirSync(directory).find((name) => fs.existsSync(path.join(directory, name, "manifest.json")))!;
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, kept, "reservation.json"), "utf8")).reservedBytes, 1);
  }
  // A maintenance pass is bounded: at most N entries per pass, each call
  // under its own deadline — one stalled Incus request costs one deadline,
  // not the pass, and never a thread.
  {
    const directory = root();
    for (const digit of ["1", "2", "3"]) {
      const key = digit.repeat(64);
      fs.mkdirSync(path.join(directory, key));
      fs.writeFileSync(path.join(directory, key, "publication.json"), "{}");
    }
    const attempted: string[] = [];
    const hang = (key: string, { signal }: { signal: AbortSignal }) => new Promise<void>((_, reject) => {
      attempted.push(key);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const cache = new EnvironmentCache(directory, 100, async () => {}, hang, { callTimeoutMs: 50, maxAttemptsPerPass: 2 });
    const started = Date.now();
    await cache.recover();
    assert.equal(attempted.length, 2, "boot recovery attempts one bounded batch");
    assert.ok(Date.now() - started < 1_000, "each attempt ended at its deadline");
    assert.equal(cache.takeDiagnostics().length, 2);
    assert.equal(cache.quarantined().length, 3, "timed-out journals are preserved, not deleted");
    await cache.maintain();
    assert.equal(attempted.length, 4, "the next pass attempts another batch");
    assert.equal(cache.quarantined().length, 3);
  }

  // use() waits on a running maintenance pass only briefly, then reports
  // the cache busy so the thread sets up fresh; once the pass settles the
  // cache serves again.
  {
    const directory = root();
    const stuck = "e".repeat(64);
    fs.mkdirSync(path.join(directory, stuck));
    fs.writeFileSync(path.join(directory, stuck, "publication.json"), "{}");
    const gate = deferred();
    const cache = new EnvironmentCache(directory, 100, async () => {}, async () => { await gate.promise; }, { waitMs: 100 });
    let built = false;
    const started = Date.now();
    await assert.rejects(
      cache.use("a", 1, 1, async (dir) => { built = true; return builder("late")(dir); }, async (f) => f),
      EnvironmentCacheBusyError,
    );
    assert.ok(Date.now() - started < 1_000 && !built, "gave up within the bound, without building");
    gate.resolve();
    await cache.recover();
    assert.deepEqual(cache.quarantined(), []);
    assert.equal(await cache.use("a", 1, 1, builder("later"), async (f) => f), "later");
  }
  // Resources a failed build left outside the cache directory (a builder
  // whose teardown failed, reported by the owner) count like quarantined
  // entries: toward the admission limit and toward the budget.
  {
    const directory = root(); const deleted: string[] = [];
    let pending = { count: 0, bytes: 0 };
    const cache = new EnvironmentCache(directory, 10, async (f) => { deleted.push(f); }, undefined, { retained: () => pending });
    await cache.use("a", 1, 3, builder("old"), async () => {});
    pending = { count: 1, bytes: 6 };
    await cache.use("b", 1, 3, builder("new"), async () => {});
    assert.deepEqual(deleted, ["old"], "a pending builder's reservation evicts like a quarantined entry");
    pending = { count: 4, bytes: 0 };
    let built = false;
    await assert.rejects(
      cache.use("c", 1, 1, async (dir) => { built = true; return builder("refused")(dir); }, async () => {}),
      (error: unknown) => error instanceof EnvironmentCacheSuspendedError && error.unresolved === 4,
    );
    assert.equal(built, false, "pending builders count toward the admission limit");
    assert.equal(await cache.use("b", 1, 3, async () => { throw new Error("rebuilt"); }, async (f) => f), "new", "an existing snapshot is still served");
    pending = { count: 0, bytes: 0 };
    assert.equal(await cache.use("c", 1, 1, builder("admitted"), async (f) => f), "admitted", "released once cleanup succeeds");
  }
  console.log("PASS: environment cache coalescing, warming, leases, budget, quarantine accounting, bounded maintenance, admission, recovery, and safe cleanup");
} finally {
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
}
