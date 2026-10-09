/** Machine templates: a project's prepared machine disk on a runner, so a
 * new thread's machine starts from it instead of from the base image.
 *
 * A template is built by a dedicated build machine that only cubed uses: it
 * boots from the base image with its own throwaway identity, checks out the
 * thread's pinned commits, runs the project's external pre-setup hook and the
 * repository's `.agents/setup`, and only if all of that succeeded is it sealed
 * (cube-guest seal: host keys, machine id, cloud-init instance, the helper's
 * journal and cubed's per-machine files are removed at power-off) and
 * published by the runner, which moves its disk under `templates/` read-only.
 * New machines get their own copy-on-write overlay on it and their own
 * identity from their own seed. No agent ever ran in a build machine.
 *
 * The key names everything the preparation depends on that cubed knows
 * before booting; the repository's `.agents/setup` is only known after the
 * checkout, so its blob id travels in the template's metadata and a machine
 * whose pinned setup differs runs setup itself and invalidates the template.
 * Templates are per runner and per project, never shared across projects. */
import { createHash } from "node:crypto";
import type { RunnerTemplate } from "./iroh-node.ts";
import type { ProjectHooks, WorkspaceAllocation } from "./registry.ts";
import { GUEST_PACKAGES, guestHelper } from "./vm-seed.ts";

/** Bumped when the build, the seal or what a template must contain changes. */
export const TEMPLATE_FORMAT = 1;
/** A template is reused for this long by default (CUBED_TEMPLATE_TTL_HOURS). */
export const DEFAULT_TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed build, threads of the same key start cold this long. */
export const FAILED_BUILD_BACKOFF_MS = 60 * 60 * 1000;
/** The runner capability that brings templates (cube-runner 0.8.0). */
export const TEMPLATE_CAPABILITY = "vm.publish";

export interface TemplateSettings { enabled: boolean; ttlMs: number }

/** CUBED_TEMPLATES=off turns templates off; CUBED_TEMPLATE_TTL_HOURS sets
 * how long one is reused (default 24). */
export function templateSettings(env: NodeJS.ProcessEnv = process.env): TemplateSettings {
  const switched = env.CUBED_TEMPLATES?.trim().toLowerCase();
  if (switched && !["on", "off"].includes(switched)) throw new Error("CUBED_TEMPLATES must be on or off");
  const hours = env.CUBED_TEMPLATE_TTL_HOURS?.trim();
  let ttlMs = DEFAULT_TEMPLATE_TTL_MS;
  if (hours) {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0 || value > 24 * 365) throw new Error("CUBED_TEMPLATE_TTL_HOURS must be a positive number of hours");
    ttlMs = Math.round(value * 60 * 60 * 1000);
  }
  return { enabled: switched !== "off", ttlMs };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What a template's preparation depends on, as far as cubed knows before a
 * machine boots. Not in it: the pre-resume hook (resume hooks run on every
 * machine and are never cached) and `.agents/setup` (see `setupBlob`). */
export type TemplateKeyInput = { allocation: WorkspaceAllocation; hooks: ProjectHooks; runner: { baseImageSha256: string; platform: string }; diskGiB: number };
export function templateKey(input: TemplateKeyInput): string {
  const helper = guestHelper();
  return sha256(JSON.stringify({
    format: TEMPLATE_FORMAT,
    project: input.allocation.projectId,
    repositories: input.allocation.repositories.map(repository => ({ url: repository.url, base: repository.base, checkoutName: repository.checkoutName })),
    preSetup: sha256(input.hooks.preSetup),
    packages: GUEST_PACKAGES,
    helper: sha256(helper.helper + helper.recoverUnit),
    image: input.runner.baseImageSha256,
    platform: input.runner.platform,
    diskGiB: input.diskGiB,
  }));
}

/** What each part of the key was, hashed, so a thread that finds no
 * template can say what changed since the project's last one. */
export type TemplateParts = Record<"repositories" | "preSetup" | "guest" | "image" | "disk", string>;
const PART_WORDS: Record<keyof TemplateParts, string> = {
  repositories: "the project's repositories", preSetup: "the pre-setup hook", guest: "cube's guest helper or packages",
  image: "the runner's base image or platform", disk: "the disk size",
};
export function templateParts(input: TemplateKeyInput): TemplateParts {
  const helper = guestHelper();
  const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);
  return {
    repositories: short(input.allocation.repositories.map(repository => [repository.url, repository.base, repository.checkoutName])),
    preSetup: short(input.hooks.preSetup),
    guest: short([GUEST_PACKAGES, helper.helper + helper.recoverUnit]),
    image: short([input.runner.baseImageSha256, input.runner.platform]),
    disk: short(input.diskGiB),
  };
}

/** Why no ready template of the project matches `key` now, in words. */
export function missingTemplate(templates: RunnerTemplate[], options: { projectId: string; key: string; parts: TemplateParts; now: number; ttlMs: number }): string {
  const own = templates.map(template => ({ template, meta: templateMeta(template.meta) }))
    .filter(({ template, meta }) => template.state === "ready" && meta?.projectId === options.projectId)
    .sort((a, b) => b.template.createdAt - a.template.createdAt);
  const newest = own[0];
  if (!newest) return "the project has no template on this runner yet";
  const age = `${Math.round((options.now - newest.template.createdAt) / 3600000)} h`;
  if (newest.template.key === options.key) return `template ${newest.template.id} expired (prepared ${age} ago; templates are reused for ${Math.round(options.ttlMs / 3600000)} h)`;
  const parts = newest.meta!.parts;
  const changed = parts ? (Object.keys(PART_WORDS) as Array<keyof TemplateParts>).filter(name => parts[name] !== options.parts[name]).map(name => PART_WORDS[name]) : [];
  return changed.length ? `${changed.join(", ")} changed since template ${newest.template.id}`
    : `template ${newest.template.id} was prepared with other settings`;
}

/** cubed's metadata on a template; the runner stores it opaquely. */
export interface TemplateMeta {
  format: number;
  projectId: string;
  /** The primary checkout's `.agents/setup` blob the template ran, or "none". */
  setupBlob: string;
  /** The primary repository's commit the template was prepared at. */
  commit: string | null;
  /** What its key was made of (absent in templates published before). */
  parts?: TemplateParts;
}

const BLOB = /^(?:none|[0-9a-f]{40}|[0-9a-f]{64})$/;

export function templateMeta(raw: string): TemplateMeta | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.format !== TEMPLATE_FORMAT || typeof value.projectId !== "string" || typeof value.setupBlob !== "string" || !BLOB.test(value.setupBlob)
      || !(value.commit === null || (typeof value.commit === "string" && /^[0-9a-f]{40,64}$/.test(value.commit)))) return null;
    const parts = value.parts as Record<string, unknown> | undefined;
    const partsValid = !!parts && typeof parts === "object" && (Object.keys(PART_WORDS)).every(name => typeof parts[name] === "string");
    return { format: value.format, projectId: value.projectId, setupBlob: value.setupBlob, commit: value.commit,
      ...(partsValid ? { parts: parts as TemplateParts } : {}) };
  } catch { return null; }
}

/** The newest ready, unexpired template with this key, or null. */
export type ReadTemplate = Omit<RunnerTemplate, "meta"> & { meta: TemplateMeta };
export function pickTemplate(templates: RunnerTemplate[], key: string, now: number, ttlMs: number): ReadTemplate | null {
  let best: ReadTemplate | null = null;
  for (const template of templates) {
    const meta = templateMeta(template.meta);
    if (template.state !== "ready" || template.key !== key || !meta || now - template.createdAt >= ttlMs) continue;
    if (!best || template.createdAt > best.createdAt) best = { ...template, meta };
  }
  return best;
}

/** Ready templates that no new machine should start from any more: expired,
 * unreadable, of a project that no longer exists, or of `projectId` but
 * superseded by `keep`. The runner deletes each once no machine depends on it. */
export function obsoleteTemplates(templates: RunnerTemplate[], options: { now: number; ttlMs: number; projectExists: (id: string) => boolean; projectId?: string; keep?: string }): string[] {
  return templates.filter(template => {
    if (template.state !== "ready") return false;
    const meta = templateMeta(template.meta);
    if (!meta || options.now - template.createdAt >= options.ttlMs || !options.projectExists(meta.projectId)) return true;
    return options.keep !== undefined && meta.projectId === options.projectId && template.id !== options.keep;
  }).map(template => template.id);
}
