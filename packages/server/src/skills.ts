/** Skills for a thread's agent: folders with a SKILL.md (agentskills.io)
 * from git repositories, each pinned to an exact commit. A thread's skills
 * are resolved on the host when it starts, kept in its allocation like its
 * repositories' commits, installed in its machine before the agent opens and
 * listed in its prompt by name and description only; the agent reads a
 * SKILL.md, and what it links to, when a task needs it.
 *
 * Precedence: cube's default source, then the user's sources in their order;
 * for each skill name the last source that has it wins, whatever its
 * surface, and a disabled name is left out. docs/skills.md. */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { GUEST_HOME } from "../../claude-mod/hooks/tools.ts";

/** A directory of skill folders (`<path>/<name>/SKILL.md`) in a git
 * repository at one commit. */
export interface SkillSource { url: string; commit: string; path: string }
export type SkillSurface = "thread" | "optchat" | "both";

/** What the user chose, in settings.json: sources after the default one,
 * and skill names to leave out. */
export interface SkillsConfig { sources: SkillSource[]; disabled: string[] }
export const NO_SKILLS_CONFIG: SkillsConfig = { sources: [], disabled: [] };

/** The skill that won its name, with where it came from. */
export interface ResolvedSkill {
  name: string; description: string; surface: SkillSurface;
  /** Installed, but left out of the prompt (`disable-model-invocation: true`). */
  hidden?: true;
  url: string; commit: string;
  /** Its folder in the repository. */
  dir: string;
  /** Another source's skill of the same name that this one overrides. */
  overrides?: { url: string; commit: string };
}
/** A thread's skills, fixed at its start. */
export interface ThreadSkills { sources: SkillSource[]; skills: ResolvedSkill[]; skipped: Array<{ url: string; dir: string; reason: string }> }

/** cubeyard/skills at an exact commit, which only a cube release changes;
 * the cubed command passes it to createCubed. */
export const DEFAULT_SKILL_SOURCE: SkillSource = {
  url: "https://github.com/cubeyard/skills",
  commit: "d5041ce9ae3af0c5b0dbb00234a2bd600df8cf63",
  path: "skills",
};

export const SKILLS_ROOT = `${GUEST_HOME}/.cube/skills`;
export const SKILL_LIMITS = { skills: 64, files: 2000, bytes: 8 * 2 ** 20, description: 1024 };
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SURFACES = new Set<SkillSurface>(["thread", "optchat", "both"]);

/** The host's git, narrowed to what resolution reads. */
export interface SkillGit {
  ensureMirror(url: string): Promise<string>;
  listFilesAtCommit(url: string, oid: string, dir: string): Promise<Array<{ path: string; mode: string; size: number }> | null>;
  readFileAtCommit(url: string, oid: string, relPath: string): Promise<string | null>;
}

/** settings.json's `skills`, or why it is not one. */
export function parseSkillsConfig(value: unknown): SkillsConfig {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("skills must be an object {sources, disabled}");
  const extra = Object.keys(record).filter(key => key !== "sources" && key !== "disabled");
  if (extra.length) throw new Error(`skills: unknown field ${extra.join(", ")}`);
  const sources = record.sources ?? [];
  const disabled = record.disabled ?? [];
  if (!Array.isArray(sources) || !Array.isArray(disabled)) throw new Error("skills.sources and skills.disabled must be lists");
  return {
    sources: sources.map((source, index) => parseSource(source, `skills.sources[${index}]`)),
    disabled: disabled.map((name, index) => {
      if (typeof name !== "string" || !NAME.test(name)) throw new Error(`skills.disabled[${index}] is not a skill name`);
      return name;
    }),
  };
}

function parseSource(value: unknown, at: string): SkillSource {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`${at} must be {url, commit, path?}`);
  const extra = Object.keys(record).filter(key => !["url", "commit", "path"].includes(key));
  if (extra.length) throw new Error(`${at}: unknown field ${extra.join(", ")}`);
  const { url, commit, path = "" } = record;
  if (typeof url !== "string" || !/^https:\/\/[^\s'"\\]+$/.test(url)) throw new Error(`${at}.url must be an https git URL`);
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`${at}.commit must be a full 40-character commit, not a branch or tag`);
  if (typeof path !== "string" || path.startsWith("/") || path.split("/").some(part => part === ".." || part === ".") || /[\s'"\\]/.test(path)) {
    throw new Error(`${at}.path must be a directory in the repository, without . or ..`);
  }
  return { url, commit, path: path.replace(/\/+$/, "") };
}

/** Every skill of every source, in precedence order, then the winners. A
 * source that cannot be read fails resolution; a skill folder that does not
 * qualify is skipped, with the reason. */
export async function resolveSkills(git: SkillGit, defaultSource: SkillSource | null, config: SkillsConfig): Promise<ThreadSkills> {
  const sources = [...defaultSource ? [defaultSource] : [], ...config.sources];
  const disabled = new Set(config.disabled);
  const winners = new Map<string, ResolvedSkill>();
  const skipped: ThreadSkills["skipped"] = [];
  const sizes = new Map<string, { files: number; bytes: number }>();
  for (const source of sources) {
    let entries = await git.listFilesAtCommit(source.url, source.commit, source.path);
    if (!entries) {
      await git.ensureMirror(source.url);
      entries = await git.listFilesAtCommit(source.url, source.commit, source.path);
    }
    if (!entries) throw new Error(`skills source ${source.url} has no commit ${source.commit}`);
    const prefix = source.path ? `${source.path}/` : "";
    const folders = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const name = rest.slice(0, slash);
      folders.set(name, [...folders.get(name) ?? [], entry]);
    }
    for (const [name, files] of [...folders].sort(([a], [b]) => a < b ? -1 : 1)) {
      const dir = `${prefix}${name}`;
      const skip = (reason: string) => { skipped.push({ url: source.url, dir, reason }); };
      if (!files.some(file => file.path === `${dir}/SKILL.md`)) continue;
      if (!NAME.test(name)) { skip("the folder name is not a skill name (lowercase letters, digits and inner hyphens)"); continue; }
      const odd = files.find(file => file.mode !== "100644" && file.mode !== "100755");
      if (odd) { skip(`${odd.path} is a ${odd.mode === "120000" ? "symlink" : odd.mode === "160000" ? "submodule" : `mode ${odd.mode} entry`}; skills are plain files`); continue; }
      const text = await git.readFileAtCommit(source.url, source.commit, `${dir}/SKILL.md`);
      let frontmatter: Record<string, unknown>;
      try { frontmatter = parseFrontmatter(text ?? "").frontmatter as Record<string, unknown>; }
      catch (error) { skip(`SKILL.md frontmatter is not YAML: ${(error as Error).message}`); continue; }
      if (frontmatter.name !== name) { skip(`SKILL.md names ${JSON.stringify(frontmatter.name)}, not its folder ${name}`); continue; }
      const description = typeof frontmatter.description === "string" ? frontmatter.description.replace(/\s+/g, " ").trim() : "";
      if (!description || description.length > SKILL_LIMITS.description) { skip(`description must be 1 to ${SKILL_LIMITS.description} characters`); continue; }
      const metadata = frontmatter.metadata as { cube?: { surface?: unknown } } | undefined;
      const surface = metadata?.cube?.surface ?? "thread";
      if (!SURFACES.has(surface as SkillSurface)) { skip(`metadata.cube.surface ${JSON.stringify(surface)} is not thread, optchat or both`); continue; }
      const previous = winners.get(name);
      winners.set(name, { name, description, surface: surface as SkillSurface, ...frontmatter["disable-model-invocation"] === true ? { hidden: true as const } : {},
        url: source.url, commit: source.commit, dir, ...previous ? { overrides: { url: previous.url, commit: previous.commit } } : {} });
      sizes.set(name, { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) });
    }
  }
  const skills = [...winners.values()].filter(skill => !disabled.has(skill.name)).sort((a, b) => a.name < b.name ? -1 : 1);
  const total = skills.reduce((sum, skill) => ({ files: sum.files + sizes.get(skill.name)!.files, bytes: sum.bytes + sizes.get(skill.name)!.bytes }), { files: 0, bytes: 0 });
  if (skills.length > SKILL_LIMITS.skills) throw new Error(`a thread installs at most ${SKILL_LIMITS.skills} skills, not ${skills.length}: disable some`);
  if (total.files > SKILL_LIMITS.files || total.bytes > SKILL_LIMITS.bytes) {
    throw new Error(`the skills are ${total.files} files and ${total.bytes} bytes; a thread installs at most ${SKILL_LIMITS.files} files and ${SKILL_LIMITS.bytes / 2 ** 20} MiB`);
  }
  return { sources, skills, skipped };
}

/** The prompt section a thread's agent gets (Pi and Claude Code alike):
 * name, description and SKILL.md path of each listed skill, the shape the
 * Agent Skills standard and Pi use. Null when none is listed. */
export function skillsPrompt(skills: ThreadSkills | undefined): string | null {
  const listed = skills?.skills.filter(skill => !skill.hidden && skill.surface !== "optchat") ?? [];
  if (!listed.length) return null;
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    `The following skills provide specialized instructions for specific tasks. cube installed them in this thread's machine under ${SKILLS_ROOT} when the thread started, each from a git commit.`,
    "Read a skill's SKILL.md when the task matches its description, and only then. When it links a relative path, resolve it against the skill's folder and read that file only when you need it.",
    "",
    "<available_skills>",
    ...listed.flatMap(skill => ["  <skill>", `    <name>${xml(skill.name)}</name>`, `    <description>${xml(skill.description)}</description>`,
      `    <location>${SKILLS_ROOT}/${skill.name}/SKILL.md</location>`, "  </skill>"]),
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
