import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { removeStoppedTree } from "@cube/sandbox";

interface Environment {
  key: string;
  family: string;
  fingerprint: string;
  reservedBytes: number;
  usedAt: number;
}

/** A directory that is neither a usable snapshot nor gone: a publication
 * that never completed (journal present, no manifest), an eviction that
 * failed half-way (`deleting.json`), or a build that left neither. Until
 * its cleanup succeeds it still occupies the host — an image, a workspace
 * tree — so it counts against the budget and is retried. */
export interface QuarantinedEntry {
  key: string;
  reason: "unpublished" | "deleting" | "unknown";
  reservedBytes: number;
}

/** Past this many unresolved entries no new build is admitted: every
 * failed cleanup is disk the cap no longer governs, and a host that
 * cannot clean up must not be handed more to clean. Snapshots that
 * already exist stay usable; new keys fall back to a fresh setup. */
export const MAX_UNRESOLVED_ENTRIES = 3;

export class EnvironmentCacheSuspendedError extends Error {
  readonly unresolved: number;
  constructor(unresolved: number) {
    super(`environment cache suspended: ${unresolved} unresolved entries await cleanup (limit ${MAX_UNRESOLVED_ENTRIES})`);
    this.name = "EnvironmentCacheSuspendedError";
    this.unresolved = unresolved;
  }
}

/** The cache is mid-maintenance and did not settle within the bound a
 * thread's provisioning may wait: fresh setup instead of a stalled wait. */
export class EnvironmentCacheBusyError extends Error {
  constructor(waitedMs: number) {
    super(`environment cache busy: maintenance did not settle within ${waitedMs} ms`);
    this.name = "EnvironmentCacheBusyError";
  }
}

/** Cancel/deadline options handed to the owner's delete callbacks. */
export interface CacheCallOptions {
  signal: AbortSignal;
}

export interface EnvironmentCacheOptions {
  /** What a quarantined entry is assumed to occupy when nothing on disk
   * says (the reservation a build is admitted with). Default 0. */
  unknownEntryBytes?: number;
  /** Deadline per delete/reconcile call made by maintenance. Default 60 s. */
  callTimeoutMs?: number;
  /** How long `use()` waits on a running maintenance pass before giving
   * up on reuse for this thread. Default 5 s. */
  waitMs?: number;
  /** Quarantined entries attempted per maintenance pass. Default 5. */
  maxAttemptsPerPass?: number;
  /** Resources a build left outside this directory that the owner has not
   * managed to free yet (a builder instance whose teardown failed): how
   * many, and what they occupy. They count like quarantined entries — toward
   * the admission limit and the budget — until the owner reports them gone. */
  retained?: () => { count: number; bytes: number };
}

const KEY = /^[a-f0-9]{64}$/;

/** Immutable host-owned snapshots. A lease lasts until instance creation has
 * completed, so neither the image nor workspace can disappear under a user. */
export class EnvironmentCache {
  private readonly flights = new Map<string, Promise<Environment>>();
  private readonly leases = new Map<string, number>();
  // Keys with a maintenance delete/reconcile in flight: not re-attempted
  // or counted twice by anything that runs alongside the pass.
  private readonly cleaning = new Set<string>();
  private pruning: Promise<void>;
  private readonly diagnosticErrors: unknown[] = [];
  readonly root: string;
  private readonly maxBytes: number;
  private readonly deleteImage: (fingerprint: string, opts: CacheCallOptions) => Promise<void>;
  private readonly deleteOrphan: (key: string, opts: CacheCallOptions) => Promise<void>;
  private readonly unknownEntryBytes: number;
  private readonly callTimeoutMs: number;
  private readonly waitMs: number;
  private readonly maxAttemptsPerPass: number;
  private readonly retained: () => { count: number; bytes: number };

  constructor(
    root: string,
    maxBytes: number,
    deleteImage: (fingerprint: string, opts: CacheCallOptions) => Promise<void>,
    deleteOrphan: (key: string, opts: CacheCallOptions) => Promise<void> = async () => {},
    options: EnvironmentCacheOptions = {},
  ) {
    this.root = root;
    this.maxBytes = maxBytes;
    this.deleteImage = deleteImage;
    this.deleteOrphan = deleteOrphan;
    this.unknownEntryBytes = options.unknownEntryBytes ?? 0;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.waitMs = options.waitMs ?? 5_000;
    this.maxAttemptsPerPass = options.maxAttemptsPerPass ?? 5;
    this.retained = options.retained ?? (() => ({ count: 0, bytes: 0 }));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.pruning = this.recoverNow();
  }

  /** Errors from best-effort maintenance performed after successful uses. */
  takeDiagnostics(): unknown[] {
    return this.diagnosticErrors.splice(0);
  }

  private readManifest(file: string): Environment {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Environment>;
    if (!KEY.test(value.key ?? "") || !KEY.test(value.family ?? "") ||
        typeof value.fingerprint !== "string" || !value.fingerprint ||
        !Number.isSafeInteger(value.reservedBytes) || value.reservedBytes! < 0 ||
        typeof value.usedAt !== "number" || !Number.isFinite(value.usedAt)) {
      throw new Error(`Invalid environment cache manifest: ${file}`);
    }
    return value as Environment;
  }

  private entries(): Environment[] {
    return fs.readdirSync(this.root).filter(KEY.test.bind(KEY)).flatMap((name) => {
      const file = path.join(this.root, name, "manifest.json");
      try {
        const entry = this.readManifest(file);
        if (entry.key !== name) throw new Error(`Cache manifest key mismatch: ${file}`);
        return [entry];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
  }

  /** Every unresolved directory, with what it is assumed to occupy: the
   * evicted manifest's reservation, the reservation recorded when its
   * build was admitted, or the configured unknown-entry size. A key with a
   * build in flight is not quarantined — it is being made. */
  quarantined(): QuarantinedEntry[] {
    const entries: QuarantinedEntry[] = [];
    for (const name of fs.readdirSync(this.root)) {
      if (!KEY.test(name) || this.flights.has(name) || this.leases.has(name)) continue;
      const directory = path.join(this.root, name);
      const deleting = path.join(directory, "deleting.json");
      if (fs.existsSync(deleting)) {
        entries.push({ key: name, reason: "deleting", reservedBytes: this.sizeFrom(deleting) ?? this.unknownEntryBytes });
        continue;
      }
      if (fs.existsSync(path.join(directory, "manifest.json"))) continue;
      entries.push({
        key: name,
        reason: fs.existsSync(path.join(directory, "publication.json")) ? "unpublished" : "unknown",
        reservedBytes: this.sizeFrom(path.join(directory, "reservation.json")) ?? this.unknownEntryBytes,
      });
    }
    return entries;
  }

  /** Everything a failed build still holds that is not a usable snapshot:
   * the quarantined entries here plus what the owner reports retained. */
  unresolved(): { count: number; bytes: number } {
    const entries = this.quarantined();
    const external = this.retained();
    return {
      count: entries.length + external.count,
      bytes: entries.reduce((sum, entry) => sum + entry.reservedBytes, 0) + external.bytes,
    };
  }

  private sizeFrom(file: string): number | null {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as { reservedBytes?: unknown };
      return Number.isSafeInteger(value.reservedBytes) && (value.reservedBytes as number) >= 0 ? value.reservedBytes as number : null;
    } catch {
      return null; // absent or damaged: the unknown-entry size applies
    }
  }

  private writeManifest(directory: string, entry: Environment): void {
    const temporary = path.join(directory, "manifest.tmp");
    const file = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(file, JSON.stringify(entry));
      fs.fsyncSync(file);
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path.join(directory, "manifest.json"));
    const directoryFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }

  /** Wait for `work` at most `ms`. Past that the caller goes on — the work
   * runs on, its outcome landing in diagnostics — because one stalled
   * Incus call must not hold every thread's provisioning. */
  private settleWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
    const settled = work.then(() => true, (error) => { this.diagnosticErrors.push(error); return true; });
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
  }

  async use<T>(
    familyInput: unknown,
    revisionInput: unknown,
    reservedBytes: number,
    build: (directory: string, warmFingerprint?: string) => Promise<string>,
    consume: (fingerprint: string, workspace: string) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new Error("reservedBytes must be a non-negative safe integer");
    const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const family = hash(familyInput);
    const key = hash([family, revisionInput]);

    // Crucially there is no yield between maintenance completing, taking the
    // lease, and reading the manifest. Pruning cannot reserve this key there.
    // The wait itself is bounded: a maintenance pass stalled on Incus must
    // not hold this thread — it sets up fresh instead.
    if (!(await this.settleWithin(this.pruning, this.waitMs))) throw new EnvironmentCacheBusyError(this.waitMs);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    try {
      let flight = this.flights.get(key);
      if (!flight) {
        flight = (async () => {
          const all = this.entries();
          const existing = all.find((entry) => entry.key === key);
          if (existing) return existing;
          // Admission: an existing snapshot is always served, a new build
          // only while the host is keeping up with its own cleanup — of
          // this directory and of the builders that made it.
          const unresolved = this.unresolved().count;
          if (unresolved > MAX_UNRESOLVED_ENTRIES) throw new EnvironmentCacheSuspendedError(unresolved);
          const warm = all.filter((entry) => entry.family === family).sort((a, b) => b.usedAt - a.usedAt)[0];
          if (warm) this.leases.set(warm.key, (this.leases.get(warm.key) ?? 0) + 1);
          const directory = path.join(this.root, key);
          let fingerprint: string | undefined;
          try {
            if (fs.existsSync(directory)) {
              await this.removeUnpublished(key);
            }
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            // What this build was admitted with, so that if it is left
            // unresolved it is accounted at the same size, not at zero.
            fs.writeFileSync(path.join(directory, "reservation.json"), JSON.stringify({ key, family, reservedBytes, startedAt: Date.now() }), { mode: 0o600 });
            fingerprint = await build(directory, warm?.fingerprint);
            if (!fingerprint) throw new Error("Environment build returned an empty fingerprint");
            const workspaceBytes = treeBytes(path.join(directory, "workspace"));
            const entry = { key, family, fingerprint, reservedBytes: reservedBytes + workspaceBytes, usedAt: Date.now() };
            this.writeManifest(directory, entry);
            return entry;
          } catch (error) {
            try {
              if (fingerprint) await this.underDeadline((opts) => this.deleteImage(fingerprint!, opts));
              else await this.removeUnpublished(key);
              removeStoppedTree(directory);
            } catch (cleanupError) {
              // Keep the directory as a durable orphan-cleanup marker.
              this.diagnosticErrors.push(cleanupError);
            }
            throw error;
          } finally {
            if (warm) this.release(warm.key);
          }
        })();
        this.flights.set(key, flight);
        void flight.finally(() => this.flights.delete(key)).catch(() => {});
      }
      const entry = await flight;
      entry.usedAt = Date.now();
      this.writeManifest(path.join(this.root, key), entry);
      return await consume(entry.fingerprint, path.join(this.root, key, "workspace"));
    } finally {
      this.release(key);
      // Eviction after a use is bounded the same way: it runs on in the
      // background if a delete stalls, and its failure is a diagnostic.
      await this.settleWithin(this.prune(), this.waitMs);
    }
  }

  private release(key: string): void {
    const count = (this.leases.get(key) ?? 1) - 1;
    if (count) this.leases.set(key, count); else this.leases.delete(key);
  }

  /** Explicitly wait for startup recovery (also happens before the first use). */
  recover(): Promise<void> { return this.pruning; }

  /** Run one owner call under this cache's deadline. A ref'd timer, not
   * `AbortSignal.timeout`: the deadline must fire even when nothing else
   * keeps the loop alive, and is cleared the moment the call settles. */
  private async underDeadline<T>(run: (opts: CacheCallOptions) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`environment cleanup timed out after ${this.callTimeoutMs} ms`)), this.callTimeoutMs);
    try {
      return await run({ signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async removeUnpublished(key: string): Promise<void> {
    const directory = path.join(this.root, key);
    const deleting = path.join(directory, "deleting.json");
    if (this.cleaning.has(key)) throw new Error(`environment ${key} cleanup already in flight`);
    this.cleaning.add(key);
    try {
      if (fs.existsSync(deleting)) {
        const { fingerprint } = this.readManifest(deleting);
        await this.underDeadline((opts) => this.deleteImage(fingerprint, opts));
      } else {
        await this.underDeadline((opts) => this.deleteOrphan(key, opts));
      }
      removeStoppedTree(directory);
    } finally {
      this.cleaning.delete(key);
    }
  }

  private async recoverNow(): Promise<void> {
    for (const name of fs.readdirSync(this.root)) {
      if (!KEY.test(name)) continue;
      const directory = path.join(this.root, name);
      const manifest = path.join(directory, "manifest.json");
      const temporary = path.join(directory, "manifest.tmp");
      // Never promote a temporary manifest.
      if (fs.existsSync(manifest) && !fs.existsSync(path.join(directory, "deleting.json"))) fs.rmSync(temporary, { force: true });
    }
    await this.retryQuarantined();
  }

  /** One bounded pass over the unresolved entries: at most
   * `maxAttemptsPerPass` of them, each delete/reconcile under its own
   * deadline, oldest keys first. A pre-POST journal reconciles publication
   * even when no alias was returned before the crash; a failure (or a
   * timeout) leaves that key quarantined for the next pass without
   * blocking the others. Returns what is still unresolved afterwards. */
  private async retryQuarantined(): Promise<QuarantinedEntry[]> {
    const batch = this.quarantined()
      .filter((entry) => !this.cleaning.has(entry.key))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, this.maxAttemptsPerPass);
    for (const entry of batch) {
      try {
        await this.removeUnpublished(entry.key);
      } catch (error) {
        this.diagnosticErrors.push(error);
      }
    }
    return this.quarantined();
  }

  /** Periodic maintenance: retry quarantined cleanups (bounded), then
   * evict to the budget. Failures are diagnostics (`takeDiagnostics`),
   * never a rejection — one unremovable image must not stop the pass. */
  maintain(): Promise<void> {
    return this.pruneAfter(() => this.retryQuarantined());
  }

  /** Evict least-recently-used snapshots until the retained bytes — usable
   * snapshots, quarantined entries AND what the owner still holds from
   * failed builds, which occupy the host just the same — fit the budget.
   * Leased and in-flight keys are never evicted. */
  prune(): Promise<void> {
    return this.pruneAfter(async () => this.quarantined());
  }

  private pruneAfter(unresolved: () => Promise<QuarantinedEntry[]>): Promise<void> {
    this.pruning = this.pruning.catch(() => {}).then(async () => {
      const quarantined = await unresolved();
      const entries = this.entries().sort((a, b) => a.usedAt - b.usedAt);
      let total = entries.reduce((sum, entry) => sum + entry.reservedBytes, 0)
        + quarantined.reduce((sum, entry) => sum + entry.reservedBytes, 0)
        + this.retained().bytes;
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        if (this.leases.has(entry.key)) continue;
        const directory = path.join(this.root, entry.key);
        fs.renameSync(path.join(directory, "manifest.json"), path.join(directory, "deleting.json"));
        try {
          await this.underDeadline((opts) => this.deleteImage(entry.fingerprint, opts));
          removeStoppedTree(directory);
          total -= entry.reservedBytes;
        } catch (error) {
          fs.renameSync(path.join(directory, "deleting.json"), path.join(directory, "manifest.json"));
          throw error;
        }
      }
    });
    return this.pruning;
  }
}

function treeBytes(root: string): number {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error(`Special files are not allowed in environment workspaces: ${root}`);
  return fs.readdirSync(root).reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0);
}
