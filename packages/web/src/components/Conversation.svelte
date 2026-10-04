<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, sendPrompt, stopThread, threadEvents } from "../lib/api.ts";
  import { transcriptRows, type ToolState } from "../lib/transcript.ts";
  import { uid } from "../lib/uid.ts";
  import type { ModelSelection, ThreadStatus, ThreadTranscript } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { threadId, model, changingModel = false, busy = $bindable(false), waitingText = null, notice = null }: {
    threadId: string;
    model: ModelSelection | null;
    changingModel?: boolean;
    busy?: boolean;
    waitingText?: string | null;
    /** A standing note about the thread, shown above its transcript. */
    notice?: string | null;
  } = $props();
  // The neutral thread event model is the only input; no agent shapes here.
  const events = $derived(threadEvents(threadId));
  let transcript = $state<Pick<ThreadTranscript, "events" | "status">>({ events: [], status: { state: "idle", run: null, error: null } });
  const rows = $derived(transcriptRows(transcript));
  const status = $derived<ThreadStatus>(transcript.status);
  let prompt = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let historyError = $state<string | null>(null);
  let scroller: HTMLElement;
  let composer: HTMLTextAreaElement;
  let disposed = false;
  let sending = $state(false);
  let pending: { text: string; requestId: string } | null = null;
  const working = $derived(status.state === "working");
  $effect(() => { busy = working || sending; });

  async function show(next: ThreadTranscript): Promise<void> {
      if (disposed) return;
      const nearBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      transcript = next;
      historyError = null;
      loading = false;
      if (nearBottom) {
        await tick();
        scroller?.scrollTo({ top: scroller.scrollHeight });
      }
  }

  async function refresh(): Promise<void> {
    try {
      await show(await events.read());
    } catch (cause) {
      if (!disposed) {
        historyError = errorText(cause);
        loading = false;
      }
    }
  }

  onMount(() => {
    const watching = events.watch(show, {
      onInterrupt: () => { if (!disposed) historyError = "connection interrupted — reconnecting…"; },
      onEnd: cause => { if (!disposed) { historyError = errorText(cause); loading = false; } },
    });
    return () => {
      disposed = true;
      void watching.then(watch => watch.stop());
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

  const toolLamp: Record<ToolState, string> = { waiting: "on-amber", running: "on-amber blink", done: "on-green", error: "on-red", open: "" };
  const toolStateLabel: Record<ToolState, string> = { waiting: "waiting", running: "running", done: "done", error: "error", open: "no result" };
</script>

<div class="conversation">
  <div class="transcript" bind:this={scroller} aria-live="polite" aria-busy={working}>
    {#if notice}<p class="conversation-notice" role="note">{notice}</p>{/if}
    {#if loading}
      <p class="conversation-empty">{waitingText ?? "reading thread…"}</p>
    {:else if rows.length === 0}
      <div class="conversation-empty">
        <span class="lamp on-green" aria-hidden="true"></span>
        <p>ready when you are</p>
        <span>Ask for a change, paste an error, or describe what you want to understand.</span>
      </div>
    {:else}
      {#each rows as row (row.id)}
        {#if row.kind === "tool"}
          <details class="tool-strip" open>
            <summary title={row.summary || row.name}>
              <span class="lamp mini {toolLamp[row.state]}" aria-hidden="true"></span><span class="sr-only">{toolStateLabel[row.state]}</span>
              <code>{row.name}</code>{#if row.summary}<span class="tool-summary">{row.summary}</span>{/if}
            </summary>
            {#if row.input}<pre class="tool-input">{row.input}</pre>{/if}
            {#if row.output}<pre>{row.output}</pre>{/if}
          </details>
        {:else if row.kind === "user"}
          <article class="conversation-message user" aria-label="user message">
            <span class="message-label">you</span>
            <div class="message-copy">{row.text}</div>
          </article>
        {:else}
          <article class="conversation-message assistant" class:continued={!row.labelled} aria-label={row.reasoning ? "agent reasoning" : "agent message"}>
            {#if row.labelled}<span class="message-label">agent</span>{/if}
            <div class="message-copy" class:reasoning={row.reasoning}>{row.text}</div>
          </article>
        {/if}
      {/each}
      {#if working}
        <div class="working-line" role="status"><span class="lamp on-amber blink" aria-hidden="true"></span>working</div>
      {:else if status.state === "stopped"}
        <div class="working-line" role="status"><span class="lamp" aria-hidden="true"></span>stopped</div>
      {/if}
    {/if}
  </div>

  {#if error || historyError || status.state === "failed"}<div class="conversation-error" role="alert">{error ?? historyError ?? status.error ?? "the run failed"}</div>{/if}
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
