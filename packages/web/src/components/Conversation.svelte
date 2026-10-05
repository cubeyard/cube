<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, sendPrompt, stopThread, threadBase, threadEvents } from "../lib/api.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { transcriptRows, type ToolState } from "../lib/transcript.ts";
  import { uid } from "../lib/uid.ts";
  import type { ModelSelection, ThreadStatus, ThreadTranscript } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { threadId = "", base = threadBase(threadId), steer = false, model, changingModel = false, busy = $bindable(false), waitingText = null, notice = null, empty = null, placeholder = "message this thread" }: {
    threadId?: string;
    /** Messages may be sent while the agent works; they reach it between tool calls. */
    steer?: boolean;
    /** The routes this conversation reads and writes; default: the thread's. */
    base?: string;
    /** Replaces the empty transcript's hint. */
    empty?: { title: string; hint: string } | null;
    placeholder?: string;
    model: ModelSelection | null;
    changingModel?: boolean;
    busy?: boolean;
    waitingText?: string | null;
    /** A standing note about the thread, shown above its transcript. */
    notice?: string | null;
  } = $props();
  // The neutral thread event model is the only input; no agent shapes here.
  const events = $derived(threadEvents(base));
  let transcript = $state<Pick<ThreadTranscript, "events" | "status">>({ events: [], status: { state: "idle", run: null, error: null } });
  const rows = $derived(transcriptRows(transcript));
  const status = $derived<ThreadStatus>(transcript.status);
  let prompt = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let historyError = $state<string | null>(null);
  let reconnecting = $state(false);
  let stopping = $state(false);
  let scroller: HTMLElement;
  let composer: HTMLTextAreaElement;
  let disposed = false;
  let sending = $state(false);
  let pending: { text: string; requestId: string } | null = null;
  const working = $derived(status.state === "working");
  $effect(() => { busy = working || sending; });
  // The draft is always the user's to edit: a run, a reconnect or a booting
  // machine only hold the send key, never the text field.
  const canSend = $derived(!!prompt.trim() && (!working || steer) && !sending && !changingModel && !!model && !waitingText);

  // Follow the newest output while the reader is at the bottom; leave them
  // where they are once they scroll up. Layout that settles later (fonts,
  // a tool folding shut, streamed text, a growing draft) keeps a following
  // view pinned.
  let following = true;
  let column: HTMLElement;
  const atBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const toBottom = () => scroller?.scrollTo({ top: scroller.scrollHeight });

  async function show(next: ThreadTranscript, follow = false): Promise<void> {
    if (disposed) return;
    if (follow) following = true;
    transcript = next;
    historyError = null;
    loading = false;
    if (following) {
      await tick();
      toBottom();
    }
  }

  /** A frame from the live stream: the connection is back. */
  async function onFrame(next: ThreadTranscript): Promise<void> {
    if (!disposed) reconnecting = false;
    await show(next);
  }

  async function refresh(): Promise<void> {
    try {
      await show(await events.read(), true);
    } catch (cause) {
      if (!disposed) {
        historyError = errorText(cause);
        loading = false;
      }
    }
  }

  // While the stream is down, the saved history still says whether the run
  // ended, so the send key is not held by a status the stream never closed.
  let lastCatchUp = 0;
  function catchUp(): void {
    if (Date.now() - lastCatchUp < 5000) return;
    lastCatchUp = Date.now();
    events.read().then(next => { if (!disposed && reconnecting) void show(next); }, () => {});
  }

  onMount(() => {
    const watching = events.watch(onFrame, {
      onInterrupt: () => {
        if (disposed) return;
        reconnecting = true;
        catchUp();
      },
      onEnd: cause => { if (!disposed) { historyError = errorText(cause); reconnecting = false; loading = false; } },
    });
    const onScroll = () => { following = atBottom(); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const settle = new ResizeObserver(() => { if (following) toBottom(); });
    settle.observe(column);
    settle.observe(scroller);
    return () => {
      disposed = true;
      scroller.removeEventListener("scroll", onScroll);
      settle.disconnect();
      void watching.then(watch => watch.stop());
    };
  });

  function resizeComposer(): void {
    if (!composer) return;
    composer.style.height = "auto";
    // scrollHeight leaves out the border; a border-box field needs it back
    // or every multi-line draft grows a needless scrollbar.
    const border = composer.offsetHeight - composer.clientHeight;
    composer.style.height = `${Math.min(composer.scrollHeight + border, 176)}px`;
  }

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!canSend || !model) return;
    sending = true;
    error = null;
    try {
      if (pending?.text !== text) pending = { text, requestId: uid() };
      await sendPrompt(base, text, model, pending.requestId);
      pending = null;
      // Only the sent text leaves the field; anything typed meanwhile stays.
      const draft = prompt.trimStart();
      prompt = draft.startsWith(text) ? draft.slice(text.length).trimStart() : prompt;
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

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      await stopThread(base);
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    } finally {
      if (!disposed) stopping = false;
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
  <div class="transcript" bind:this={scroller} aria-busy={working}>
    <div class="transcript-column" bind:this={column}>
      {#if notice}<p class="conversation-notice" role="note">{notice}</p>{/if}
      {#if loading}
        <p class="conversation-empty">{waitingText ?? "reading thread…"}</p>
      {:else if rows.length === 0}
        <div class="conversation-empty">
          <span class="lamp on-green" aria-hidden="true"></span>
          <p>{empty?.title ?? "ready when you are"}</p>
          <span>{empty?.hint ?? "Ask for a change, paste an error, or describe what you want to understand."}</span>
        </div>
      {:else}
        {#each rows as row (row.id)}
          {#if row.kind === "tool"}
            <details class="tool-strip" open={row.state === "running" || row.state === "waiting" || row.state === "error"}>
              <summary title={row.summary || row.name}>
                <span class="lamp mini {toolLamp[row.state]}" aria-hidden="true"></span><span class="sr-only">{toolStateLabel[row.state]}</span>
                <code>{row.name}</code>{#if row.summary}<span class="tool-summary">{row.summary}</span>{/if}
                {#if row.input || row.output}<span class="tool-chevron"><Icon name="chevron" size={12} /></span>{/if}
              </summary>
              {#if row.input}<pre class="tool-input">{row.input}</pre>{/if}
              {#if row.output}<pre>{row.output}</pre>{/if}
            </details>
          {:else if row.kind === "user" && row.from}
            <article class="conversation-message report" aria-label="thread report">
              <span class="message-label">thread {row.from}</span>
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown prints raw html as text and allows only http(s)/mailto links -->
              <div class="message-copy markdown">{@html renderMarkdown(row.text)}</div>
            </article>
          {:else if row.kind === "user"}
            <article class="conversation-message user" aria-label="user message">
              <span class="message-label">you</span>
              <div class="message-copy">{row.text}</div>
            </article>
          {:else}
            <article class="conversation-message assistant" class:continued={!row.labelled} aria-label={row.reasoning ? "agent reasoning" : "agent message"}>
              {#if row.labelled}<span class="message-label">agent</span>{/if}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown prints raw html as text and allows only http(s)/mailto links -->
              <div class="message-copy markdown" class:reasoning={row.reasoning}>{@html renderMarkdown(row.text)}</div>
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
  </div>

  {#if reconnecting}<div class="conversation-note" role="status"><span class="lamp on-amber blink" aria-hidden="true"></span>reconnecting to the thread…</div>{/if}
  {#if error || historyError || status.state === "failed"}<div class="conversation-error" role="alert">{error ?? historyError ?? status.error ?? "the run failed"}</div>{/if}
  <form class="composer" aria-busy={busy} onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <span class="sr-only" id="composer-hint">enter to send · shift enter for a new line</span>
    <textarea
      bind:this={composer}
      bind:value={prompt}
      oninput={resizeComposer}
      onkeydown={onComposerKeydown}
      placeholder={waitingText ?? (working ? (steer ? "agent is working — a message reaches it between steps" : "agent is working…") : placeholder)}
      aria-label={placeholder}
      aria-describedby="composer-hint"
      title="enter to send · shift enter for a new line"
      rows="1"
    ></textarea>
    <button class="send-key" type="submit" title="send · enter" aria-label="send message" disabled={!canSend}>
      <Icon name="arrow" size={16} />
    </button>
    {#if working}<button class="key stop-key" type="button" disabled={stopping} onclick={stop}>{stopping ? "stopping…" : "stop"}</button>{/if}
  </form>
</div>
