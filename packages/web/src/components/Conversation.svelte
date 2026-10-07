<script lang="ts">
  import { onMount, tick } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { errorText, imageUrl, sendPrompt, stopThread, threadBase, threadEvents, uploadImage } from "../lib/api.ts";
  import { ACCEPT, MEDIA_LIMITS, pastedImages, prepareImage } from "../lib/images.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { echo, echoRows, unanswered, unlogged, type Echo } from "../lib/outbox.ts";
  import { toolOpen, transcriptRows, type ToolState, type TranscriptRow } from "../lib/transcript.ts";
  import { uid } from "../lib/uid.ts";
  import type { MessageImage, ModelSelection, ThreadStatus, ThreadTranscript } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let { threadId = "", base = threadBase(threadId), steer = false, model, changingModel = false, busy = $bindable(false), waitingText = null, notice = null, empty = null, placeholder = "message this thread", images = null }: {
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
    /** Messages may carry images (pasted, dropped or picked) when the model
     * takes them; null: this conversation takes none. */
    images?: { supported: boolean; reason: string | null } | null;
  } = $props();
  // The neutral thread event model is the only input; no agent shapes here.
  const events = $derived(threadEvents(base));
  let transcript = $state<Pick<ThreadTranscript, "events" | "status">>({ events: [], status: { state: "idle", run: null, error: null } });
  /** Sent messages not yet in the log: each is shown, from the moment it is
   * sent, while the transcript shows no copy of it, so a send never reads as
   * nothing, or as gone. */
  let echoes = $state<Echo[]>([]);
  const outgoing = $derived(unanswered(transcript, echoes));
  const rows = $derived([...transcriptRows(transcript), ...echoRows(outgoing)]);
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
  /** The send being made: a retry of the same message is the same request,
   * counted as the first attempt was (see `echo`). */
  let pending: { key: string; requestId: string; seen: number | null } | null = null;
  /** Images attached to the draft: uploaded at once, sent with the message. */
  type Attachment = { key: string; name: string; preview: string; id: string | null; mimeType: string | null; error: string | null };
  let attachments = $state<Attachment[]>([]);
  let picker = $state<HTMLInputElement>();
  let viewing = $state<{ src: string; label: string } | null>(null);
  let viewer = $state<HTMLDialogElement>();
  let attachNote = $state<string | null>(null);
  const uploading = $derived(attachments.some(item => !item.id && !item.error));
  const failedAttachment = $derived(attachments.some(item => item.error));
  const working = $derived(status.state === "working");
  // No turn runs, but the agent's background agents do; stop ends them.
  const waiting = $derived(!working && !!status.waiting?.length);
  // A sent message the transcript has not shown yet is busy too: the chat
  // does not read idle between a send and its run.
  $effect(() => { busy = working || sending || outgoing.length > 0; });
  // The draft is always the user's to edit: a run, a reconnect or a booting
  // machine only hold the send key, never the text field.
  // An image that failed holds the send until it is removed: nothing the
  // user attached is dropped without their say.
  const imagesHeld = $derived(attachments.length > 0 && (uploading || failedAttachment || !images?.supported));
  const canSend = $derived((!!prompt.trim() || attachments.length > 0) && !imagesHeld && (!working || steer) && !sending && !changingModel && !!model && !waitingText);

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
    if (echoes.length) echoes = unlogged(next, echoes);
    historyError = null;
    loading = false;
    if (following) {
      await tick();
      toBottom();
    }
  }

  /** Frames shown so far: a read that a frame overtook is older than the
   * stream, which sends a newer frame for every later change. */
  let frames = 0;

  /** A frame from the live stream: the connection is back. */
  async function onFrame(next: ThreadTranscript): Promise<void> {
    frames++;
    if (!disposed) reconnecting = false;
    await show(next);
  }

  async function refresh(): Promise<void> {
    const seen = frames;
    try {
      const next = await events.read();
      if (frames !== seen && !reconnecting) { following = true; await tick(); toBottom(); return; }
      await show(next, true);
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
      for (const item of attachments) URL.revokeObjectURL(item.preview);
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

  /** Attaches image files: each is checked, shrunk if large, and uploaded. */
  function attach(files: readonly File[]): void {
    attachNote = null;
    if (!images || !files.length) return;
    if (!images.supported) { attachNote = images.reason ?? "this model does not take images"; return; }
    const room = Math.max(0, MEDIA_LIMITS.perMessage - attachments.length);
    if (files.length > room) attachNote = `at most ${MEDIA_LIMITS.perMessage} images a message; ${files.length - room} not attached`;
    for (const file of files.slice(0, room)) {
      const item: Attachment = { key: uid(), name: file.name || "pasted image", preview: URL.createObjectURL(file), id: null, mimeType: null, error: null };
      attachments.push(item);
      void (async () => {
        let result: Pick<Attachment, "id" | "mimeType" | "error">;
        try {
          const uploaded = await uploadImage(base, await prepareImage(file));
          result = { id: uploaded.id, mimeType: uploaded.mimeType, error: null };
        } catch (cause) { result = { id: null, mimeType: null, error: errorText(cause) }; }
        const index = attachments.findIndex(other => other.key === item.key);
        if (index < 0 || disposed) return;
        // The same image twice goes once: the second is let go here.
        if (result.id && attachments.some(other => other.key !== item.key && other.id === result.id)) {
          detach(item.key);
          attachNote = "that image is already attached";
          return;
        }
        attachments[index] = { ...attachments[index]!, ...result };
      })();
    }
  }

  function detach(key: string): void {
    const item = attachments.find(other => other.key === key);
    if (item) URL.revokeObjectURL(item.preview);
    attachments = attachments.filter(other => other.key !== key);
    attachNote = null;
    composer?.focus();
  }

  // Only a paste of image files without text is taken as images; every
  // other paste is the field's own.
  function onPaste(event: ClipboardEvent): void {
    if (!images) return;
    const files = pastedImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  }

  function onPick(): void {
    const files = [...picker?.files ?? []];
    if (picker) picker.value = "";
    attach(files);
  }

  // Any dropped file is taken here, never opened by the browser in place of the chat.
  function onDrop(event: DragEvent): void {
    if (!images || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files].filter(file => file.type.startsWith("image/"));
    if (files.length) attach(files);
    else attachNote = "only png, jpeg, gif and webp images can be attached";
  }

  /** Images that did not load: shown as missing, not opened, until a retry
   * asks the host again. */
  const missing = new SvelteSet<string>();
  const retries = new SvelteMap<string, number>();
  const thumbnail = (id: string) => `${imageUrl(base, id)}${retries.get(id) ? `?retry=${retries.get(id)}` : ""}`;
  function retry(id: string): void {
    missing.delete(id);
    retries.set(id, (retries.get(id) ?? 0) + 1);
  }

  async function inspect(src: string, label: string): Promise<void> {
    viewing = { src, label };
    await tick();
    viewer?.showModal();
  }

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!canSend || !model) return;
    sending = true;
    error = null;
    const sent = attachments.filter(item => item.id);
    const ids = sent.map(item => item.id!);
    const key = JSON.stringify([text, ids]);
    if (pending?.key !== key) pending = { key, requestId: uid(), seen: null };
    const requestId = pending.requestId;
    // The message leaves the field for the transcript at once; a failed
    // send puts it back, before anything typed meanwhile.
    const made = echo(transcript, echoes, requestId, text, sent.map(item => ({ id: item.id!, mimeType: item.mimeType ?? "" })), pending.seen ?? undefined);
    pending.seen = made.seen;
    echoes = [...echoes, made];
    attachments = attachments.filter(item => !sent.includes(item));
    prompt = "";
    following = true;
    await tick();
    resizeComposer();
    toBottom();
    try {
      await sendPrompt(base, text, model, requestId, ids);
      pending = null;
      echoes = echoes.map(item => item.key === requestId ? { ...item, accepted: true } : item);
      for (const item of sent) URL.revokeObjectURL(item.preview);
      await refresh();
    } catch (cause) {
      echoes = echoes.filter(item => item.key !== requestId);
      if (disposed) for (const item of sent) URL.revokeObjectURL(item.preview);
      else {
        prompt = prompt.trim() ? `${text}\n${prompt}` : text;
        attachments = [...sent, ...attachments];
        await tick();
        resizeComposer();
      }
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

  // Strips the reader opened or closed stay that way while frames arrive.
  const chosen = new SvelteMap<string, boolean>();
  function onToolToggle(event: Event, row: Extract<TranscriptRow, { kind: "tool" }>): void {
    // The element, not ToggleEvent.newState: older Safari sends a plain Event.
    const open = (event.currentTarget as HTMLDetailsElement).open;
    // A toggle the render caused (a strip opening as it runs) is no choice.
    if (open !== toolOpen(row, chosen)) chosen.set(row.callId, open);
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
            <details class="tool-strip" open={toolOpen(row, chosen)} ontoggle={(event) => onToolToggle(event, row)}>
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
            <article class="conversation-message user" class:sending={row.sending} aria-label="user message">
              <span class="message-label">you{#if row.sending}<span class="message-sending"> · sending</span>{/if}</span>
              {#if row.images}{@render messageImages(row.images)}{/if}
              {#if row.text}<div class="message-copy">{row.text}</div>{/if}
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
        {:else if waiting}
          <div class="working-line" role="status"><span class="lamp on-amber" aria-hidden="true"></span>waiting on {status.waiting!.length === 1 ? "a background agent" : `${status.waiting!.length} background agents`}: {status.waiting!.map(description => description.length > 80 ? `${description.slice(0, 79)}…` : description).join(", ")}</div>
        {:else if status.state === "stopped"}
          <div class="working-line" role="status"><span class="lamp" aria-hidden="true"></span>stopped</div>
        {/if}
      {/if}
    </div>
  </div>

  {#if reconnecting}<div class="conversation-note" role="status"><span class="lamp on-amber blink" aria-hidden="true"></span>reconnecting to the thread…</div>{/if}
  {#if error || historyError || status.state === "failed"}<div class="conversation-error" role="alert">{error ?? historyError ?? status.error ?? "the run failed"}</div>{/if}
  <form class="composer" aria-busy={busy} onsubmit={(event) => { event.preventDefault(); void submit(); }}
    ondragover={(event) => { if (images && event.dataTransfer?.types.includes("Files")) event.preventDefault(); }} ondrop={onDrop}>
    <span class="sr-only" id="composer-hint">enter to send · shift enter for a new line{images ? " · paste or drop images to attach them" : ""}</span>
    {#if images}<span class="sr-only" role="status">{!attachments.length ? "" : uploading ? "uploading images…" : failedAttachment ? "an image failed to upload" : `${attachments.length} ${attachments.length === 1 ? "image" : "images"} attached`}</span>{/if}
    {#if images && (attachments.length || attachNote)}
      <div class="composer-attachments">
        {#if attachments.length}
          <ul aria-label="attached images">
            {#each attachments as item, index (item.key)}
              <li class="attachment" class:failed={item.error}>
                <img src={item.preview} alt={`attached image ${index + 1}: ${item.name}`} />
                <span class="attachment-state">{item.error ?? (item.id ? "ready" : "uploading…")}</span>
                <button class="key icon attachment-remove" type="button" aria-label={`remove image ${index + 1}`} title="remove" disabled={sending} onclick={() => detach(item.key)}><Icon name="close" size={12} /></button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if attachNote}<p class="attachment-note" role="alert">{attachNote}</p>
        {:else if attachments.length && !images.supported}<p class="attachment-note" role="alert">{images.reason ?? "this model does not take images"}: remove the images or choose another model</p>
        {:else if failedAttachment}<p class="attachment-note" role="alert">remove the image that failed to send this message</p>{/if}
      </div>
    {/if}
    <!-- the deck is full-bleed; the field sits in the transcript's measure -->
    <div class="composer-row">
      <!-- a press on the field's padding puts the caret in the text; the keys keep their own -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="composer-field" onclick={(event) => { if (event.target === event.currentTarget) composer?.focus(); }}>
        {#if images}
          <input class="sr-only" type="file" accept={ACCEPT} multiple tabindex="-1" aria-hidden="true" bind:this={picker} onchange={onPick} />
          <button class="key icon attach-key" type="button" title={images.supported ? "attach images · or paste or drop them here" : (images.reason ?? "this model does not take images")}
            aria-label="attach images" disabled={!images.supported || attachments.length >= MEDIA_LIMITS.perMessage} onclick={() => picker?.click()}><Icon name="plus" size={14} /></button>
        {/if}
        <textarea
          bind:this={composer}
          bind:value={prompt}
          oninput={resizeComposer}
          onkeydown={onComposerKeydown}
          onpaste={onPaste}
          placeholder={waitingText ?? (working ? (steer ? "agent is working — a message reaches it between steps" : "agent is working…") : placeholder)}
          aria-label={placeholder}
          aria-describedby="composer-hint"
          title="enter to send · shift enter for a new line"
          rows="1"
        ></textarea>
        <button class="send-key" type="submit" title="send · enter" aria-label="send message" disabled={!canSend}>
          <Icon name="arrow" size={16} />
        </button>
      </div>
      {#if working || waiting}<button class="key stop-key" type="button" disabled={stopping} onclick={stop}>{stopping ? "stopping…" : "stop"}</button>{/if}
    </div>
  </form>
  {#if viewing}
    <!-- a click on the backdrop closes it; escape and the close key do too -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <dialog class="image-viewer" bind:this={viewer} aria-label={viewing.label} onclose={() => { viewing = null; }}
      onclick={(event) => { if (event.target === viewer) viewer?.close(); }}>
      <div class="image-viewer-head">
        <span>{viewing.label}</span>
        <a class="key" href={viewing.src} target="_blank" rel="noopener noreferrer">full size</a>
        <button class="key icon" type="button" aria-label="close" onclick={() => viewer?.close()}><Icon name="close" size={14} /></button>
      </div>
      <img src={viewing.src} alt={viewing.label} />
    </dialog>
  {/if}
</div>

{#snippet messageImages(list: MessageImage[])}
  <ul class="message-images" aria-label={list.length === 1 ? "1 image" : `${list.length} images`}>
    {#each list as image, index (index)}
      {@const label = `image ${index + 1} of ${list.length}`}
      <li class:missing={missing.has(image.id)}>
        <button type="button" class="message-image" aria-label={missing.has(image.id) ? `${label} unavailable, retry` : `view ${label} larger`}
          onclick={() => missing.has(image.id) ? retry(image.id) : inspect(imageUrl(base, image.id), label)}>
          <img src={thumbnail(image.id)} alt={label} loading="lazy" decoding="async" onerror={() => missing.add(image.id)} />
          <span class="message-image-missing">image unavailable · retry</span>
        </button>
      </li>
    {/each}
  </ul>
{/snippet}
