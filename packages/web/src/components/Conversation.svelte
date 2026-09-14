<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, fetchConversation, sendPrompt } from "../lib/api.ts";
  import type { AgentRun, ConversationMessage, ModelSelection } from "../lib/types.ts";
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
  const working = $derived(run?.status === "queued" || run?.status === "running");
  $effect(() => { busy = working || sending; });

  async function refresh(): Promise<void> {
    try {
      const history = await fetchConversation(threadId);
      const nearBottom = !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
      messages = history.messages;
      run = history.run;
      historyError = null;
      loading = false;
      if (nearBottom) {
        await tick();
        transcript?.scrollTo({ top: transcript.scrollHeight });
      }
    } catch (cause) {
      if (!disposed) {
        historyError = errorText(cause);
        loading = false;
      }
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      disposed = true;
      clearInterval(timer);
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
      await sendPrompt(threadId, text, model);
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
          <details class="tool-strip" open>
            <summary><span class="lamp mini on-green" aria-hidden="true"></span><code>{toolName(message)}</code></summary>
            {#if message.content}<pre>{message.content}</pre>{/if}
          </details>
        {:else}
          <article class="conversation-message {message.role}" aria-label={`${message.role} message`}>
            <span class="message-label">{message.role === "user" ? "you" : "agent"}</span>
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
  </form>
</div>
