<script lang="ts">
  import { onMount } from "svelte";
  import Header from "./Header.svelte";
  import { errorText, fetchJevStatus, fetchProviders, providerAction, removeJevKey, saveJevKey } from "../lib/api.ts";

  let providers = $state<Awaited<ReturnType<typeof fetchProviders>>>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let search = $state("");
  let answers = $state<Record<string, string>>({});
  let jev = $state<{ configured: boolean } | null>(null);
  let jevKey = $state("");
  let jevBusy = $state(false);
  let jevError = $state<string | null>(null);
  let disposed = false;
  let polling = false;
  const visible = $derived(providers.filter(provider => `${provider.name} ${provider.id}`.toLowerCase().includes(search.toLowerCase())));
  function link(url: string): string | undefined {
    try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? url : undefined; } catch { return undefined; }
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    try { const next = await fetchProviders(); if (!disposed) { providers = next; loaded = true; } }
    catch { if (!disposed) error = "could not check providers — retry"; }
    finally { polling = false; }
  }
  async function refreshJev() {
    try { const next = await fetchJevStatus(); if (!disposed) jev = next; }
    catch { if (!disposed) jevError = "could not check jev memory — retry"; }
  }
  async function saveJev() {
    jevBusy = true; jevError = null;
    try { jev = await saveJevKey(jevKey); jevKey = ""; }
    catch (cause) { jevError = errorText(cause); }
    finally { jevBusy = false; }
  }
  async function disableJev() {
    jevBusy = true; jevError = null;
    try { jev = await removeJevKey(); jevKey = ""; }
    catch (cause) { jevError = errorText(cause); }
    finally { jevBusy = false; }
  }
  async function action(id: string, operation: "login" | "answer" | "cancel" | "disconnect" | "refresh", body?: unknown) {
    busy = id; error = null;
    try { await providerAction(id, operation, body); await refresh(); }
    catch (cause) { if (!disposed) error = errorText(cause); }
    finally { if (!disposed) busy = null; }
  }
  function submit(id: string, flowId: string, promptId: string) {
    const value = answers[id] ?? "";
    answers[id] = "";
    void action(id, "answer", { flowId, promptId, value });
  }
  onMount(() => {
    void refresh(); void refreshJev();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { disposed = true; clearInterval(timer); answers = {}; };
  });
</script>

<Header section="models" />
<main class="provider-settings">
  <div class="intro">
    <h1>model providers</h1>
  </div>
  <section class="jev" aria-labelledby="jev-title">
    <div class="jev-head">
      <span class:blink={jevBusy} class:on-amber={jevBusy} class:on-green={jev?.configured && !jevBusy} class="lamp"></span>
      <div>
        <h2 id="jev-title">jev memory</h2>
        <p class="jev-status">{jev === null ? "checking configuration…" : jev.configured ? "configured · memory is active" : "not configured · memory is off"}</p>
      </div>
    </div>
    <p>let jev retain useful thread context and choose compact views of large tool output. selected prompts, responses, and tool excerpts are sent to typesafe ai.</p>
    <p class="hint">optional. the key stays on this host, never reaches a runner or the browser again, and no jev requests are made while it is missing.</p>
    <form class="jev-form" onsubmit={event => { event.preventDefault(); void saveJev(); }}>
      <label for="jev-key">jev api key</label>
      <div class="jev-controls">
        <input id="jev-key" type="password" bind:value={jevKey} placeholder={jev?.configured ? "enter a replacement key" : "enter your jev key"} autocomplete="off" spellcheck="false" required />
        <button class="key" type="submit" disabled={jevBusy || !jevKey.trim()}>{jev?.configured ? "replace key" : "enable memory"}</button>
        {#if jev?.configured}<button class="key danger" type="button" disabled={jevBusy} onclick={() => void disableJev()}>turn off memory</button>{/if}
      </div>
    </form>
    {#if jevError}<p class="error" role="alert">{jevError} <button class="key" onclick={() => { jevError = null; void refreshJev(); }}>retry</button></p>{/if}
  </section>
  <div class="intro providers-intro">
    <p>connect a provider to choose its models in your threads. credentials stay on this host and are managed by pi.</p>
    <p class="hint">disconnect removes the saved login, not credentials supplied by the host environment. it does not change a thread's selected model.</p>
  </div>
  <label class="search">find a provider <input type="search" bind:value={search} placeholder="provider name" /></label>
  {#if error}<p class="error" role="alert">{error} <button class="key" onclick={() => { error = null; void refresh(); }}>retry</button></p>{/if}
  {#if !loaded}<p role="status">checking providers…</p>
  {:else if !visible.length}<p>no matching providers</p>{/if}
  <div class="providers">
    {#each visible as provider (provider.id)}
      <section class="provider" aria-label={provider.name}>
        <div class="provider-row">
          <div class="provider-title">
            <span class:blink={provider.flow?.state === "pending"} class:on-amber={provider.flow?.state === "pending"} class:on-green={provider.connected && provider.flow?.state !== "pending"} class="lamp"></span>
            <div><h2>{provider.name}</h2><span class="hint">{provider.checkError ? "status unavailable" : provider.connected ? `connected · ${provider.type === "oauth" ? "oauth" : "api key / host credentials"}` : "not connected"}</span></div>
          </div>
          <div class="actions">
            {#if provider.flow?.state === "pending"}
              <button class="key" disabled={busy === provider.id} onclick={() => void action(provider.id, "cancel")}>cancel login</button>
            {:else}
              {#each provider.methods as method}
                <button class="key" disabled={busy === provider.id} onclick={() => { answers[provider.id] = ""; void action(provider.id, "login", { type: method.type }); }}>{method.label}</button>
              {/each}
              {#if provider.connected}
                <button class="key" disabled={busy === provider.id} onclick={() => void action(provider.id, "refresh")}>refresh models</button>
                <button class="key" disabled={busy === provider.id} onclick={() => void action(provider.id, "disconnect")}>disconnect</button>
              {/if}
            {/if}
          </div>
        </div>
        {#if !provider.methods.length}<p class="hint">this provider requires host configuration; pi does not offer an interactive login.</p>{/if}
        {#if provider.flow?.error}<p class="error" role="alert">{provider.flow.error}</p>{/if}
        {#if provider.flow?.state === "cancelled"}<p class="hint" role="status">login cancelled</p>{/if}
        {#if provider.flow?.state === "pending"}
          <div class="login" aria-live="polite">
            {#each provider.flow.events as event}
              {#if event.type === "auth_url"}
                <p><a href={link(event.url)} target="_blank" rel="noreferrer">open provider login</a></p>
                {#if event.instructions}<p>{event.instructions}</p>{/if}
              {:else if event.type === "device_code"}
                <p>enter this code at <a href={link(event.verificationUri)} target="_blank" rel="noreferrer">provider login</a></p>
                <code class="device-code">{event.userCode}</code>
                {#if event.expiresInSeconds}<p class="hint">code expires after {Math.ceil(event.expiresInSeconds / 60)} minutes</p>{/if}
              {:else}
                <p>{event.message}</p>
                {#if event.type === "info"}{#each event.links ?? [] as item}<a href={link(item.url)} target="_blank" rel="noreferrer">{item.label ?? "provider help"}</a>{/each}{/if}
              {/if}
            {/each}
            {#if provider.flow.prompt}
              {@const prompt = provider.flow.prompt}
              {#key prompt.id}
                <form onsubmit={event => { event.preventDefault(); submit(provider.id, provider.flow!.id, prompt.id); }}>
                  <label for={`login-${prompt.id}`}>{prompt.message}</label>
                  {#if prompt.type === "select"}
                    <select id={`login-${prompt.id}`} bind:value={answers[provider.id]} required>
                      <option value="">choose a method</option>
                      {#each prompt.options ?? [] as option}<option value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>{/each}
                    </select>
                  {:else}
                    <input id={`login-${prompt.id}`} type={prompt.type === "secret" || prompt.type === "manual_code" ? "password" : "text"} bind:value={answers[provider.id]} placeholder={prompt.placeholder} autocomplete="off" spellcheck="false" />
                  {/if}
                  {#if prompt.type === "manual_code"}<p class="hint">if the browser cannot reach the callback on this host, paste the final redirect url or code here.</p>{/if}
                  <button class="key primary" disabled={busy === provider.id} type="submit">continue</button>
                </form>
              {/key}
            {:else}<p class="hint" role="status">waiting for provider…</p>{/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</main>

<style>
  .provider-settings { overflow-y: auto; padding: 2rem clamp(1rem, 4vw, 4rem); }
  .intro { max-width: 65ch; margin-bottom: 1.5rem; }
  h1 { margin: 0 0 0.8rem; }
  h2 { font-size: 15px; margin: 0 0 0.25rem; }
  p { line-height: 1.6; overflow-wrap: anywhere; }
  .hint { color: var(--ink-3); font-size: 13px; }
  .search { display: grid; gap: 0.5rem; max-width: 28rem; margin-bottom: 1.5rem; }
  .jev { max-width: 52rem; margin: 0 0 2.1rem; padding: 1rem; background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-well); box-shadow: var(--shadow-well); }
  .jev-head { display: flex; align-items: center; gap: 0.75rem; }
  .jev-head h2 { margin-bottom: 0.1rem; }
  .jev-status { margin: 0; color: var(--ink-3); font-size: 13px; }
  .jev > p { max-width: 68ch; margin: 0.65rem 0 0; }
  .jev-form { margin-top: 1rem; }
  .jev-controls { display: grid; grid-template-columns: minmax(14rem, 1fr) auto auto; gap: 0.55rem; align-items: center; }
  .providers-intro { padding-top: 1.4rem; border-top: 1px solid var(--line-2); }
  input, select { padding: 0.65rem; min-width: 0; width: 100%; background: var(--s4); color: var(--ink); border: 1px solid var(--line-2); border-radius: var(--r-key); font: inherit; }
  .providers { border-top: 1px solid var(--line-2); }
  .provider { padding: 1.25rem 0; border-bottom: 1px solid var(--line-2); }
  .provider-row, .provider-title, .actions { display: flex; gap: 0.75rem; align-items: center; }
  .provider-row { justify-content: space-between; flex-wrap: wrap; }
  .provider-title { min-width: 0; overflow-wrap: anywhere; }
  .actions { flex-wrap: wrap; }
  .login { margin-top: 1rem; padding: 1rem; background: var(--s1); max-width: 42rem; }
  form { display: grid; gap: 0.75rem; }
  form .key { justify-self: start; }
  .device-code { font: 600 24px var(--font-mono); user-select: all; }
  .error { color: var(--bad); }
  a { color: var(--ink); text-underline-offset: 3px; }
  @media (max-width: 40rem) {
    input, select { font-size: 16px; }
    .provider-row { align-items: start; }
    .jev { padding: 0.85rem; }
    .jev-controls { grid-template-columns: 1fr; }
    .jev-controls .key { justify-self: start; }
  }
</style>
