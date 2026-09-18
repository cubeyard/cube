<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, fetchConversation, fetchJevToolOutput, sendPrompt, stopThread } from "../lib/api.ts";
  import { uid } from "../lib/uid.ts";
  import type { AgentRun, ConversationHistory, ConversationMessage, ModelSelection } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { threadId, model, changingModel = false, busy = $bindable(false), waitingText = null }: {
    threadId: string;
    model: ModelSelection | null;
    changingModel?: boolean;
    busy?: boolean;
    waitingText?: string | null;
  } = $props();
  let messages = $state<ConversationMessage[]>([]);
  let run = $state<AgentRun | null>(null);
  let prompt = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let historyError = $state<string | null>(null);
  let transcript: HTMLElement;
  let composer: HTMLTextAreaElement;
  let disposed = false;
  let sending = $state(false);
  let pending: { text: string; requestId: string } | null = null;
  let toolComparisons = $state<Record<string, { view: "compressed" | "original"; original?: string; loading?: boolean; error?: string }>>({});
  const working = $derived(run?.status === "queued" || run?.status === "running");
  $effect(() => { busy = working || sending; });

  async function show(history: ConversationHistory): Promise<void> {
      if (disposed) return;
      const nearBottom = !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
      messages = history.messages;
      run = history.run;
      historyError = null;
      loading = false;
      if (nearBottom) {
        await tick();
        transcript?.scrollTo({ top: transcript.scrollHeight });
      }
  }

  async function refresh(): Promise<void> {
    try {
      await show(await fetchConversation(threadId));
    } catch (cause) {
      if (!disposed) {
        historyError = errorText(cause);
        loading = false;
      }
    }
  }

  onMount(() => {
    const stream = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/stream`);
    stream.onmessage = event => { void show(JSON.parse(event.data)); };
    stream.onerror = () => { historyError = "connection interrupted — reconnecting…"; };
    return () => {
      disposed = true;
      stream.close();
    };
  });

  function resizeComposer(): void {
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 176)}px`;
  }

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!text || working || sending || changingModel || !model || waitingText) return;
    sending = true;
    error = null;
    try {
      if (pending?.text !== text) pending = { text, requestId: uid() };
      await sendPrompt(threadId, text, model, pending.requestId);
      pending = null;
      prompt = "";
      await tick();
      resizeComposer();
      await refresh();
    } catch (cause) {
      error = errorText(cause);
    } finally {
      sending = false;
      composer?.focus();
    }
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submit();
    }
  }

  function toolName(message: ConversationMessage): string {
    if (!message.payload || typeof message.payload !== "object") return "tool";
    const name = (message.payload as { toolName?: unknown }).toolName;
    return typeof name === "string" ? name : "tool";
  }

  function toolCallId(message: ConversationMessage): string | null {
    if (!message.payload || typeof message.payload !== "object") return null;
    const id = (message.payload as { toolCallId?: unknown }).toolCallId;
    return typeof id === "string" ? id : null;
  }

  function jevMetadata(message: ConversationMessage): { view: string; sentLines: number; totalLines: number } | null {
    if (!message.payload || typeof message.payload !== "object") return null;
    const details = (message.payload as { details?: unknown }).details;
    if (!details || typeof details !== "object") return null;
    const value = (details as { jevMemory?: unknown }).jevMemory;
    if (!value || typeof value !== "object") return null;
    const meta = value as { view?: unknown; sentLines?: unknown; totalLines?: unknown };
    return typeof meta.view === "string" && typeof meta.sentLines === "number" && typeof meta.totalLines === "number"
      ? { view: meta.view, sentLines: meta.sentLines, totalLines: meta.totalLines } : null;
  }

  async function showToolView(message: ConversationMessage, view: "compressed" | "original") {
    const key = String(message.seq);
    if (view === "compressed") { toolComparisons[key] = { ...toolComparisons[key], view }; return; }
    const current = toolComparisons[key];
    if (current?.original) { toolComparisons[key] = { ...current, view }; return; }
    const id = toolCallId(message);
    if (!id) return;
    toolComparisons[key] = { view, loading: true };
    try {
      const comparison = await fetchJevToolOutput(threadId, id);
      toolComparisons[key] = { view, original: comparison.original };
    } catch (cause) {
      toolComparisons[key] = { view, error: errorText(cause) };
    }
  }

  function messageLabel(message: ConversationMessage): string {
    return message.role === "user" ? "you" : "agent";
  }
</script>

<div class="conversation">
  <div class="transcript" bind:this={transcript} aria-live="polite" aria-busy={working}>
    {#if loading}
      <p class="conversation-empty">reading thread…</p>
    {:else if messages.length === 0}
      <div class="conversation-empty">
        <span class="lamp on-green" aria-hidden="true"></span>
        <p>ready when you are</p>
        <span>Ask for a change, paste an error, or describe what you want to understand.</span>
      </div>
    {:else}
      {#each messages as message (message.seq)}
        {#if message.role === "tool"}
          {@const jev = jevMetadata(message)}
          {@const toolState = toolComparisons[String(message.seq)]}
          <details class="tool-strip" open>
            <summary><span class="lamp mini on-green" aria-hidden="true"></span><code>{toolName(message)}</code></summary>
            {#if jev}
              <div class="jev-inspector">
                <span>jev · {jev.view} · {jev.sentLines} of {jev.totalLines} lines sent</span>
                <div class="jev-toggle" aria-label="jev context view">
                  <button type="button" aria-pressed={!toolState || toolState.view === "compressed"} onclick={() => void showToolView(message, "compressed")}>sent to model</button>
                  <button type="button" aria-pressed={toolState?.view === "original"} onclick={() => void showToolView(message, "original")}>original</button>
                </div>
              </div>
            {/if}
            {#if toolState?.loading}<p class="tool-view-status" role="status">loading original output…</p>
            {:else if toolState?.error}<p class="tool-view-error" role="alert">{toolState.error} <button type="button" class="text-action" onclick={() => void showToolView(message, "original")}>retry</button></p>
            {:else if toolState?.view === "original" && toolState.original !== undefined}<pre>{toolState.original}</pre>
            {:else if message.content}<pre>{message.content}</pre>{/if}
          </details>
        {:else}
          <article class="conversation-message {message.role}" aria-label={`${message.role} message`}>
            <span class="message-label">{messageLabel(message)}</span>
            <div class="message-copy">{message.content}</div>
          </article>
        {/if}
      {/each}
      {#if working}
        <div class="working-line" role="status"><span class="lamp on-amber blink" aria-hidden="true"></span>working</div>
      {/if}
    {/if}
  </div>

  {#if error || historyError || run?.status === "failed"}<div class="conversation-error" role="alert">{error ?? historyError ?? run?.error}</div>{/if}
  <form class="composer" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <span class="sr-only" id="composer-hint">enter to send · shift enter for a new line</span>
    <textarea
      bind:this={composer}
      bind:value={prompt}
      oninput={resizeComposer}
      onkeydown={onComposerKeydown}
      placeholder={waitingText ?? (working ? "agent is working…" : "message this thread")}
      aria-label="message this thread"
      aria-describedby="composer-hint"
      title="enter to send · shift enter for a new line"
      disabled={busy || !!waitingText}
      rows="1"
    ></textarea>
    <button class="send-key" type="submit" title="send · enter" aria-label="send message" disabled={!prompt.trim() || busy || changingModel || !model || !!waitingText}>
      <Icon name="arrow" size={16} />
    </button>
    {#if working}<button class="key" type="button" onclick={() => { void stopThread(threadId).catch(cause => { error = errorText(cause); }); }}>stop</button>{/if}
  </form>
</div>

<style>
  .jev-inspector { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; flex-wrap: wrap; padding: 0.45rem 0.7rem; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 11px; letter-spacing: 0.04em; }
  .jev-toggle { display: flex; border: 1px solid var(--line-2); border-radius: 5px; overflow: hidden; }
  .jev-toggle button { border: 0; border-right: 1px solid var(--line-2); padding: 0.25rem 0.55rem; background: var(--s2); color: var(--ink-2); font: 550 11px var(--font-ui); cursor: pointer; }
  .jev-toggle button:last-child { border-right: 0; }
  .jev-toggle button[aria-pressed="true"] { background: var(--s4); color: var(--ink); box-shadow: inset 0 -2px 0 var(--signal); }
  .jev-toggle button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
  .tool-view-status, .tool-view-error { margin: 0; padding: 0.7rem; background: var(--s1); color: var(--ink-3); font: 12px/1.5 var(--font-mono); }
  .tool-view-error { color: var(--bad); }
  @media (max-width: 40rem) { .jev-inspector { align-items: start; } }
</style>
