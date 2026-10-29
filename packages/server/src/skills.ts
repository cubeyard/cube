/** Skills for a thread's agent: folders with a SKILL.md (agentskills.io)
 * from git repositories, each pinned to an exact commit. A thread's skills
 * are resolved on the host when it starts, kept in its allocation like its
 * repositories' commits, installed in its machine before the agent opens and
 * listed in its prompt by name and description only; the agent reads a
 * SKILL.md, and what it links to, when a task needs it.
 *
 * A skill's id is its folder's name: precedence, disabled names, its
 * install path and the prompt use it. Its SKILL.md `name` is only what the
 * settings page shows, and may differ ("Poteto Mode" in `poteto-mode/`).
 *
 * Precedence: cube's default source, then the user's sources in their order;
 * for each skill id the last source that has it wins, whatever its
 * surface, and a disabled id is left out.
 *
 * The primary repository's own `.agents/skills` are read at the thread's
 * pinned commit too, but not installed: its checkout already has them, so
 * the prompt lists them where they are, under /workspace. A project skill
 * wins its id over an installed one. docs/skills.md. */
import { posix } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { GUEST_HOME, VIRTUAL_ROOT } from "../../claude-mod/hooks/tools.ts";

/** A directory of skill folders (`<path>/<name>/SKILL.md`) in a git
 * repository at one commit. */
export interface SkillSource { url: string; commit: string; path: string }
export type SkillSurface = "thread" | "optchat" | "both";

/** What the user chose, in settings.json: sources after the default one,
 * skill names to leave out, and the default source's commit when it was
 * updated here rather than by a cube release. */
export interface SkillsConfig { sources: SkillSource[]; disabled: string[]; defaultCommit?: string }
export const NO_SKILLS_CONFIG: SkillsConfig = { sources: [], disabled: [] };

/** The skill that won its id, with where it came from. */
export interface ResolvedSkill {
  /** Its id: the folder's name. */
  name: string;
  /** Its SKILL.md name, when that is not its id; shown, never a path. */
  displayName?: string;
  description: string; surface: SkillSurface;
  /** Installed, but left out of the prompt (`disable-model-invocation: true`). */
  hidden?: true;
  url: string; commit: string;
  /** Its folder in the repository. */
  dir: string;
  /** Another source's skill of the same id that this one overrides. */
  overrides?: { url: string; commit: string };
}
/** A thread's skills, fixed at its start. `project`: the primary
 * repository's `.agents/skills` at its pinned commit, listed in place and
 * never installed; absent for threads created before them. */
export interface ThreadSkills { sources: SkillSource[]; skills: ResolvedSkill[]; skipped: Array<{ url: string; dir: string; reason: string }>; project?: ResolvedSkill[] }

/** cubeyard/skills at an exact commit, which only a cube release changes;
 * the cubed command passes it to createCubed. */
export const DEFAULT_SKILL_SOURCE: SkillSource = {
  url: "https://github.com/cubeyard/skills",
  commit: "d5041ce9ae3af0c5b0dbb00234a2bd600df8cf63",
  path: "skills",
};

export const SKILLS_ROOT = `${GUEST_HOME}/.cube/skills`;
/** Where a repository keeps its own skills (the Agent Skills convention). */
export const PROJECT_SKILLS_DIR = ".agents/skills";
/** The primary checkout's skills, as the agent's file tools name them. */
export const PROJECT_SKILLS_ROOT = `${VIRTUAL_ROOT}/${PROJECT_SKILLS_DIR}`;
/** The largest command the guest helper runs (cube-guest.py maxCommandBytes). */
export const GUEST_COMMAND_BYTES = 8192;
export const SKILL_LIMITS = { skills: 64, files: 2000, bytes: 8 * 2 ** 20, description: 1024, displayName: 64 };
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SURFACES = new Set<SkillSurface>(["thread", "optchat", "both"]);

/** The host's git, narrowed to what resolution reads. */
export interface SkillGit {
  ensureMirror(url: string, signal?: AbortSignal): Promise<string>;
  listFilesAtCommit(url: string, oid: string, dir: string): Promise<Array<{ path: string; mode: string; size: number }> | null>;
  readFileAtCommit(url: string, oid: string, relPath: string): Promise<string | null>;
  /** The default branch's tip, fetched into the mirror, as an exact commit. */
  prepareRepository(url: string): Promise<{ base: string; baseOid: string }>;
}

/** The default source as in effect: cube's pin, or the commit saved here. */
export function defaultSource(builtin: SkillSource | null, config: SkillsConfig): SkillSource | null {
  return builtin && config.defaultCommit ? { ...builtin, commit: config.defaultCommit } : builtin;
}

/** What updating the default source would give: its default branch's tip
 * as an exact commit and the skills new threads would get with it. Nothing
 * is saved; saving that commit is the caller's, after the user confirms. */
export async function checkDefaultUpdate(git: SkillGit, builtin: SkillSource, config: SkillsConfig) {
  const current = defaultSource(builtin, config)!.commit;
  const { base, baseOid } = await git.prepareRepository(builtin.url);
  if (!COMMIT.test(baseOid)) throw new Error(`${builtin.url} answered ${JSON.stringify(baseOid)}, not a full commit`);
  const preview = await resolveSkills(git, { ...builtin, commit: baseOid }, config);
  return { branch: base, current, candidate: baseOid, upToDate: baseOid === current, preview };
}

/** settings.json's `skills`, or why it is not one. */
export function parseSkillsConfig(value: unknown): SkillsConfig {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("skills must be an object {sources, disabled, defaultCommit?}");
  const extra = Object.keys(record).filter(key => key !== "sources" && key !== "disabled" && key !== "defaultCommit");
  if (extra.length) throw new Error(`skills: unknown field ${extra.join(", ")}`);
  const { defaultCommit } = record;
  if (defaultCommit !== undefined && defaultCommit !== null && (typeof defaultCommit !== "string" || !COMMIT.test(defaultCommit))) {
    throw new Error("skills.defaultCommit must be a full 40-character commit, not a branch or tag");
  }
  const sources = record.sources ?? [];
  const disabled = record.disabled ?? [];
  if (!Array.isArray(sources) || !Array.isArray(disabled)) throw new Error("skills.sources and skills.disabled must be lists");
  return {
    sources: sources.map((source, index) => parseSource(source, `skills.sources[${index}]`)),
    disabled: disabled.map((name, index) => {
      if (typeof name !== "string" || !NAME.test(name)) throw new Error(`skills.disabled[${index}] is not a skill name`);
      return name;
    }),
    ...typeof defaultCommit === "string" ? { defaultCommit } : {},
  };
}

function parseSource(value: unknown, at: string): SkillSource {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${at} must be {url, commit, path?}`);
  const extra = Object.keys(record).filter(key => !["url", "commit", "path"].includes(key));
  if (extra.length) throw new Error(`${at}: unknown field ${extra.join(", ")}`);
  const { url, commit, path = "" } = record;
  if (typeof url !== "string" || !/^https:\/\/[^\s'"\\]+$/.test(url)) throw new Error(`${at}.url must be an https git URL`);
  // A token in the URL would be kept in settings.json and the allocation and
  // sent into the machine; the host's and the gateway's credentials apply.
  if (/^https:\/\/[^/?#]*@/.test(url)) throw new Error(`${at}.url must not carry credentials (user@ or user:token@)`);
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`${at}.commit must be a full 40-character commit, not a branch or tag`);
  if (typeof path !== "string" || path.startsWith("/") || path.split("/").some(part => part === ".." || part === ".") || /[\s'"\\]/.test(path)) {
    throw new Error(`${at}.path must be a directory in the repository, without . or ..`);
  }
  return { url, commit, path: path.replace(/\/+$/, "") };
}

/** Every skill of every source, in precedence order, then the winners. A
 * source that cannot be read fails resolution; a skill folder that does not
 * qualify is skipped, with the reason. */
export async function resolveSkills(git: SkillGit, defaultSource: SkillSource | null, config: SkillsConfig, signal?: AbortSignal): Promise<ThreadSkills> {
  const sources = [...defaultSource ? [defaultSource] : [], ...config.sources];
  const disabled = new Set(config.disabled);
  const winners = new Map<string, ResolvedSkill>();
  const skipped: ThreadSkills["skipped"] = [];
  const sizes = new Map<string, { files: number; bytes: number }>();
  for (const source of sources) {
    signal?.throwIfAborted();
    let entries = await git.listFilesAtCommit(source.url, source.commit, source.path);
    if (!entries) {
      await git.ensureMirror(source.url, signal);
      entries = await git.listFilesAtCommit(source.url, source.commit, source.path);
    }
    if (!entries) throw new Error(`skills source ${source.url} has no commit ${source.commit}`);
    const prefix = source.path ? `${source.path}/` : "";
    for (const [name, files] of [...skillFolders(entries, prefix)].sort(([a], [b]) => a < b ? -1 : 1)) {
      const dir = `${prefix}${name}`;
      if (!files.some(file => file.path === `${dir}/SKILL.md`)) continue;
      const read = await readSkill(git, source, name, dir, files);
      if ("reason" in read) { skipped.push({ url: source.url, dir, reason: read.reason }); continue; }
      const previous = winners.get(name);
      winners.set(name, { name, ...read, url: source.url, commit: source.commit, dir, ...previous ? { overrides: { url: previous.url, commit: previous.commit } } : {} });
      sizes.set(name, { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) });
    }
  }
  const skills = [...winners.values()].filter(skill => !disabled.has(skill.name)).sort((a, b) => a.name < b.name ? -1 : 1);
  const total = skills.reduce((sum, skill) => ({ files: sum.files + sizes.get(skill.name)!.files, bytes: sum.bytes + sizes.get(skill.name)!.bytes }), { files: 0, bytes: 0 });
  if (skills.length > SKILL_LIMITS.skills) throw new Error(`a thread installs at most ${SKILL_LIMITS.skills} skills, not ${skills.length}: disable some`);
  if (total.files > SKILL_LIMITS.files || total.bytes > SKILL_LIMITS.bytes) {
    throw new Error(`the skills are ${total.files} files and ${total.bytes} bytes; a thread installs at most ${SKILL_LIMITS.files} files and ${SKILL_LIMITS.bytes / 2 ** 20} MiB`);
  }
  const resolved = { sources, skills, skipped };
  // Each install command must fit the guest's limit; a set that cannot is
  // refused here, before a thread is allocated, rather than in every try.
  const long = skillInstallScripts(resolved).find(script => Buffer.byteLength(script) > GUEST_COMMAND_BYTES);
  if (long) throw new Error(`the skills of one source make an install command of ${Buffer.byteLength(long)} bytes, over the machine's ${GUEST_COMMAND_BYTES}: disable some or use shorter names and paths`);
  return resolved;
}

/** The skill folders under `prefix` in a listing, by folder name. */
function skillFolders<T extends { path: string }>(entries: T[], prefix: string): Map<string, T[]> {
  const folders = new Map<string, T[]>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue;
    const name = rest.slice(0, slash);
    folders.set(name, [...folders.get(name) ?? [], entry]);
  }
  return folders;
}

/** A skill folder's SKILL.md, checked, or why the folder does not qualify. */
async function readSkill(git: Pick<SkillGit, "readFileAtCommit">, source: { url: string; commit: string }, name: string, dir: string, files: Array<{ path: string; mode: string }>):
  Promise<{ reason: string } | Pick<ResolvedSkill, "displayName" | "description" | "surface" | "hidden">> {
  if (!NAME.test(name)) return { reason: "the folder name is not a skill name (lowercase letters, digits and inner hyphens)" };
  const odd = files.find(file => file.mode !== "100644" && file.mode !== "100755");
  if (odd) return { reason: `${odd.path} is a ${odd.mode === "120000" ? "symlink" : odd.mode === "160000" ? "submodule" : `mode ${odd.mode} entry`}; skills are plain files` };
  const text = await git.readFileAtCommit(source.url, source.commit, `${dir}/SKILL.md`);
  let frontmatter: Record<string, unknown>;
  try { frontmatter = parseFrontmatter(text ?? "").frontmatter as Record<string, unknown>; }
  catch (error) { return { reason: `SKILL.md frontmatter is not YAML: ${(error as Error).message}` }; }
  const displayName = typeof frontmatter.name === "string" ? frontmatter.name.replace(/\s+/g, " ").trim() : "";
  if (!displayName || displayName.length > SKILL_LIMITS.displayName || /[\p{Cc}\p{Cf}]/u.test(displayName)) {
    return { reason: `SKILL.md name must be 1 to ${SKILL_LIMITS.displayName} characters without control characters` };
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description.replace(/\s+/g, " ").trim() : "";
  if (!description || description.length > SKILL_LIMITS.description) return { reason: `description must be 1 to ${SKILL_LIMITS.description} characters` };
  const metadata = frontmatter.metadata as { cube?: { surface?: unknown } } | undefined;
  const surface = metadata?.cube?.surface ?? "thread";
  if (!SURFACES.has(surface as SkillSurface)) return { reason: `metadata.cube.surface ${JSON.stringify(surface)} is not thread, optchat or both` };
  return { ...displayName === name ? {} : { displayName }, description, surface: surface as SkillSurface, ...frontmatter["disable-model-invocation"] === true ? { hidden: true as const } : {} };
}

/** The primary repository's own skills (`.agents/skills/<id>/SKILL.md`) at
 * the commit a thread starts from, with a source's checks and `disabled`
 * applied by id. Its checkout has them, so nothing is installed and a
 * repository's skills never fail a start: a folder that does not qualify,
 * or one past the limit, is skipped. Each records the installed skill of
 * its id that it hides. */
export async function resolveProjectSkills(git: SkillGit, url: string, commit: string, config: Pick<SkillsConfig, "disabled">, installed: readonly ResolvedSkill[] = [], signal?: AbortSignal):
  Promise<Required<Pick<ThreadSkills, "project" | "skipped">>> {
  let entries = await git.listFilesAtCommit(url, commit, PROJECT_SKILLS_DIR);
  if (!entries) {
    await git.ensureMirror(url, signal);
    entries = await git.listFilesAtCommit(url, commit, PROJECT_SKILLS_DIR);
  }
  if (!entries) throw new Error(`repository ${url} has no commit ${commit}`);
  const disabled = new Set(config.disabled);
  const project: ResolvedSkill[] = [];
  const skipped: ThreadSkills["skipped"] = [];
  for (const [name, files] of [...skillFolders(entries, `${PROJECT_SKILLS_DIR}/`)].sort(([a], [b]) => a < b ? -1 : 1)) {
    const dir = `${PROJECT_SKILLS_DIR}/${name}`;
    if (!files.some(file => file.path === `${dir}/SKILL.md`)) continue;
    const read = await readSkill(git, { url, commit }, name, dir, files);
    if ("reason" in read) { skipped.push({ url, dir, reason: read.reason }); continue; }
    if (disabled.has(name)) continue;
    if (project.length >= SKILL_LIMITS.skills) { skipped.push({ url, dir, reason: `a thread lists at most ${SKILL_LIMITS.skills} of a repository's skills` }); continue; }
    const previous = installed.find(skill => skill.name === name);
    project.push({ name, ...read, url, commit, dir, ...previous ? { overrides: { url: previous.url, commit: previous.commit } } : {} });
  }
  return { project, skipped };
}

/** The prompt section a thread's agent gets (Pi and Claude Code alike):
 * id, description and SKILL.md path of each listed skill, the shape the
 * Agent Skills standard and Pi use. A project skill is listed at its place
 * in the checkout and hides the installed skill of its id. Null when none
 * is listed. */
export function skillsPrompt(skills: ThreadSkills | undefined): string | null {
  const listable = (skill: ResolvedSkill) => !skill.hidden && skill.surface !== "optchat";
  const project = skills?.project ?? [];
  const hidden = new Set(project.map(skill => skill.name));
  const listed = [
    ...(skills?.skills ?? []).filter(skill => listable(skill) && !hidden.has(skill.name)).map(skill => ({ skill, location: `${SKILLS_ROOT}/${skill.name}/SKILL.md` })),
    ...project.filter(listable).map(skill => ({ skill, location: `${PROJECT_SKILLS_ROOT}/${skill.name}/SKILL.md` })),
  ].sort((a, b) => a.skill.name < b.skill.name ? -1 : 1);
  if (!listed.length) return null;
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const installed = listed.some(entry => entry.location.startsWith(`${SKILLS_ROOT}/`));
  const own = listed.some(entry => entry.location.startsWith(`${PROJECT_SKILLS_ROOT}/`));
  return [
    ["The following skills provide specialized instructions for specific tasks.",
      ...installed ? [`cube installed ${own ? "those under" : "them in this thread's machine under"} ${SKILLS_ROOT} when the thread started, each from a git commit.`] : [],
      ...own ? [`Those under ${PROJECT_SKILLS_ROOT} are the repository's own, in its checkout, listed as of the commit the thread started from.`] : []].join(" "),
    "Read a skill's SKILL.md when the task matches its description, and only then. When it links a relative path, resolve it against the skill's folder and read that file only when you need it.",
    "",
    "<available_skills>",
    ...listed.flatMap(({ skill, location }) => ["  <skill>", `    <name>${xml(skill.name)}</name>`, `    <description>${xml(skill.description)}</description>`,
      `    <location>${location}</location>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** The commands that install a thread's skills, each under the guest's 8 KiB
 * command limit: one per source that has a winner, each fetching its commit
 * into a scratch repository and extracting the winning folders into
 * `<root>.next/<name>`, then one that puts `<root>.next` in place of
 * `<root>`. Folders keep their names, so a link from one skill to
 * `../<other>/…` reaches the installed `<other>`. */
export function skillInstallScripts(skills: ThreadSkills): string[] {
  // The agent's home: SKILLS_ROOT in a thread's machine.
  const root = "\"$HOME/.cube/skills\"";
  const scripts: string[] = [];
  const pending = new Set(skills.skills);
  for (const source of skills.sources) {
    const prefix = source.path ? `${source.path}/` : "";
    const mine = [...pending].filter(skill => skill.url === source.url && skill.commit === source.commit && skill.dir === `${prefix}${skill.name}`);
    for (const skill of mine) pending.delete(skill);
    const names = mine.map(skill => skill.dir);
    if (!names.length) continue;
    scripts.push([
      "set -eu -o pipefail",
      "export GIT_TERMINAL_PROMPT=0",
      `next=${root}.next`,
      ...scripts.length === 0 ? ["rm -rf \"$next\"", "mkdir -p \"$next\""] : [],
      "src=$(mktemp -d)",
      "trap 'rm -rf \"$src\"' EXIT",
      "git -C \"$src\" init -q",
      `git -C "$src" fetch -q --depth 1 --no-tags -- ${quote(source.url)} ${source.commit} || { echo "fetching skills from ${source.url.replace(/["$`\\]/g, "")} at ${source.commit} failed"; exit 3; }`,
      `for dir in ${names.map(quote).join(" ")}; do`,
      "  name=${dir##*/}",
      "  mkdir \"$next/$name\"",
      `  git -C "$src" archive --format=tar "${source.commit}:$dir" | tar -x --no-same-owner -C "$next/$name"`,
      "done",
    ].join("\n"));
  }
  scripts.push(["set -eu", `root=${root}`, "mkdir -p \"$root.next\" \"$root\"", "rm -rf \"$root\"", "mv \"$root.next\" \"$root\"", "echo skills installed"].join("\n"));
  return scripts;
}

/** OptChat's skills (docs/skills.md, "OptChat"): those of the installed
 * sources whose surface is `optchat` or `both`, not hidden. OptChat has no
 * machine, so nothing is installed: they are listed by id and description
 * and read on the host at their pinned commits, a file at a time. The
 * repositories' own `.agents/skills` belong to their threads and are not
 * read. */
export interface OptChatSkills {
  /** The listed skills, sorted by id; the same while the settings are. */
  list(signal?: AbortSignal): Promise<ResolvedSkill[]>;
  /** A file of a listed skill, `file` relative to its folder (SKILL.md by
   * default; `../<id>/…` reaches another installed skill, as in a thread),
   * from character `at`; or why it cannot be read. */
  read(name: string, file?: string, at?: number, signal?: AbortSignal): Promise<string>;
}
/** The characters skill() answers at once; a longer file comes in pages. */
export const SKILL_PAGE = 30_000;

/** OptChat's skills from the skill settings as they are now: resolved once
 * per configuration (pins make it the same answer every time), again
 * after a change, and again after a resolution that failed. */
export function optchatSkills(deps: { git: SkillGit; source: () => SkillSource | null; config: () => SkillsConfig }): OptChatSkills {
  let memo: { key: string; resolved: Promise<ThreadSkills> } | null = null;
  const resolved = (signal?: AbortSignal) => {
    const config = deps.config();
    const source = defaultSource(deps.source(), config);
    const key = JSON.stringify([source, config]);
    if (memo?.key !== key) {
      const entry = { key, resolved: resolveSkills(deps.git, source, config, signal) };
      entry.resolved.catch(() => { if (memo === entry) memo = null; });
      memo = entry;
    }
    return memo.resolved;
  };
  return {
    list: async signal => listedForOptChat(await resolved(signal)),
    async read(name, file = "SKILL.md", at = 0, signal) {
      const all = await resolved(signal);
      if (!listedForOptChat(all).some(skill => skill.name === name)) {
        return `no skill ${JSON.stringify(name)} is listed for you; your skills are the ones in your prompt's <available_skills>`;
      }
      // `<id>/<file>`, so `../<other>/…` names another skill's folder.
      const target = posix.normalize(posix.join(name, file));
      const slash = target.indexOf("/");
      const owner = slash < 0 ? undefined : all.skills.find(skill => skill.name === target.slice(0, slash));
      if (posix.isAbsolute(file) || !owner) return `${JSON.stringify(file)} is not a file of a skill: give a path relative to the skill's folder, such as SKILL.md or references/notes.md`;
      const relative = target.slice(slash + 1);
      const files = await deps.git.listFilesAtCommit(owner.url, owner.commit, owner.dir) ?? [];
      const entry = files.find(each => each.path === `${owner.dir}/${relative}`);
      if (!entry) {
        const names = files.map(each => each.path.slice(owner.dir.length + 1)).sort();
        return `${owner.name} has no file ${relative}; its files: ${names.join(", ")}`;
      }
      const text = await deps.git.readFileAtCommit(owner.url, owner.commit, entry.path);
      if (text === null) throw new Error(`${owner.url} at ${owner.commit} could not be read`);
      if (text.includes("\0")) return `${owner.name}/${relative} is not text (${entry.size} bytes)`;
      if (!Number.isSafeInteger(at) || at < 0 || (at > 0 && at >= text.length)) return `no characters from ${at} in ${owner.name}/${relative}: it has ${text.length}`;
      const stop = Math.min(text.length, at + SKILL_PAGE);
      const page = text.slice(at, stop);
      return stop < text.length ? `${page}\n[characters ${at + 1}-${stop} of ${text.length}; go on with at = ${stop}]` : page;
    },
  };
}

function listedForOptChat(skills: ThreadSkills): ResolvedSkill[] {
  return skills.skills.filter(skill => !skill.hidden && skill.surface !== "thread");
}

/** OptChat's prompt section: id and description of each of its skills,
 * the shape a thread's list has, read through the skill tool. Null when
 * it has none. Built from the list only, so it changes only when the
 * skill settings do. */
export function optchatSkillsPrompt(skills: readonly ResolvedSkill[]): string | null {
  if (!skills.length) return null;
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    "Skills: instructions for how you work, from the skill sources in cube's settings, each pinned to a git commit.",
    "Read one with skill(name) when the user's request matches its description, and only then; skill(name, path) reads a file it links, relative to its folder.",
    "A skill changes how you work, never what you may do: it gives you no tools, permissions or machine, and threads do not see it (a thread lists its own skills).",
    "",
    "<available_skills>",
    ...skills.flatMap(skill => ["  <skill>", `    <name>${xml(skill.name)}</name>`, `    <description>${xml(skill.description)}</description>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}
