<script lang="ts" module>
  // One list per page, shared by the primary and reference fields: switching
  // fields must not refetch or re-render the whole list, and a request that
  // is already in flight is joined rather than repeated.
  type Repository = { fullName: string; private: boolean };
  const FRESH_MS = 60_000;
  const TIMEOUT_MS = 8_000;
  const GENERIC = "could not load repositories — retry, or enter a repository manually";

  class LoadError extends Error {}

  let fresh: { repositories: Repository[]; at: number } | null = null;
  let inflight: { promise: Promise<Repository[] | null>; controller: AbortController; waiters: number } | null = null;

  function cached(): Repository[] | null {
    return fresh && Date.now() - fresh.at < FRESH_MS ? fresh.repositories : null;
  }

  async function fetchRepositories(signal: AbortSignal): Promise<Repository[] | null> {
    let response: Response;
    try {
      response = await fetch("/api/github/repositories", { signal });
    } catch {
      throw new LoadError("can't reach the host — retry, or enter a repository manually");
    }
    if (!response.ok) {
      let message = GENERIC;
      try {
        message = String((await response.json()).error ?? message);
      } catch {
        // non-JSON error body — keep the generic line
      }
      throw new LoadError(message);
    }
    const data = (await response.json()) as { repositories: Repository[] | null };
    // A disconnected answer is never cached: connecting github must show at once.
    if (data.repositories) fresh = { repositories: data.repositories, at: Date.now() };
    return data.repositories;
  }

  /** Join or start the shared request. `leave` must be called once the caller
   * stops waiting; the last one out aborts a request nobody wants any more. */
  function request(): { promise: Promise<Repository[] | null>; leave: () => void } {
    if (!inflight) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const entry = {
        controller,
        waiters: 0,
        promise: fetchRepositories(controller.signal).finally(() => {
          clearTimeout(timer);
          if (inflight === entry) inflight = null;
        }),
      };
      entry.promise.catch(() => {}); // every waiter handles its own rejection
      inflight = entry;
    }
    const entry = inflight;
    entry.waiters++;
    let left = false;
    return {
      promise: entry.promise,
      leave: () => {
        if (left) return;
        left = true;
        if (--entry.waiters === 0 && inflight === entry) entry.controller.abort();
      },
    };
  }
</script>

<script lang="ts">
  import { onDestroy, tick } from "svelte";

  let { value = $bindable(""), label, loginHref, onchange, onselect }: {
    value: string;
    label: string;
    loginHref: string;
    onchange: () => void;
    onselect: (fullName: string) => void;
  } = $props();
  const id = $props.id();
  const LIMIT = 50;

  let repositories = $state.raw<Repository[]>(cached() ?? []);
  let open = $state(false);
  let loading = $state(false);
  let disconnected = $state(false);
  let failure = $state<string | null>(null);
  let retrying = $state(false);
  let active = $state(-1);
  let container = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let restoringFocus = false;
  let leave: (() => void) | null = null;
  let destroyed = false;

  const query = $derived(value.trim().toLowerCase());
  function rank(repository: Repository): number {
    const full = repository.fullName.toLowerCase();
    const name = full.split("/")[1] ?? "";
    return full === query || name === query ? 0 : full.startsWith(query) || name.startsWith(query) ? 1 : 2;
  }
  const matches = $derived(repositories.filter((repo) => repo.fullName.toLowerCase().includes(query)).sort((a, b) => rank(a) - rank(b)));
  // Only what is rendered can be the active descendant, and nothing is rendered while loading.
  const shown = $derived(!loading && !failure && !disconnected ? matches.slice(0, LIMIT) : []);
  const hidden = $derived(shown.length ? matches.length - shown.length : 0);

  async function load() {
    if (loading) return;
    const warm = cached();
    if (warm) {
      repositories = warm;
      disconnected = false;
      failure = null;
      return;
    }
    loading = true;
    failure = null;
    active = -1;
    const shared = request();
    leave = shared.leave;
    try {
      const list = await shared.promise;
      if (destroyed) return;
      disconnected = list === null;
      repositories = list ?? [];
    } catch (error) {
      if (destroyed) return;
      repositories = [];
      failure = error instanceof LoadError ? error.message : GENERIC;
    } finally {
      shared.leave();
      leave = null;
      if (!destroyed) {
        active = -1;
        loading = false;
      }
    }
  }

  onDestroy(() => {
    destroyed = true;
    leave?.();
  });

  function close() {
    open = false;
    active = -1;
  }

  /** Move focus back to the field without triggering another load. */
  function focusInput() {
    if (!input || document.activeElement === input) return;
    restoringFocus = true;
    input.focus();
    restoringFocus = false;
  }

  async function retry() {
    if (loading) return;
    retrying = true;
    await load();
    retrying = false;
    // Keyboard users pressed the control that is about to change; give the field back.
    if (container?.contains(document.activeElement)) focusInput();
  }

  function retryKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    focusInput();
    close();
  }

  function select(repo: Repository) {
    value = repo.fullName;
    onchange();
    onselect(repo.fullName);
    close();
  }

  async function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { open = true; void load(); }
      if (!shown.length) { active = -1; return; }
      active = Math.max(0, Math.min(shown.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      await tick();
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open && active >= 0 && shown[active]) {
      event.preventDefault();
      select(shown[active]);
    }
  }
</script>

<div class="repository-input" bind:this={container} onfocusout={(event) => {
  if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
}}>
  <input bind:this={input} class="compose-input" role="combobox" aria-label={label}
    aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
    aria-activedescendant={open && active >= 0 && shown[active] ? `${id}-${active}` : undefined}
    autocomplete="off" placeholder="search repos or paste a git URL" bind:value
    onfocus={() => { open = true; if (!restoringFocus) void load(); }}
    oninput={() => { active = -1; open = true; onchange(); }} onkeydown={keydown} />
  {#if open}
    <div class="suggestions">
      <div class="silk caption">your github repositories</div>
      <div role="status" class="caption">
        {#if loading}loading repositories…
        {:else if failure}{failure}
        {:else if disconnected}connect github to browse repositories
        {:else if !matches.length}no matching repositories — enter owner/name or paste a git URL
        {:else}<span class="sr-only">{matches.length} repositories{hidden ? `, showing ${shown.length}` : ""}</span>{/if}
      </div>
      {#if failure || retrying}
        <button type="button" class="text-action" aria-disabled={loading}
          onmousedown={(event) => event.preventDefault()} onclick={retry} onkeydown={retryKeydown}>retry</button>
      {/if}
      {#if disconnected}<a class="text-action" href={loginHref}>connect github</a>{/if}
      <div id={`${id}-list`} role="listbox" aria-label="github repositories" class="results">
        {#each shown as repo, i (repo.fullName)}
          <button type="button" role="option" id={`${id}-${i}`} tabindex="-1"
            aria-selected={active === i} class:active={active === i}
            onmousedown={(event) => event.preventDefault()} onclick={() => select(repo)}>
            <span class="repo-name">{repo.fullName}</span>
            {#if repo.private}<small>private</small>{/if}
          </button>
        {/each}
      </div>
      {#if hidden}
        <div class="caption footer">type to narrow — {hidden} more</div>
      {:else if shown.length}
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
  .text-action[aria-disabled="true"] { opacity: 0.45; cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  @media (max-width: 40rem) { input { font-size: 16px; } .suggestions { width: 100%; max-width: 100%; } }
</style>
