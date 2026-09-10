/**
 * Prepared environments as templates (ARCHITECTURE §7): a dedicated builder
 * runs `.cube/setup` once per environment key, is stopped and snapshotted
 * together with its docker volume, and stays as a stopped instance that
 * every thread of the project is cloned from. On ZFS a clone is instant and
 * shares blocks, so a thread pays only its own fresh checkout and a warm
 * rerun of setup. No image is ever built or published.
 *
 * The key is the environment declaration — the contents of setup, resume
 * and cube.toml — plus what the rootfs was made from (base image, arch,
 * quotas, egress). Repository commits are not part of it: a commit changes
 * the workspace, and the workspace is never in the template.
 *
 * One template per project: a new key builds a new template and the old one
 * is deleted once nothing is mid-clone from it. Incus keeps a deleted
 * template's datasets alive for as long as clones depend on them.
 */
import crypto from "node:crypto";
import type { CubeBackend, CubeTemplateSource } from "@cube/sandbox";

import type { EnvironmentTemplateRow, Registry } from "./registry.ts";

/** What a build callback must deliver: the captured template. */
export type TemplateBuild = () => Promise<CubeTemplateSource>;

export interface EnvironmentTemplatesOptions {
  /** Deadline per Incus call made by recovery and pruning. Default 60 s. */
  callTimeoutMs?: number;
  /** Where recovery/prune failures go (they never throw). */
  onError?: (context: string, error: unknown) => void;
}

/** sha256 over a JSON-serialisable description of an environment. */
export function environmentKey(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class EnvironmentTemplates {
  private readonly registry: Registry;
  private readonly backend: Pick<CubeBackend, "deleteTemplate" | "getState">;
  private readonly pool: string;
  private readonly callTimeoutMs: number;
  private readonly onError: (context: string, error: unknown) => void;
  /** One build per (project, key) at a time; concurrent threads share it. */
  private readonly flights = new Map<string, Promise<EnvironmentTemplateRow>>();
  /** Templates a thread is being cloned from right now: never deleted. */
  private readonly leases = new Map<string, number>();

  constructor(
    registry: Registry,
    backend: Pick<CubeBackend, "deleteTemplate" | "getState">,
    pool: string,
    options: EnvironmentTemplatesOptions = {},
  ) {
    this.registry = registry;
    this.backend = backend;
    this.pool = pool;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * The ready template for (project, key), building it with `build` when
   * there is none. Waiters on an in-flight build share its outcome; a
   * failed build rejects for all of them (the caller then sets up fresh)
   * and leaves nothing behind. The returned row is leased until `release`.
   */
  async acquire(projectId: string, key: string, build: (instance: string) => Promise<CubeTemplateSource>): Promise<EnvironmentTemplateRow> {
    const existing = this.registry.findEnvironmentTemplate(projectId, key);
    if (existing?.status === "ready") {
      this.registry.touchEnvironmentTemplate(existing.id);
      this.lease(existing.id);
      return existing;
    }
    const flightKey = `${projectId}\0${key}`;
    let flight = this.flights.get(flightKey);
    if (!flight) {
      flight = this.build(projectId, key, existing, build);
      this.flights.set(flightKey, flight);
      void flight.finally(() => this.flights.delete(flightKey)).catch(() => {});
    }
    const row = await flight;
    this.lease(row.id);
    return row;
  }

  private async build(
    projectId: string,
    key: string,
    stale: EnvironmentTemplateRow | null,
    build: (instance: string) => Promise<CubeTemplateSource>,
  ): Promise<EnvironmentTemplateRow> {
    // A `building` row from a crashed capture: its instance is unusable
    // evidence, not a template. Clear it before the new attempt.
    if (stale) await this.remove(stale);
    const id = crypto.randomUUID();
    const instance = `cube-s-${crypto.randomBytes(4).toString("hex")}`;
    const row = this.registry.createEnvironmentTemplate({
      id, projectId, key, status: "building", instance, snapshot: "env", volume: `${instance}-docker`, volumeSnapshot: "env",
    });
    let captured: CubeTemplateSource;
    try {
      captured = await build(instance);
    } catch (error) {
      // The builder cleaned up (or quarantined) its own instance; the row
      // must not survive as a template that never was.
      this.registry.deleteEnvironmentTemplate(id);
      throw error;
    }
    if (captured.instance !== instance) throw new Error(`template build returned instance ${captured.instance}, expected ${instance}`);
    this.registry.setEnvironmentTemplateStatus(id, "ready");
    const ready = this.registry.getEnvironmentTemplate(id)!;
    // One template per project: the previous key's template goes now, or
    // at the next prune if a thread is still being cloned from it.
    for (const other of this.registry.listEnvironmentTemplates(projectId)) {
      if (other.id !== id && !this.leases.has(other.id)) {
        await this.remove(other).catch((error) => this.onError(`evict template ${other.instance}`, error));
      }
    }
    return ready;
  }

  private lease(id: string): void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
  }

  /** The clone finished (or failed): the template may be evicted again. */
  release(id: string): void {
    const count = (this.leases.get(id) ?? 1) - 1;
    if (count > 0) this.leases.set(id, count); else this.leases.delete(id);
  }

  /** Delete a template's resources, then its row. Failures propagate: the
   * row stays and the next prune retries, so nothing is silently leaked. */
  private async remove(row: EnvironmentTemplateRow): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`template cleanup timed out after ${this.callTimeoutMs} ms`)), this.callTimeoutMs);
    try {
      await this.backend.deleteTemplate(this.pool, row, { signal: controller.signal, timeoutMs: this.callTimeoutMs });
    } finally {
      clearTimeout(timer);
    }
    this.registry.deleteEnvironmentTemplate(row.id);
  }

  /** Boot: a capture interrupted by a restart leaves a `building` row —
   * remove what it holds; a `ready` row whose instance is gone (an operator
   * `incus delete`) is forgotten. Never throws. */
  async recover(): Promise<void> {
    for (const row of this.registry.listEnvironmentTemplates()) {
      try {
        if (row.status === "building") { await this.remove(row); continue; }
        const present = await this.backend.getState(row.instance).then(() => true, () => false);
        if (!present) this.registry.deleteEnvironmentTemplate(row.id);
      } catch (error) {
        this.onError(`recover template ${row.instance}`, error);
      }
    }
  }

  /** Periodic: keep one ready template per project (the newest), drop the
   * rest and any `building` leftovers. Leased templates are skipped. */
  async prune(): Promise<void> {
    const byProject = new Map<string, EnvironmentTemplateRow[]>();
    for (const row of this.registry.listEnvironmentTemplates()) {
      byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
    }
    for (const rows of byProject.values()) {
      const ready = rows.filter((row) => row.status === "ready").sort((a, b) => b.createdAt - a.createdAt);
      const keep = ready[0]?.id;
      for (const row of rows) {
        if (row.id === keep || this.leases.has(row.id)) continue;
        if (row.status === "building" && this.flights.size > 0) continue; // a capture may be in flight
        await this.remove(row).catch((error) => this.onError(`prune template ${row.instance}`, error));
      }
    }
  }

  /** Every template of a project, before the project itself goes. Throws
   * on the first failure: the project then still has a template and its
   * deletion is refused, rather than an instance leaking. */
  async forgetProject(projectId: string): Promise<void> {
    for (const row of this.registry.listEnvironmentTemplates(projectId)) {
      if (this.leases.has(row.id)) throw new Error("a thread is still being prepared from this project's environment — retry shortly");
      await this.remove(row);
    }
  }

  /** Templates known for a project (diagnostics). */
  list(projectId?: string): EnvironmentTemplateRow[] {
    return this.registry.listEnvironmentTemplates(projectId);
  }
}
