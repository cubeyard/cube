<script lang="ts">
  import { onMount } from "svelte";
  import Header from "./Header.svelte";
  import { errorText, fetchSettings, setCompactor } from "../lib/api.ts";
  import type { ModelSelection, SettingsView } from "../lib/types.ts";

  // The select's value for "follow the chat's model".
  const FOLLOW = "";
  let settings = $state<SettingsView | null>(null);
  let error = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let saving = $state(false);
  let choice = $state(FOLLOW);
  // The choice the select was last set from; a refresh leaves an unsaved edit alone.
  let shown = FOLLOW;
  let disposed = false;

  const key = (model: ModelSelection | null) => (model ? JSON.stringify({ provider: model.provider, id: model.id }) : FOLLOW);
  // A variable that cannot be used keeps the chat from opening at all.
  const name = (model: ModelSelection | null) => (model ? `${model.provider}/${model.id}`
    : settings?.compactor.environment?.error ? "unavailable" : "the chat is not open yet");
  const providers = $derived([...new Set(settings?.models?.map((model) => model.provider) ?? [])]);
  const saved = $derived(settings?.compactor.saved ?? null);
  // Not listed is not missing: a saved model is only marked when the list says so.
  const savedMissing = $derived(saved !== null && !!settings?.models && !settings.models.some((model) => key(model) === key(saved)));
  const changed = $derived(settings !== null && choice !== key(saved));

  function apply(next: SettingsView) {
    const savedKey = key(next.compactor.saved);
    if (choice === shown) choice = savedKey;
    shown = savedKey;
    settings = next;
  }

  async function refresh() {
    try {
      const next = await fetchSettings();
      if (!disposed) { apply(next); error = null; }
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    }
  }

  async function save() {
    if (!settings || saving) return;
    const model = choice === FOLLOW ? null : settings.models?.find((candidate) => key(candidate) === choice) ?? null;
    if (choice !== FOLLOW && !model) { saveError = settings.models ? "that model is no longer available" : "the models could not be listed; try again"; return; }
    saving = true;
    saveError = null;
    try {
      const next = await setCompactor(model);
      if (!disposed) { choice = key(next.compactor.saved); apply(next); }
    } catch (cause) {
      if (!disposed) saveError = errorText(cause);
    } finally {
      if (!disposed) saving = false;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  });
</script>

<Header section="settings" />
<main class="settings-page">
  <div class="intro">
    <h1>settings</h1>
    <p>choices for this whole cube host, kept with its state. a thread's own model is chosen when it starts.</p>
  </div>

  {#if error}<p class="error" role="alert">{error} <button class="key" onclick={() => void refresh()}>retry</button></p>{/if}
  {#if !settings}
    {#if !error}<p role="status">reading settings…</p>{/if}
  {:else}
    <section class="settings-board" aria-labelledby="compactor-title">
      <h2 id="compactor-title">chat memory model</h2>
      <p class="explain">optchat keeps the whole chat by folding older messages into short summary lines. the <strong>compactor</strong> writes those lines; it is not the model you talk to. the <strong>chat model</strong> is chosen on the chat strip.</p>

      <dl class="readout">
        <div><dt>chat model</dt><dd class="value chat-model">{name(settings.chat)}</dd></div>
        <div>
          <dt>compactor in use</dt>
          <dd class="value compactor-model">{name(settings.compactor.model)}</dd>
          <dd class="source">{settings.compactor.source === "environment" ? "from CUBED_OPTCHAT_COMPACTOR" : settings.compactor.source === "saved" ? "saved here" : "follows the chat model"}</dd>
        </div>
      </dl>

      {#if settings.error}<p class="notice" role="alert">{settings.error}</p>{/if}
      {#if settings.compactor.environment}
        <p class="notice override compactor-override">
          cubed was started with <code>CUBED_OPTCHAT_COMPACTOR={settings.compactor.environment.value}</code>, which wins over the choice saved here.
          {#if settings.compactor.environment.error}it cannot be used ({settings.compactor.environment.error}), so the chat is unavailable until it is fixed.{/if}
          a choice saved here applies once that variable is removed and cubed restarts; this page does not change the host's environment.
        </p>
      {/if}
      {#if settings.compactor.unavailable}
        <p class="notice compactor-unavailable" role="status">the saved {name(settings.compactor.unavailable)} is not offered by a connected provider now, so the compactor uses the chat model. connect its provider under <a href="#/models">models</a>, or choose again.</p>
      {/if}

      <form class="choose" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <label class="field">
          <span>compactor</span>
          <select bind:value={choice} disabled={saving}>
            <option value={FOLLOW}>follow the chat model</option>
            {#if savedMissing && saved}<option value={key(saved)}>{saved.provider}/{saved.id} · unavailable</option>
            {:else if saved && !settings.models}<option value={key(saved)}>{saved.provider}/{saved.id}</option>{/if}
            {#each providers as provider}
              <optgroup label={provider}>
                {#each settings.models?.filter((model) => model.provider === provider) ?? [] as model}
                  <option value={key(model)}>{model.id}</option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>
        <button class="key primary" type="submit" disabled={!changed || saving}>{saving ? "saving…" : "save"}</button>
      </form>
      {#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
      {#if settings.models && !settings.models.length}<p class="hint">no models are available; connect a provider under <a href="#/models">models</a>.</p>{/if}
      <p class="hint">a cheap, competent model is enough. a saved choice applies to the next summary line; a line being written finishes with the model it started with.</p>
    </section>
  {/if}
</main>

<style>
  .settings-page { overflow-y: auto; padding: 2rem clamp(1rem, 4vw, 4rem); }
  .intro { max-width: 65ch; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 0.8rem; }
  h2, p { margin: 0; }
  .intro p, .explain, .hint { line-height: 1.6; color: var(--ink-2); }
  .settings-board { max-width: 52rem; padding: 1rem; background: var(--s1); border-radius: var(--r-well); box-shadow: var(--shadow-well); }
  h2 { font-size: 15px; margin-bottom: 0.5rem; }
  .explain { max-width: 68ch; font-size: 13.5px; }
  .explain strong { color: var(--ink); font-weight: 600; }
  .readout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 1rem 0 0; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
  .readout div { min-width: 0; padding: 0.75rem; border-right: 1px solid var(--line); }
  .readout div:last-child { border-right: 0; }
  dt { color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  dd { margin: 0.2rem 0 0; font: 12.5px var(--font-mono); overflow-wrap: anywhere; }
  dd.source { color: var(--ink-3); font: 11.5px var(--font-ui); }
  .notice { max-width: 68ch; padding: 0.65rem 0.75rem; margin-top: 1rem; line-height: 1.55; font-size: 13px; background: var(--s3); border: 1px solid var(--line-2); border-radius: var(--r-key); overflow-wrap: anywhere; }
  .notice.override { border-color: var(--signal); }
  .notice a, .hint a { color: var(--ink); text-underline-offset: 3px; }
  code { font: 12px var(--font-mono); overflow-wrap: anywhere; }
  .choose { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem; margin-top: 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; min-width: min(100%, 20rem); color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  .field select {
    appearance: none; color: var(--ink); background: var(--s3);
    border: 1px solid var(--line); border-radius: var(--r-xs);
    font: 550 13px/1.4 var(--font-ui); padding: 0.45rem 1.8rem 0.45rem 0.6rem; letter-spacing: 0;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--ink-3) 50%),
      linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
    background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%;
    background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
  }
  .field select option, .field select optgroup { background: var(--s2); color: var(--ink); }
  .hint { max-width: 68ch; margin-top: 1rem; font-size: 13px; }
  .error { color: var(--bad); overflow-wrap: anywhere; margin-top: 0.75rem; }
  @media (max-width: 40rem) {
    .settings-page { padding: 1.4rem 1rem; }
    .settings-board { padding: 0.85rem; }
    .readout { grid-template-columns: 1fr; }
    .readout div { border-right: 0; }
    .readout div + div { border-top: 1px solid var(--line); }
    .choose { flex-direction: column; align-items: stretch; }
    .field { min-width: 0; }
    .choose .key { min-height: 2.5rem; }
  }
</style>
