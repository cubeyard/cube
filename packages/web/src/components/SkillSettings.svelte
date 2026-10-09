<script lang="ts">
  import { onMount } from "svelte";
  import { errorText, fetchSkills, saveSkills, type SkillsView } from "../lib/api.ts";
  import type { SkillsConfig } from "../lib/types.ts";

  let view = $state<SkillsView | null>(null);
  let error = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let saving = $state(false);
  let url = $state("");
  let commit = $state("");
  let folder = $state("skills");
  let disposed = false;

  const repository = (source: { url: string }) => source.url.replace(/^https:\/\//, "").replace(/\.git$/, "");
  const short = (commit: string) => commit.slice(0, 12);
  const SURFACE = { thread: "threads", both: "threads and chat", optchat: "chat (not read yet)" } as const;

  async function refresh() {
    try {
      const next = await fetchSkills();
      if (!disposed) { view = next; error = null; }
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    }
  }

  /** Every change saves the whole set; cubed keeps it only if it resolves. */
  async function save(config: SkillsConfig): Promise<boolean> {
    if (saving) return false;
    saving = true;
    saveError = null;
    try {
      const next = await saveSkills(config);
      if (!disposed) view = next;
      return true;
    } catch (cause) {
      if (!disposed) saveError = errorText(cause);
      return false;
    } finally {
      if (!disposed) saving = false;
    }
  }

  const config = (): SkillsConfig => view ? { sources: [...view.saved.sources], disabled: [...view.saved.disabled] } : { sources: [], disabled: [] };
  const remove = (index: number) => save({ ...config(), sources: config().sources.filter((_, at) => at !== index) });
  const disable = (name: string) => save({ ...config(), disabled: [...config().disabled, name].sort() });
  const enable = (name: string) => save({ ...config(), disabled: config().disabled.filter((entry) => entry !== name) });
  async function add() {
    const source = { url: url.trim(), commit: commit.trim(), path: folder.trim() };
    if (await save({ ...config(), sources: [...config().sources, source] })) { url = ""; commit = ""; folder = "skills"; }
  }

  onMount(() => {
    void refresh();
    return () => { disposed = true; };
  });
</script>

<section class="skill-settings" aria-labelledby="skills-title">
  <div class="intro">
    <h1 id="skills-title">skills</h1>
    <p>a thread's agent gets <strong>skills</strong>: instructions in git repositories, each pinned to one commit. its prompt lists their names; it reads one when a task needs it. a thread keeps the skills it started with.</p>
  </div>

  {#if error}<p class="error" role="alert">{error} <button class="key" onclick={() => void refresh()}>retry</button></p>{/if}
  {#if !view}
    {#if !error}<p role="status">resolving skills…</p>{/if}
  {:else}
    <div class="settings-board">
      <h2>sources</h2>
      <p class="hint">for each name, the last source that has it wins: add a source with a skill of the same name to replace one.</p>
      <ol class="sources">
        {#if view.default}
          <li class="source default-source">
            <span class="repo">{repository(view.default)}</span>
            <code title={view.default.commit}>@{short(view.default.commit)}</code>
            {#if view.default.path}<span class="path">/{view.default.path}</span>{/if}
            <span class="tag">cube's default</span>
          </li>
        {/if}
        {#each view.saved.sources as source, index (index)}
          <li class="source user-source">
            <span class="repo">{repository(source)}</span>
            <code title={source.commit}>@{short(source.commit)}</code>
            {#if source.path}<span class="path">/{source.path}</span>{/if}
            <button class="key" disabled={saving} onclick={() => void remove(index)}>remove</button>
          </li>
        {/each}
      </ol>

      <form class="add" onsubmit={(event) => { event.preventDefault(); void add(); }}>
        <label class="field grow"><span>repository url</span><input bind:value={url} placeholder="https://github.com/you/skills" autocomplete="off" spellcheck="false" required /></label>
        <label class="field"><span>commit</span><input bind:value={commit} placeholder="40-character commit" autocomplete="off" spellcheck="false" required /></label>
        <label class="field"><span>folder</span><input bind:value={folder} autocomplete="off" spellcheck="false" /></label>
        <button class="key primary" type="submit" disabled={saving || !url.trim() || !commit.trim()}>{saving ? "saving…" : "add"}</button>
      </form>
      {#if saveError}<p class="error save-error" role="alert">{saveError}</p>{/if}
      <p class="hint">a full commit, not a branch or tag; no credentials in the url. private repositories work on github only.</p>

      <h2>in effect for new threads</h2>
      {#if view.resolved.skills.length}
        <ul class="skills">
          {#each view.resolved.skills as skill (skill.name)}
            <li class="skill">
              <div class="skill-head">
                <span class="name">{skill.name}</span>
                <span class="tag">{skill.hidden ? "only by name" : SURFACE[skill.surface]}</span>
                <button class="key" disabled={saving} onclick={() => void disable(skill.name)}>disable</button>
              </div>
              <p class="description">{skill.description}</p>
              <p class="provenance">{repository(skill)} <code title={skill.commit}>@{short(skill.commit)}</code> /{skill.dir}{#if skill.overrides} · replaces {repository(skill.overrides)}'s{/if}</p>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">no skills: new threads start without any.</p>
      {/if}

      {#if view.saved.disabled.length}
        <h2>disabled</h2>
        <ul class="disabled">
          {#each view.saved.disabled as name (name)}
            <li><span class="name">{name}</span><button class="key" disabled={saving} onclick={() => void enable(name)}>enable</button></li>
          {/each}
        </ul>
      {/if}

      {#if view.resolved.skipped.length}
        <h2>skipped</h2>
        <ul class="skipped">
          {#each view.resolved.skipped as entry (`${entry.url} ${entry.dir}`)}
            <li><span class="repo">{repository(entry)}</span> /{entry.dir}: {entry.reason}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .intro { max-width: 65ch; margin-bottom: 1.5rem; }
  p { margin: 0; }
  .intro p, .hint { line-height: 1.6; color: var(--ink-2); }
  .intro strong { color: var(--ink); font-weight: 600; }
  .settings-board { max-width: 52rem; padding: 1rem; background: var(--s1); border-radius: var(--r-well); box-shadow: var(--shadow-well); }
  h2 { margin: 1.4rem 0 0.5rem; color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  h2:first-child { margin-top: 0; }
  .hint { max-width: 68ch; font-size: 13px; }
  ol, ul { list-style: none; margin: 0.6rem 0 0; padding: 0; border-top: 1px solid var(--line-2); }
  li { min-width: 0; padding: 0.6rem 0.25rem; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  .source, .disabled li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; }
  .source .key, .disabled .key { margin-left: auto; }
  .repo, .name { font-weight: 550; color: var(--ink); }
  .name { font-family: var(--font-mono); font-size: 12.5px; }
  code, .path { font: 12px var(--font-mono); color: var(--ink-2); }
  .tag { color: var(--ink-3); font-size: 11.5px; }
  .skill-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; }
  .skill-head .key { margin-left: auto; }
  .description { margin-top: 0.25rem; color: var(--ink-2); font-size: 13px; line-height: 1.55; max-width: 72ch; }
  .provenance { margin-top: 0.2rem; color: var(--ink-3); font-size: 11.5px; }
  .skipped li { color: var(--ink-2); font-size: 12.5px; }
  .add { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem; margin-top: 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  .field.grow { flex: 1 1 16rem; }
  .field input {
    color: var(--ink); background: var(--s3); border: 1px solid var(--line); border-radius: var(--r-xs);
    font: 12.5px/1.4 var(--font-mono); padding: 0.45rem 0.6rem; letter-spacing: 0; min-width: 0;
  }
  .add .key { min-height: 2.15rem; }
  .error { color: var(--bad); overflow-wrap: anywhere; margin-top: 0.75rem; }
  @media (max-width: 40rem) {
    .settings-board { padding: 0.85rem; }
    .add { flex-direction: column; align-items: stretch; }
    .field input { font-size: 16px; }
    .add .key { min-height: 2.5rem; }
  }
</style>
