/** A project's external hooks as OptChat reads and changes them
 * (`project_hooks`, `project_hooks_write`; docs/project-hooks.md). The
 * hooks themselves are `ProjectHooks` (registry.ts); vm.ts runs them. */
import { createHash } from "node:crypto";
import { MAX_HOOK_BYTES, NO_HOOKS, projectHooks, type HookOutcome, type Project, type ProjectHooks, type Registry } from "./registry.ts";
import { REDACTED, redact, safeText } from "./vm-diagnostics.ts";
import { hookFileContent } from "./vm-seed.ts";

/** What cube supports, said once for the tools and the docs. Nothing else
 * (no timeout, working directory, order or trigger of one's own) is settable. */
export const HOOKS_SUPPORTED = `Supported hooks (the only two; nothing else is settable):
- preSetup ("pre-setup"): runs once when a new thread machine is prepared, after the project's repositories are checked out and before the repository's own .agents/setup, which runs only if pre-setup succeeded. A machine made from a prepared template skips both (the template ran them), unless the pinned .agents/setup differs from the template's.
- preResume ("pre-resume"): runs on every boot of a thread machine before the agent opens, before the repository's .agents/resume, which runs only if pre-resume succeeded.
Each is one script of at most ${MAX_HOOK_BYTES} bytes, run as the guest user agent in /workspace with bash unless it starts with #!; output goes to ~/.cache/cube/<hook>.log in that machine. The order is fixed: the external hook, then the repository's, which runs only after the external one succeeded (or is absent). There is no per-hook timeout: the whole preparation (checkout and setup hooks) and the whole resume phase each have 30 minutes. A failing hook is recorded and never fails the thread. New threads use the hooks saved when they start; running threads keep theirs. A changed pre-setup means a new template. Hooks are not secret storage: every machine of the project can read them.`;

/** At most this many threads' latest outcomes are shown. */
export const HOOK_RESULTS_SHOWN = 8;
const HOOK_NAMES = ["pre-setup", "setup", "pre-resume", "resume"] as const;
// Room for escaped control characters: a saved script is never cut.
const SCRIPT_SHOWN = 10 * MAX_HOOK_BYTES;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `redact`, and in a script also the values of variables whose name says
 * secret, token, password, key, credential or auth, and passwords in URLs. */
export function redactHook(text: string): string {
  return redact(text
    .replace(/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*[ \t]*=[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`));
}

/** A project by its exact id, else by its name (any case); an ambiguous name is refused. */
export function findProject(registry: Registry, given: string): Project {
  const name = given.trim();
  const byId = registry.getProject(name);
  if (byId) return byId;
  const named = registry.listProjects().filter(project => project.name.toLowerCase() === name.toLowerCase());
  if (named.length > 1) throw new Error(`${named.length} projects are named ${name}; name it by id (${named.map(project => project.id).join(", ")})`);
  if (!named.length) throw new Error(`no project ${name}`);
  return named[0]!;
}

/** One hook's saved script for reading back: the size and sha256 of what is
 * stored and of the file a machine gets (what `cube hooks` shows), and the
 * text with secret-looking values redacted. */
function script(label: string, text: string): string[] {
  if (!text) return [`${label}: none`];
  const safe = safeText(text, SCRIPT_SHOWN);
  const shown = redactHook(safe);
  return [`${label}: ${Buffer.byteLength(text)} bytes, sha256 ${sha256(text)}; in a machine sha256 ${sha256(hookFileContent(text))}`
    + (shown !== safe ? " (secret-looking values shown as [redacted]; keep secrets out of hooks)" : ""),
    "```sh", shown, "```"];
}

function outcome(name: string, hook: HookOutcome | undefined): string {
  if (!hook) return `${name} not recorded`;
  return `${name} ${hook.status}${hook.exitCode !== undefined ? ` (exit ${hook.exitCode})` : ""}${hook.status === "ok" || hook.status === "failed" ? ` ${Math.round(hook.ms / 100) / 10} s` : ""}`;
}

const same = (a: ProjectHooks | undefined, b: ProjectHooks | undefined) =>
  (a?.preSetup ?? "") === (b?.preSetup ?? "") && (a?.preResume ?? "") === (b?.preResume ?? "");

/** The project's saved hooks and the latest outcomes in its newest threads, as text. */
export function describeProjectHooks(registry: Registry, project: Project): string {
  const hooks = project.hooks ?? NO_HOOKS;
  const threads = registry.listThreads().filter(thread => thread.projectId === project.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const lines = [
    `project ${project.name} (id ${project.id}); ${project.hooksUpdatedAt ? `hooks last changed ${new Date(project.hooksUpdatedAt).toISOString()}`
      : hooks.preSetup || hooks.preResume ? "hooks last changed before cube recorded it" : "hooks never set"}`,
    ...script("preSetup", hooks.preSetup),
    ...script("preResume", hooks.preResume),
    "",
    `latest outcomes in this project's newest threads (cubed records status, exit code and duration; the logs stay in each machine, at ~/.cache/cube/<hook>.log, where cube hooks shows them):`,
    ...threads.slice(0, HOOK_RESULTS_SHOWN).map(thread => {
      const recorded = thread.vm?.hooks ?? {};
      const at = Math.max(0, ...Object.values(recorded).map(hook => hook.at));
      return `[${thread.id.slice(0, 8)}] ${safeText(thread.title ?? "untitled", 80)}${thread.archived ? " (archived)" : ""}: `
        + `${same(thread.allocation.hooks, hooks) ? "the saved hooks" : "earlier hooks"}; `
        + `${Object.keys(recorded).length ? HOOK_NAMES.map(name => outcome(name, recorded[name])).join(", ") : "no outcome recorded yet"}`
        + (at ? `; last ${new Date(at).toISOString()}` : "");
    }),
    ...threads.length > HOOK_RESULTS_SHOWN ? [`(${threads.length - HOOK_RESULTS_SHOWN} older threads not shown)`] : [],
    ...threads.length ? [] : ["no threads yet"],
    "",
    HOOKS_SUPPORTED,
  ];
  return lines.join("\n");
}

/** Saves the given hooks (an absent one stays, "" removes it) and reads
 * them back from the registry. */
export function writeProjectHooks(registry: Registry, given: string, input: { preSetup?: string | undefined; preResume?: string | undefined }): string {
  const project = findProject(registry, given);
  const changes = Object.fromEntries(Object.entries({ preSetup: input.preSetup, preResume: input.preResume }).filter(([, value]) => value !== undefined));
  if (!Object.keys(changes).length) throw new Error("give preSetup or preResume (\"\" removes one)");
  const previous = project.hooks ?? NO_HOOKS;
  const hooks = projectHooks(changes, previous);
  const saved = registry.saveProjectHooks(project.id, hooks);
  const stored = saved.hooks ?? NO_HOOKS;
  if (!same(stored, hooks)) throw new Error("the hooks read back differ from what was saved");
  const changed = (["preSetup", "preResume"] as const).filter(name => previous[name] !== stored[name]);
  const secret = (["preSetup", "preResume"] as const).filter(name => redactHook(stored[name]) !== stored[name]);
  return [
    changed.length ? `saved ${changed.join(" and ")}; read back from cubed's registry:` : "nothing changed; read back from cubed's registry:",
    ...changed.includes("preSetup") ? ["a changed pre-setup means a new template: the next thread prepares its machine from the start"] : [],
    ...secret.length ? [`warning: ${secret.join(" and ")} hold secret-looking values; every machine of the project can read hooks`] : [],
    "new threads use these hooks; running threads keep the ones they started with",
    "",
    describeProjectHooks(registry, saved),
  ].join("\n");
}
