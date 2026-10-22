/** Machine templates: a project's prepared machine disk on a runner, so a
 * new thread's machine starts from it instead of from the base image.
 *
 * On `berth vm` (protocol 4, RunnerMachines) a template is a keel layer. It
 * is built by a dedicated build machine that only cubed uses: it boots from
 * the base with its own identity, checks out the thread's pinned commits,
 * runs the project's external pre-setup hook and the repository's
 * `.agents/setup`, and only if all of that succeeded does the runner publish
 * it (`template_publish`; the build machine's agent cleans and checks its
 * writable layer itself). New machines get their own layer on it and their
 * own identity. No agent ever ran in a build machine.
 *
 * The key names everything the preparation depends on that cubed knows
 * before booting; the repository's `.agents/setup` is only known after the
 * checkout, so its blob id travels in the template's metadata and a machine
 * whose pinned setup differs runs setup itself and invalidates the template.
 * Templates are per runner and per project, never shared across projects. */
import { createHash, X509Certificate } from "node:crypto";
import type { RunnerTemplate } from "./runner-types.ts";
import type { ProjectHooks, WorkspaceAllocation } from "./registry.ts";

/** Bumped when the build, the seal or what a template must contain changes. */
export const TEMPLATE_FORMAT = 1;
/** A template is reused for this long by default (CUBED_TEMPLATE_TTL_HOURS). */
export const DEFAULT_TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed build, threads of the same key start cold this long. */
export const FAILED_BUILD_BACKOFF_MS = 60 * 60 * 1000;
/** What a protocol-4 VM runner (`berth vm`) says in hello when it has templates. */
export const KEEL_TEMPLATE_CAPABILITIES = ["template.publish", "template.list", "template.delete"] as const;

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
export type TemplateKeyInput = { allocation: WorkspaceAllocation; hooks: ProjectHooks;
  /** `imageId`: a VM runner's `Platform.image_id`, what its machines are made from (berth vm); absent or empty without one.
   * `caSha256`: its egress CA's fingerprint (`runnerCaSha256`); absent or empty without one. */
  runner: { baseImageSha256: string; platform: string; imageId?: string; caSha256?: string }; diskGiB: number };

/** sha256 of the DER of the runner's CA (`Runner.ca_pem`), as berth names
 * it; "" for a runner without one. A template may hold that CA, and berth
 * makes machines from it only under the same CA (`template_runner_ca_changed`). */
export function runnerCaSha256(pem: string): string {
  if (!pem.trim()) return "";
  try { return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex"); }
  catch { return sha256(pem.trim()); }
}
/** A keel template's key (`berth vm`): `kind: "keel"` keeps it apart from
 * the keys protocol-3 runners used (retired). The runner's keel base
 * (`Platform.base_image_sha256`), platform and image (`Platform.image_id`:
 * the OCI image and berth's own layers, such as its Debian preparation) are
 * in it, so a lookup never picks a template the runner would refuse as made
 * on another image (`template_image_changed`). So is the runner's CA, which a
 * template may hold: a runner with a new CA gets a new template instead of
 * refusing the old one (`template_runner_ca_changed`). */
export function keelTemplateKey(input: TemplateKeyInput): string {
  return sha256(JSON.stringify({
    kind: "keel",
    format: TEMPLATE_FORMAT,
    project: input.allocation.projectId,
    repositories: input.allocation.repositories.map(repository => ({ url: repository.url, base: repository.base, checkoutName: repository.checkoutName })),
    preSetup: sha256(input.hooks.preSetup),
    image: input.runner.baseImageSha256,
    // Only when the runner says it: a runner that does not keeps its keys.
    ...(input.runner.imageId ? { workloadImage: input.runner.imageId } : {}),
    // A template is bound to the runner's CA: another CA, another key.
    ...(input.runner.caSha256 ? { runnerCa: input.runner.caSha256 } : {}),
    platform: input.runner.platform,
    diskGiB: input.diskGiB,
  }));
}

/** What each part of the key was, hashed, so a thread that finds no
 * template can say what changed since the project's last one. `guest` was
 * only in protocol-3 templates' parts. */
export type TemplateParts = Record<"repositories" | "preSetup" | "image" | "disk", string> & { guest?: string; runnerCa?: string };
const PART_WORDS: Record<keyof TemplateParts & string, string> = {
  repositories: "the project's repositories", preSetup: "the pre-setup hook", guest: "cube's guest helper or packages",
  image: "the runner's base image or platform", disk: "the disk size", runnerCa: "the runner's CA",
};
/** Parts a template's metadata may lack (made before they were parts). */
const OPTIONAL_PARTS = ["guest", "runnerCa"];
export function keelTemplateParts(input: TemplateKeyInput): TemplateParts {
  const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);
  // The runner's image is part of "image" only when it has one, so a
  // template made before runners said theirs reads as made on the same.
  const image = input.runner.imageId ? [input.runner.baseImageSha256, input.runner.platform, input.runner.imageId]
    : [input.runner.baseImageSha256, input.runner.platform];
  return {
    repositories: short(input.allocation.repositories.map(repository => [repository.url, repository.base, repository.checkoutName])),
    preSetup: short(input.hooks.preSetup),
    image: short(image),
    disk: short(input.diskGiB),
    ...(input.runner.caSha256 ? { runnerCa: short(input.runner.caSha256) } : {}),
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
  const changed = parts ? (Object.keys(PART_WORDS) as Array<keyof typeof PART_WORDS>).filter(name => options.parts[name] !== undefined && parts[name] !== undefined && parts[name] !== options.parts[name])
    .map(name => PART_WORDS[name]) : [];
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
    const partsValid = !!parts && typeof parts === "object" && Object.keys(PART_WORDS).every(name => typeof parts[name] === "string" || (OPTIONAL_PARTS.includes(name) && parts[name] === undefined));
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
