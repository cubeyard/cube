<script lang="ts">
  import { tick } from "svelte";

  let { value = $bindable(""), label, loginHref, onchange, onselect }: {
    value: string;
    label: string;
    loginHref: string;
    onchange: () => void;
    onselect: (fullName: string) => void;
  } = $props();
  type Repository = { fullName: string; private: boolean };
  const id = $props.id();
  let repositories = $state<Repository[]>([]);
  let open = $state(false);
  let loading = $state(false);
  let disconnected = $state(false);
  let failed = $state(false);
  let active = $state(-1);
  const query = $derived(value.trim().toLowerCase());
  function rank(repository: Repository): number {
    const full = repository.fullName.toLowerCase();
    const name = full.split("/")[1] ?? "";
    return full === query || name === query ? 0 : full.startsWith(query) || name.startsWith(query) ? 1 : 2;
  }
  const matches = $derived(repositories.filter((repo) => repo.fullName.toLowerCase().includes(query)).sort((a, b) => rank(a) - rank(b)));

  async function load() {
    if (loading) return;
    loading = true;
    failed = false;
    try {
      const response = await fetch("/api/github/repositories");
      if (!response.ok) throw new Error("repository request failed");
      const data = await response.json() as { repositories: Repository[] | null };
      disconnected = data.repositories === null;
      repositories = data.repositories ?? [];
    } catch {
      repositories = [];
      failed = true;
    } finally {
      active = -1;
      loading = false;
    }
  }

  function select(repo: Repository) {
    value = repo.fullName;
    onchange();
    onselect(repo.fullName);
    open = false;
    active = -1;
  }

  async function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      open = false;
      active = -1;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { open = true; void load(); }
      active = Math.max(0, Math.min(matches.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      await tick();
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open && !loading && active >= 0 && matches[active]) {
      event.preventDefault();
      select(matches[active]);
    }
  }
</script>

<div class="repository-input" onfocusout={(event) => {
  if (!event.currentTarget.contains(event.relatedTarget as Node)) { open = false; active = -1; }
}}>
  <input class="compose-input" role="combobox" aria-label={label}
    aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
    aria-activedescendant={open && active >= 0 && matches[active] ? `${id}-${active}` : undefined}
    autocomplete="off" placeholder="search repos or paste a git URL" bind:value
    onfocus={() => { open = true; void load(); }}
    oninput={() => { active = -1; open = true; onchange(); }} onkeydown={keydown} />
  {#if open}
    <div class="suggestions">
      <div class="silk caption">your github repositories</div>
      <div role="status" class="caption">
        {#if loading}loading repositories…
        {:else if failed}could not load repositories — enter one manually or retry
        {:else if disconnected}connect github to browse repositories
        {:else if !matches.length}no matching repositories — enter owner/name or paste a git URL
        {:else}<span class="sr-only">{matches.length} repositories</span>{/if}
      </div>
      {#if failed}<button class="text-action" onclick={load}>retry</button>{/if}
      {#if disconnected}<a class="text-action" href={loginHref}>connect github</a>{/if}
      <div id={`${id}-list`} role="listbox" aria-label="github repositories" class="results">
        {#if !loading && !failed && !disconnected}
          {#each matches as repo, i (repo.fullName)}
            <button type="button" role="option" id={`${id}-${i}`} tabindex="-1"
              aria-selected={active === i} class:active={active === i}
              onmousedown={(event) => event.preventDefault()} onclick={() => select(repo)}>
              <span class="repo-name">{repo.fullName}</span>
              {#if repo.private}<small>private</small>{/if}
            </button>
          {/each}
        {/if}
      </div>
      {#if matches.length && !loading && !failed && !disconnected}
        <div class="caption footer">type an owner/name or paste a git URL</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .repository-input { position: relative; min-width: 0; }
  input { width: 100%; }
  .suggestions { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; width: max(100%, 23rem); max-width: calc(100vw - 5rem); background: var(--s3); border: 1px solid var(--line-2); border-radius: var(--r-key); box-shadow: var(--shadow-float); overflow: hidden; }
  .caption { padding: 0.6rem 0.85rem; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
  .caption:has(.sr-only), .caption:empty { padding: 0; }
  .results { max-height: 16rem; overflow-y: auto; }
  .results button { display: flex; align-items: center; gap: 1rem; width: 100%; min-height: 2.6rem; padding: 0.65rem 0.85rem; text-align: left; background: transparent; border: 0; color: var(--ink); cursor: pointer; }
  .results button:hover, .results button.active { background: var(--signal-soft); }
  .repo-name { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
  small { margin-left: auto; color: var(--ink-2); font-size: 11px; }
  .footer { border-top: 1px solid var(--line); }
  .text-action { display: inline-block; margin: 0 0.85rem 0.75rem; color: var(--ink); background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  @media (max-width: 40rem) { input { font-size: 16px; } .suggestions { width: 100%; max-width: 100%; } }
</style>
