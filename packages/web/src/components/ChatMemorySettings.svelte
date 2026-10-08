<script lang="ts">
  import { onMount } from "svelte";
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
  const name = (model: ModelSelection | null) => (model ? `${model.provider}/${model.id}` : "the chat is not open yet");
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

<section class="memory-settings" aria-labelledby="memory-title">
  <div class="intro">
    <h1 id="memory-title">chat memory</h1>
    <p>optchat keeps the whole chat by folding older messages into short summary lines. the <strong>compactor</strong> writes those lines; it is not the model you talk to, which is chosen on the chat strip.</p>
  </div>

  {#if error}<p class="error" role="alert">{error} <button class="key" onclick={() => void refresh()}>retry</button></p>{/if}
  {#if !settings}
    {#if !error}<p role="status">reading settings…</p>{/if}
  {:else}
    <div class="settings-board">
      <dl class="readout">
        <div><dt>chat model</dt><dd class="value chat-model">{name(settings.chat)}</dd></div>
        <div>
          <dt>compactor in use</dt>
          <dd class="value compactor-model">{name(settings.compactor.model)}</dd>
          <dd class="source">{settings.compactor.source === "saved" ? "chosen here" : "follows the chat model"}</dd>
        </div>
      </dl>

      {#if settings.error}<p class="notice" role="alert">{settings.error}</p>{/if}
      {#if settings.compactor.ignored}
        <p class="notice compactor-ignored" role="status">cubed was started with <code>CUBED_OPTCHAT_COMPACTOR={settings.compactor.ignored}</code>. cube no longer reads it: the choice here decides. remove it from cubed's environment when convenient.</p>
      {/if}
      {#if settings.compactor.unavailable}
        <p class="notice compactor-unavailable" role="status">the saved {name(settings.compactor.unavailable)} is not offered by a connected provider now, so the compactor uses the chat model. connect its provider under <a href="#/settings/providers">model providers</a>, or choose again.</p>
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
      {#if settings.models && !settings.models.length}<p class="hint">no models are available yet; connect a provider under <a href="#/settings/providers">model providers</a>.</p>{/if}
      <p class="hint">following the chat model works with any provider. a cheaper model that still writes well saves cost on a long chat. a choice applies to the next summary line; a line being written finishes with the model it started with.</p>
    </div>
  {/if}
</section>

<style>
  .intro { max-width: 65ch; margin-bottom: 1.5rem; }
  p { margin: 0; }
  .intro p, .hint { line-height: 1.6; color: var(--ink-2); }
  .intro strong { color: var(--ink); font-weight: 600; }
  .settings-board { max-width: 52rem; padding: 1rem; background: var(--s1); border-radius: var(--r-well); box-shadow: var(--shadow-well); }
  .readout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
  .readout div { min-width: 0; padding: 0.75rem; border-right: 1px solid var(--line); }
  .readout div:last-child { border-right: 0; }
  dt { color: var(--ink-3); font-size: 11px; font-weight: 550; letter-spacing: 0.08em; }
  dd { margin: 0.2rem 0 0; font: 12.5px var(--font-mono); overflow-wrap: anywhere; }
  dd.source { color: var(--ink-3); font: 11.5px var(--font-ui); }
  .notice { max-width: 68ch; padding: 0.65rem 0.75rem; margin-top: 1rem; line-height: 1.55; font-size: 13px; color: var(--ink-2); background: var(--note-soft); border: 1px solid var(--note-line); border-radius: var(--r-chip); overflow-wrap: anywhere; }
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
    .settings-board { padding: 0.85rem; }
    .readout { grid-template-columns: 1fr; }
    .readout div { border-right: 0; }
    .readout div + div { border-top: 1px solid var(--line); }
    .choose { flex-direction: column; align-items: stretch; }
    .field { min-width: 0; }
    .field select { font-size: 16px; }
    .choose .key { min-height: 2.5rem; }
  }
</style>
