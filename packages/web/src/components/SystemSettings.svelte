<script lang="ts">
  import { onMount } from "svelte";
  import Header from "./Header.svelte";
  import { checkForUpdate, errorText, fetchUpdateStatus, installUpdate } from "../lib/api.ts";
  import type { UpdateStatus } from "../lib/types.ts";
  import { uid } from "../lib/uid.ts";

  const busyPhases = new Set(["checking", "downloading", "verifying", "staging", "draining", "restarting", "probation"]);
  let status = $state<UpdateStatus | null>(null);
  let error = $state<string | null>(null);
  let disposed = false;
  let requestId: string | null = null;
  const busy = $derived(status ? busyPhases.has(status.phase) : false);
  const lamp = $derived(status?.error ? "red" : busy ? "amber" : status?.installation === "managed" ? "green" : "off");

  async function refresh() {
    try {
      const next = await fetchUpdateStatus();
      if (!disposed) { status = next; error = null; }
    } catch (cause) {
      if (!disposed && !status) error = errorText(cause);
    }
  }

  async function check() {
    error = null;
    try { status = await checkForUpdate(); }
    catch (cause) { error = errorText(cause); }
  }

  async function install() {
    if (!status?.available) return;
    const target = status.available.version;
    if (!confirm(`install cubed ${target}? cube will be briefly unavailable. runners will not be updated.`)) return;
    requestId ??= uid();
    error = null;
    try { status = await installUpdate(target, status.current.version, requestId); requestId = null; }
    catch (cause) { error = errorText(cause); }
  }

  function bytes(value: number): string {
    if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} kb`;
    return `${(value / (1024 * 1024)).toFixed(1)} mb`;
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

<Header section="system" />
<main class="system-settings">
  <div class="intro">
    <h1>system</h1>
    <p>inspect and update the cubed control plane on this host. runner software is separate and is never changed here.</p>
  </div>

  {#if error}<p class="error" role="alert">{error} <button class="key" onclick={() => void refresh()}>retry</button></p>{/if}
  {#if !status}
    <p role="status">reading installation…</p>
  {:else}
    <section class="update-board" aria-labelledby="update-title">
      <div class="board-head">
        <span class="lamp" class:on-green={lamp === "green"} class:on-amber={lamp === "amber"} class:blink={lamp === "amber"} class:on-red={lamp === "red"}></span>
        <div>
          <h2 id="update-title">cubed software</h2>
          <p class="status-line" aria-live="polite">{status.message ?? status.phase}</p>
        </div>
      </div>

      <dl class="readout">
        <div><dt>installed</dt><dd>{status.current.version}</dd></div>
        <div><dt>commit</dt><dd>{status.current.commit.slice(0, 12)}</dd></div>
        <div><dt>state schema</dt><dd>{status.current.stateSchema}</dd></div>
        <div><dt>installation</dt><dd>{status.installation}</dd></div>
      </dl>

      {#if status.available}
        <div class="candidate">
          <div>
            <h3>{status.available.version}</h3>
            <p>{bytes(status.available.bytes)} · commit {status.available.commit.slice(0, 12)}</p>
            {#if status.available.publishedAt}
              <p>published <time datetime={status.available.publishedAt}>{new Date(status.available.publishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></p>
            {/if}
          </div>
          {#if status.available.notesUrl}<a href={status.available.notesUrl} target="_blank" rel="noreferrer">release notes</a>{/if}
        </div>
      {/if}

      {#if status.error}<p class="error notice" role="alert">{status.error}</p>{/if}
      <p class="boundary">updates preserve host state and credentials. only releases declaring rollback-safe compatibility with state schema {status.current.stateSchema} are accepted. runners are not updated.</p>

      <div class="actions">
        <button class="key" disabled={!status.enabled || busy} onclick={() => void check()}>check for updates</button>
        {#if status.available}
          <button class="key primary" disabled={!status.enabled || busy} onclick={() => void install()}>install {status.available.version}</button>
        {/if}
      </div>
    </section>
  {/if}
</main>

<style>
  .system-settings { overflow-y: auto; padding: 2rem clamp(1rem, 4vw, 4rem); }
  .intro { max-width: 65ch; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 0.8rem; }
  h2, h3, p { margin: 0; }
  .intro p, .boundary { line-height: 1.6; color: var(--ink-2); }
  .update-board { max-width: 52rem; padding: 1rem; background: var(--s1); border-radius: var(--r-well); box-shadow: var(--shadow-well); }
  .board-head { display: flex; align-items: center; gap: 0.75rem; }
  .board-head h2 { font-size: 15px; }
  .status-line { color: var(--ink-3); font-size: 13px; overflow-wrap: anywhere; }
  .readout { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 1rem 0 0; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
  .readout div { min-width: 0; padding: 0.75rem; border-right: 1px solid var(--line); }
  .readout div:last-child { border-right: 0; }
  dt { color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  dd { margin: 0.2rem 0 0; font: 12.5px var(--font-mono); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .candidate { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.85rem 0.75rem; background: var(--s3); border-bottom: 1px solid var(--line); }
  .candidate h3 { font-size: 14.5px; }
  .candidate p { color: var(--ink-3); font: 11px var(--font-mono); }
  .candidate a { color: var(--ink); text-underline-offset: 3px; white-space: nowrap; }
  .boundary { max-width: 68ch; margin-top: 1rem; font-size: 13px; }
  .notice { padding: 0.65rem 0.75rem; margin-top: 1rem; background: var(--bad-soft); border: 1px solid var(--bad-line); border-radius: var(--r-key); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.55rem; margin-top: 1rem; }
  .error { color: var(--bad); overflow-wrap: anywhere; }
  @media (max-width: 40rem) {
    .system-settings { padding: 1.4rem 1rem; }
    .update-board { padding: 0.85rem; }
    .readout { grid-template-columns: 1fr 1fr; }
    .readout div:nth-child(2) { border-right: 0; }
    .readout div:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
    .candidate { align-items: flex-start; flex-direction: column; }
  }
</style>
