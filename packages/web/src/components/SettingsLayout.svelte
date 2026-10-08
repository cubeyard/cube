<script lang="ts" module>
  export type SettingsPage = "providers" | "memory" | "system";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Header from "./Header.svelte";

  let { page, children }: { page: SettingsPage; children: Snippet } = $props();

  // One bank of selectors for the host's settings; the page beside it scrolls on its own.
  const pages: Array<{ id: SettingsPage; name: string; short: string; hint: string }> = [
    { id: "providers", name: "model providers", short: "providers", hint: "logins for the models cube runs" },
    { id: "memory", name: "chat memory", short: "chat memory", hint: "the model that summarizes the chat" },
    { id: "system", name: "system", short: "system", hint: "cubed updates and usage" },
  ];
</script>

<Header section="settings" />
<main class="settings-shell">
  <nav class="settings-rail" aria-label="settings">
    {#each pages as item (item.id)}
      <a href={`#/settings/${item.id}`} class="rail-item" aria-label={item.name} aria-current={item.id === page ? "page" : undefined}>
        <span class="rail-name"><span class="rail-long">{item.name}</span><span class="rail-short" aria-hidden="true">{item.short}</span></span>
        <span class="rail-hint">{item.hint}</span>
      </a>
    {/each}
  </nav>
  <div class="settings-pane">
    {@render children()}
  </div>
</main>

<style>
  .settings-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 15.5rem minmax(0, 1fr); }
  /* the selector bank: a recessed well, the open page's key standing proud in it */
  .settings-rail {
    align-self: start; display: flex; flex-direction: column; gap: 2px;
    margin: 2rem 0 2rem clamp(1rem, 2.4vw, 2rem); padding: 0.35rem;
    background: var(--s1); border-radius: var(--r-well); box-shadow: var(--shadow-well);
  }
  .rail-item {
    display: flex; flex-direction: column; gap: 0.12rem; padding: 0.6rem 0.75rem;
    color: var(--ink-2); text-decoration: none; border: 1px solid transparent;
    border-radius: calc(var(--r-well) - 5px);
    transition: background-color 120ms ease, color 120ms ease;
  }
  .rail-item:hover { background: color-mix(in srgb, var(--s3) 55%, transparent); color: var(--ink); }
  .rail-item[aria-current="page"] { background: var(--s3); color: var(--ink); border-color: var(--line); box-shadow: var(--shadow-key); }
  .rail-name { font-size: 13px; font-weight: 550; letter-spacing: 0.01em; }
  .rail-short { display: none; }
  .rail-hint { font-size: 11px; font-weight: 450; color: var(--ink-3); line-height: 1.4; }
  .rail-item[aria-current="page"]:hover { background: var(--s4); }
  .settings-pane { min-width: 0; overflow-y: auto; padding: 2rem clamp(1rem, 4vw, 4rem) 3rem clamp(1rem, 3vw, 2.6rem); }
  /* every page's title on the instrument's headline scale (DESIGN.md) */
  .settings-pane :global(h1) { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; margin: 0.35rem 0 0.8rem; }
  @media (max-width: 40rem) {
    .settings-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    /* on a phone the bank lies flat above the page: three keys in a row */
    .settings-rail { flex-direction: row; margin: 0.8rem 0.8rem 0; }
    .rail-item { flex: 1 1 0; min-width: 0; align-items: center; padding: 0.55rem 0.4rem; min-height: 2.5rem; justify-content: center; }
    .rail-long, .rail-hint { display: none; }
    .rail-short { display: inline; white-space: nowrap; }
    .settings-pane { padding: 1.3rem 1rem 2.5rem; }
  }
</style>
