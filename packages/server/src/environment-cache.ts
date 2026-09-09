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

const KEY = /^[a-f0-9]{64}$/;

/** Immutable host-owned snapshots. A lease lasts until instance creation has
 * completed, so neither the image nor workspace can disappear under a user. */
export class EnvironmentCache {
  private readonly flights = new Map<string, Promise<Environment>>();
  private readonly leases = new Map<string, number>();
  private pruning: Promise<void>;
  private readonly diagnosticErrors: unknown[] = [];
  readonly root: string;
  private readonly maxBytes: number;
  private readonly deleteImage: (fingerprint: string) => Promise<void>;
  private readonly deleteOrphan: (key: string) => Promise<void>;

  constructor(
    root: string,
    maxBytes: number,
    deleteImage: (fingerprint: string) => Promise<void>,
    deleteOrphan: (key: string) => Promise<void> = async () => {},
  ) {
    this.root = root;
    this.maxBytes = maxBytes;
    this.deleteImage = deleteImage;
    this.deleteOrphan = deleteOrphan;
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
    await this.pruning.catch((error) => { this.diagnosticErrors.push(error); });
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    try {
      let flight = this.flights.get(key);
      if (!flight) {
        flight = (async () => {
          const all = this.entries();
          const existing = all.find((entry) => entry.key === key);
          if (existing) return existing;
          const warm = all.filter((entry) => entry.family === family).sort((a, b) => b.usedAt - a.usedAt)[0];
          if (warm) this.leases.set(warm.key, (this.leases.get(warm.key) ?? 0) + 1);
          const directory = path.join(this.root, key);
          let fingerprint: string | undefined;
          try {
            if (fs.existsSync(directory)) {
              await this.removeUnpublished(key);
            }
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            fingerprint = await build(directory, warm?.fingerprint);
            if (!fingerprint) throw new Error("Environment build returned an empty fingerprint");
            const workspaceBytes = treeBytes(path.join(directory, "workspace"));
            const entry = { key, family, fingerprint, reservedBytes: reservedBytes + workspaceBytes, usedAt: Date.now() };
            this.writeManifest(directory, entry);
            return entry;
          } catch (error) {
            try {
              if (fingerprint) await this.deleteImage(fingerprint);
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
      await this.prune().catch((error) => { this.diagnosticErrors.push(error); });
    }
  }

  private release(key: string): void {
    const count = (this.leases.get(key) ?? 1) - 1;
    if (count) this.leases.set(key, count); else this.leases.delete(key);
  }

  /** Explicitly wait for startup recovery (also happens before the first use). */
  recover(): Promise<void> { return this.pruning; }

  private async removeUnpublished(key: string): Promise<void> {
    const directory = path.join(this.root, key);
    const deleting = path.join(directory, "deleting.json");
    if (fs.existsSync(deleting)) await this.deleteImage(this.readManifest(deleting).fingerprint);
    else await this.deleteOrphan(key);
    removeStoppedTree(directory);
  }

  private async recoverNow(): Promise<void> {
    for (const name of fs.readdirSync(this.root)) {
      if (!KEY.test(name)) continue;
      const directory = path.join(this.root, name);
      const manifest = path.join(directory, "manifest.json");
      const temporary = path.join(directory, "manifest.tmp");
      const deleting = path.join(directory, "deleting.json");
      try {
        if (fs.existsSync(deleting) || !fs.existsSync(manifest)) {
          // Never promote a temporary manifest. A pre-POST journal reconciles
          // publication even when no alias was returned before the crash.
          await this.removeUnpublished(name);
        } else if (fs.existsSync(temporary)) {
          fs.rmSync(temporary, { force: true });
        }
      } catch (error) {
        // Quarantine unresolved publications without blocking other keys.
        this.diagnosticErrors.push(error);
      }
    }
  }

  prune(): Promise<void> {
    this.pruning = this.pruning.catch(() => {}).then(async () => {
      const entries = this.entries().sort((a, b) => a.usedAt - b.usedAt);
      let total = entries.reduce((sum, entry) => sum + entry.reservedBytes, 0);
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        if (this.leases.has(entry.key)) continue;
        const directory = path.join(this.root, entry.key);
        fs.renameSync(path.join(directory, "manifest.json"), path.join(directory, "deleting.json"));
        try {
          await this.deleteImage(entry.fingerprint);
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
