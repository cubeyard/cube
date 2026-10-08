<script lang="ts">
  import { onMount } from "svelte";
  import { CHAT_BASE, errorText, fetchChatModels, fetchChatView, setChatModel } from "../lib/api.ts";
  import { providerLabel } from "../lib/agent.ts";
  import type { ThreadModels } from "../lib/types.ts";
  import Conversation from "./Conversation.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import ChatThreads from "./ChatThreads.svelte";

  // OptChat: the one endless chat. It starts threads and talks to them; the
  // memory panel shows the view it reads at the start of every turn.
  let modelState = $state<ThreadModels | null>(null);
  let modelError = $state<string | null>(null);
  let changingModel = $state(false);
  let busy = $state(false);
  let memory = $state<{ view: string; messages: number; failure: string | null } | null>(null);
  let memoryOpen = $state(false);
  // On a phone the model and memory keys fold behind the strip's details
  // key; they fold again when the composer takes focus.
  let detailsOpen = $state(false);
  let detailsKey = $state<HTMLButtonElement>();
  // Only where the key shows: there the memory's own toggle folds away with
  // the details, so the memory folds too rather than stay open without it.
  function onPaneFocusin(event: FocusEvent): void {
    if (!(event.target as Element).closest(".composer") || !detailsKey?.getClientRects().length) return;
    detailsOpen = false;
    memoryOpen = false;
  }
  let memoryError = $state<string | null>(null);
  let disposed = false;
  const modelKey = $derived(modelState?.selected ? JSON.stringify(modelState.selected) : "");
  const selectedModel = $derived(modelState?.models.find((model) =>
    model.provider === modelState?.selected?.provider && model.id === modelState?.selected?.id) ?? null);
  const providers = $derived([...new Set(modelState?.models.map((model) => model.provider) ?? [])]);

  async function loadModels(): Promise<void> {
    modelError = null;
    try {
      const fresh = await fetchChatModels();
      if (!disposed) modelState = fresh;
    } catch (cause) {
      if (!disposed) modelError = errorText(cause);
    }
  }

  async function changeModel(event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const selected = modelState?.models.find((model) => JSON.stringify(model) === select.value);
    if (!selected || busy || changingModel) return;
    changingModel = true;
    modelError = null;
    try {
      const fresh = await setChatModel(selected);
      if (!disposed) modelState = fresh;
    } catch (cause) {
      if (!disposed) modelError = errorText(cause);
    } finally {
      if (!disposed) {
        select.value = modelKey;
        changingModel = false;
      }
    }
  }

  async function loadMemory(): Promise<void> {
    memoryError = null;
    try {
      const fresh = await fetchChatView();
      if (!disposed) memory = fresh;
    } catch (cause) {
      if (!disposed) memoryError = errorText(cause);
    }
  }

  function toggleMemory(): void {
    memoryOpen = !memoryOpen;
    if (memoryOpen) void loadMemory();
  }

  onMount(() => {
    void loadModels();
    // Retry until the chat opens (it needs a connected model first). While
    // a message waits or runs, the memory says whether the compactor is stuck.
    const timer = setInterval(() => {
      if (!modelState) void loadModels();
      else if (busy || memoryOpen || memory?.failure) void loadMemory();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });
</script>

<Header section="chat" />
{#if modelError}
  <div class="strip-note bad" role="alert">
    <span class="strip-note-text">{modelError}</span>
    <a class="key" href="#/models">providers</a>
    <button class="key" onclick={loadModels}>retry</button>
  </div>
{/if}
{#if memory?.failure}
  <div class="strip-note bad" role="alert"><span class="strip-note-text">{memory.failure} — retrying</span></div>
{/if}
<main class="thread-workspace chat-workspace">
  <section class="workspace-pane thread-pane" aria-label="chat" onfocusin={onPaneFocusin}>
    <section class="thread-strip" class:details-open={detailsOpen} aria-label="chat controls">
      <span class="lamp {busy ? 'on-amber blink' : 'on-green'}" aria-hidden="true"></span>
      <span class="strip-title chat-title">optchat</span>
      <button class="strip-toggle strip-details-key" bind:this={detailsKey} aria-expanded={detailsOpen} onclick={() => (detailsOpen = !detailsOpen)}>
        details<Icon name="chevron" size={12} />
      </button>
      <span class="strip-state chat-tagline">starts threads · remembers everything</span>
      <span class="spacer"></span>
      <label class="strip-model" title={modelState?.selected ? `${modelState.selected.provider}/${modelState.selected.id}` : "choose a model"}>
        <span class="sr-only">model</span>
        <select aria-label="model" value={modelKey} onchange={changeModel} disabled={!modelState || busy || changingModel || !modelState.models.length}>
          {#if !modelState}
            <option value="">loading models…</option>
          {:else if !modelState.selected}
            <option value="">no models available</option>
          {:else if !selectedModel}
            <option value={modelKey}>{modelState.selected.id} · unavailable</option>
          {/if}
          {#each providers as provider}
            <optgroup label={providerLabel(provider)}>
              {#each modelState?.models.filter((model) => model.provider === provider) ?? [] as model}
                <option value={JSON.stringify(model)}>{model.id}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <Icon name="chevron" size={12} />
      </label>
      <button class="strip-toggle" aria-expanded={memoryOpen} aria-controls="chat-memory" onclick={toggleMemory}>memory<Icon name="chevron" size={12} /></button>
    </section>
    {#if memoryOpen}
      <section id="chat-memory" class="chat-memory" aria-label="memory">
        <div class="chat-memory-head">
          <span>{memory ? `${memory.messages} messages · ${memory.view.split("\n").length - 2} lines` : "reading memory…"}</span>
          <button class="key" onclick={loadMemory}>refresh</button>
        </div>
        {#if memoryError}<p class="chat-memory-error" role="alert">{memoryError}</p>{/if}
        {#if memory}<pre>{memory.view}</pre>{/if}
      </section>
    {/if}
    {#if modelState}
      <Conversation base={CHAT_BASE} steer model={selectedModel} {changingModel} bind:busy
        images={modelState.images ?? { supported: false, reason: "this host does not take images in the chat" }}
        placeholder="message optchat"
        empty={{ title: "one chat, every thread", hint: "Say what you want done: the chat starts threads in your projects, follows their reports and remembers everything you said. A thread needs a project; add one under projects." }} />
    {:else}
      <p class="conversation-empty">{modelError ? "connect a model provider to start the chat" : "opening the chat…"}</p>
    {/if}
  </section>
  {#if modelState}<ChatThreads {busy} />{/if}
</main>
