<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { errorText, imageUrl, sendPrompt, stopThread, threadBase, threadEvents, uploadImage } from "../lib/api.ts";
  import { ACCEPT, MEDIA_LIMITS, pastedImages, prepareImage } from "../lib/images.ts";
  import { drawDiagrams } from "../lib/diagram.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { reportLine } from "../lib/report-line.ts";
  import { keep, keptOf, listen, recover, type Pending } from "../lib/drafts.ts";
  import { echo, echoRows, unanswered, unlogged, type Echo } from "../lib/outbox.ts";
  import { keepRows, picturePath, toolOpen, transcriptRows, type ToolState, type TranscriptRow } from "../lib/transcript.ts";
  import { rowKey } from "../lib/provenance.ts";
  import { groupChoiceKey, groupLine, groupOpen, groupTools, type Shown } from "../lib/tool-groups.ts";
  import { uid } from "../lib/uid.ts";
  import type { MessageImage, ModelSelection, ThreadStatus, ThreadTranscript } from "../lib/types.ts";
  import { tailStart, WINDOW_EVENTS } from "../../../server/src/transcript-window.ts";
  import type { TranscriptPage } from "../../../server/src/thread-events.ts";
  import Icon from "./Icon.svelte";
  import ThinkingCube from "./ThinkingCube.svelte";

  let { threadId = "", base = threadBase(threadId), steer = false, model, changingModel = false, busy = $bindable(false), waitingText = null, notice = null, empty = null, placeholder = "message this thread", images = null,
    sheet = false, foldTools = false, onRows, toolLine, reportLabel, reportTitle, reportNamed, after, margin }: {
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
    /** The chat's sheet: no "you"/"agent" labels over the messages (each
     * keeps its accessible name), quieter tool lines, room for a margin. */
    sheet?: boolean;
    /** Each run of consecutive tool calls is one folded line (lib/tool-groups.ts). */
    foldTools?: boolean;
    /** Told the rows shown, for what is drawn beside them. */
    onRows?: (rows: TranscriptRow[]) => void;
    /** A tool row's line in plain words, in place of its raw input. */
    toolLine?: (row: Extract<TranscriptRow, { kind: "tool" }>) => string | null;
    /** A thread report's label, given its short id; default "thread <id>". */
    reportLabel?: Snippet<[string]>;
    /** A thread report's name in plain words, for its folded line; default "thread <id>". */
    reportTitle?: (from: string) => string;
    /** Whether that name is the thread's short given name ("🦦 calm otter"),
     * which the line's first words give way to before it is cut. */
    reportNamed?: (from: string) => boolean;
    /** Drawn after a row, in the conversation's flow. */
    after?: Snippet<[TranscriptRow]>;
    /** Drawn beside the conversation's column, scrolling with it; rows carry `data-anchor` (`rowKey`). */
    margin?: Snippet;
  } = $props();
  // The neutral thread event model is the only input; no agent shapes here.
  const events = $derived(threadEvents(base));
  /** The window of the newest events the stream keeps current. */
  let transcript = $state.raw<Pick<ThreadTranscript, "events" | "status" | "start">>({ events: [], status: { state: "idle", run: null, error: null } });
  /** The events before the window, read a page at a time as the reader
   * scrolls up; they end where the window starts. */
  let earlier = $state.raw<TranscriptPage>({ start: 0, events: [] });
  /** The index of the first event shown; above it there is more to read. */
  const first = $derived(earlier.events.length ? earlier.start : transcript.start ?? 0);
  let loadingEarlier = $state(false);
  let earlierError = $state<string | null>(null);
  /** Sent messages not yet in the log: each is shown, from the moment it is
   * sent, while the transcript shows no copy of it, so a send never reads as
   * nothing, or as gone. Counted in the window alone, whose start is fixed
   * while a message waits, so a page read meanwhile cannot answer one. */
  let echoes = $state<Echo[]>([]);
  const outgoing = $derived(unanswered(transcript, echoes));
  /** The rows last shown by id: a frame keeps the ones it did not change. */
  let shownRows = new Map<string, TranscriptRow>();
  const rows = $derived.by(() => {
    const next = keepRows(shownRows, [...transcriptRows({ events: [...earlier.events, ...transcript.events], status: transcript.status }), ...echoRows(outgoing)]);
    shownRows = new Map(next.map(row => [row.id, row]));
    return next;
  });
  /** The rows as drawn: runs of tool calls folded, when this conversation folds them. */
  const shown = $derived<Shown[]>(foldTools ? groupTools(rows) : rows.map(row => ({ kind: "row", row })));
  const status = $derived<ThreadStatus>(transcript.status);
  $effect(() => { onRows?.(rows); });
  // The diagrams in the rows, drawn after each frame; one already drawn is kept and shown at once.
  $effect(() => { void rows; void tick().then(() => drawDiagrams(scroller)); });
  // The draft outlives the view: closing the panel a thread is in keeps it,
  // its send's identity and a failure's note for the next visit.
  const start = untrack(() => keptOf(base));
  let prompt = $state(start.text);
  // A field emptied by hand drops a failure's note: "back in the field" no longer holds.
  $effect(() => { keep(base, prompt.trim() ? { text: prompt } : { text: prompt, note: null }); });
  let loading = $state(true);
  let error = $state<string | null>(start.note);
  let historyError = $state<string | null>(null);
  let reconnecting = $state(false);
  let stopping = $state(false);
  let scroller: HTMLElement;
  let composer: HTMLTextAreaElement;
  let disposed = false;
  let sending = $state(false);
  /** The send being made: a retry of the same message is the same request,
   * counted as the first attempt was (see `echo`). */
  let pending: Pending | null = start.pending;
  /** `pending` came from the store (a failure kept for this thread), not from a send of this view. */
  let pendingKept = !!start.pending;
  // Only a send that failed carries its request to a later view (so a retry
  // of the same words is the same request); one still on its way stays this
  // view's own, or a later view would reuse its id for a repeat after it
  // succeeded, and the host would take the repeat for a replay.
  function failedPending(failed: Pending): void { pending = failed; pendingKept = true; keep(base, { pending: failed }); }
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
  /** The message being streamed: the last row while the agent works. */
  const streamingId = $derived(working && rows.at(-1)?.kind === "assistant" ? rows.at(-1)!.id : null);
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
    // A window chosen again elsewhere (the host lost its start) no longer
    // continues the pages read before it.
    if (earlier.events.length && earlier.start + earlier.events.length !== (next.start ?? 0)) earlier = { start: 0, events: [] };
    transcript = next;
    if (echoes.length) echoes = unlogged(next, echoes);
    trim();
    historyError = null;
    loading = false;
    if (following) {
      await tick();
      toBottom();
    }
    // A window that fits on the screen gives no scroll to read on from.
    nearTop();
  }

  /** A window grown far past its first size (a chat left open) moves its
   * older part to the pages and starts the stream later, so a frame stays
   * small. Only while no message waits: echoes are counted in the window. */
  function trim(): void {
    if (echoes.length || sending || loadingEarlier || transcript.events.length <= 3 * WINDOW_EVENTS) return;
    const cut = tailStart(transcript.events, WINDOW_EVENTS);
    if (cut <= 0) return;
    const at = (transcript.start ?? 0) + cut;
    earlier = { start: first, events: [...earlier.events, ...transcript.events.slice(0, cut)] };
    transcript = { ...transcript, start: at, events: transcript.events.slice(cut) };
    events.advance(at, transcript.events[0]!.id);
  }

  /** Reads the page before the first event shown and keeps the reader's
   * place: what they see stays where it is as the page goes in above it. */
  async function loadEarlier(): Promise<void> {
    if (loadingEarlier || loading || first <= 0 || disposed) return;
    loadingEarlier = true;
    earlierError = null;
    const before = first;
    try {
      const page = await events.older(before, WINDOW_EVENTS);
      if (disposed || first !== before) return;
      const fromBottom = scroller.scrollHeight - scroller.scrollTop;
      earlier = { start: page.start, events: [...page.events, ...earlier.events] };
      await tick();
      scroller.scrollTop = scroller.scrollHeight - fromBottom;
    } catch (cause) {
      if (!disposed) earlierError = errorText(cause);
    } finally {
      loadingEarlier = false;
    }
    nearTop();
  }
  /** The reader is near the oldest event shown (or it all fits): read on. */
  function nearTop(): void {
    if (!disposed && !earlierError && scroller && scroller.scrollTop < EARLIER_MARGIN) void loadEarlier();
  }
  const EARLIER_MARGIN = 600;

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

  let watching: ReturnType<typeof events.watch> | null = null;
  function follow(): void {
    watching = events.watch(onFrame, {
      onInterrupt: () => {
        if (disposed) return;
        reconnecting = true;
        catchUp();
      },
      onEnd: cause => { if (!disposed) { historyError = errorText(cause); reconnecting = false; loading = false; } },
    });
  }
  // A thread's history cannot be read while its machine waits (for a free
  // slot or a runner): the stream that ended then follows again once the
  // wait is over.
  let waited = false;
  $effect(() => {
    if (waitingText) { waited = true; return; }
    if (!waited || !historyError) return;
    waited = false;
    untrack(() => {
      historyError = null;
      loading = true;
      void watching?.then(watch => watch.stop());
      follow();
    });
  });

  onMount(() => {
    // a draft kept from an earlier visit: the field grows to hold it
    if (prompt) void tick().then(resizeComposer);
    // a send from an earlier visit that fails now: its words come back here,
    // before what was typed since, with its note and its request
    const unlisten = listen(base, recovery => {
      prompt = prompt.trim() ? `${recovery.text}\n${prompt}` : recovery.text;
      error = recovery.note;
      if (recovery.pending) failedPending(recovery.pending);
      keep(base, { note: recovery.note });
      void tick().then(resizeComposer);
    });
    follow();
    const onScroll = () => { following = atBottom(); nearTop(); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // An image in agent prose is markup, not a component: its failure is caught here.
    const onImageError = (event: Event) => {
      const image = event.target instanceof HTMLImageElement ? event.target.closest(".markdown-image") : null;
      image?.classList.add("missing");
      image?.setAttribute("aria-label", `${image.getAttribute("data-label") ?? "image"} unavailable, retry`);
    };
    column.addEventListener("error", onImageError, true);
    const settle = new ResizeObserver(() => { if (following) toBottom(); });
    settle.observe(column);
    settle.observe(scroller);
    return () => {
      disposed = true;
      unlisten();
      for (const item of attachments) URL.revokeObjectURL(item.preview);
      scroller.removeEventListener("scroll", onScroll);
      column.removeEventListener("error", onImageError, true);
      settle.disconnect();
      void watching?.then(watch => watch.stop());
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

  /** The source of an image agent prose names, when the thread read it. */
  const pictureOf = (row: Extract<TranscriptRow, { kind: "assistant" }>) => row.pictures
    ? (href: string) => { const path = picturePath(href); const image = path ? row.pictures![path] : undefined; return image ? imageUrl(base, image.id) : null; }
    : undefined;

  /** A press on an image in agent prose opens it, or asks again for one that did not load. */
  function onProseClick(event: MouseEvent): void {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".markdown-image") : null;
    const src = button?.dataset.image;
    if (!button || !src) return;
    event.preventDefault();
    const label = button.dataset.label ?? "image";
    if (!button.classList.contains("missing")) { void inspect(src, label); return; }
    button.classList.remove("missing");
    button.setAttribute("aria-label", `view ${label} larger`);
    const image = button.querySelector("img");
    if (image) image.src = `${src}?retry=${Date.now()}`;
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
    keep(base, { note: null });
    const sent = attachments.filter(item => item.id);
    const ids = sent.map(item => item.id!);
    const key = JSON.stringify([text, ids]);
    // a kept failure that a retry elsewhere has since delivered is no longer a request to reuse
    if (pending && pendingKept && keptOf(base).pending?.requestId !== pending.requestId) pending = null;
    pendingKept = false;
    if (pending?.key !== key) {
      pending = { key, requestId: uid(), seen: null };
      // other words: an earlier failure's request is not this message's
      keep(base, { pending: null });
    }
    const requestId = pending!.requestId;
    // The message leaves the field for the transcript at once; a failed
    // send puts it back, before anything typed meanwhile.
    const made = echo(transcript, echoes, requestId, text, sent.map(item => ({ id: item.id!, mimeType: item.mimeType ?? "" })), pending!.seen ?? undefined);
    pending = { ...pending!, seen: made.seen };
    const tried = pending!;
    echoes = [...echoes, made];
    attachments = attachments.filter(item => !sent.includes(item));
    prompt = "";
    following = true;
    await tick();
    resizeComposer();
    toBottom();
    try {
      await sendPrompt(base, text, model, requestId, ids);
      // done: also for a view open now, if this one went meanwhile
      if (keptOf(base).pending?.requestId === requestId) keep(base, { pending: null });
      if (!disposed) pending = null;
      echoes = echoes.map(item => item.key === requestId ? { ...item, accepted: true } : item);
      for (const item of sent) URL.revokeObjectURL(item.preview);
      await refresh();
    } catch (cause) {
      echoes = echoes.filter(item => item.key !== requestId);
      if (disposed) {
        for (const item of sent) URL.revokeObjectURL(item.preview);
        // Gone meanwhile: the words go to the view open now, or wait for the
        // next. Without its images it is another message, so another request;
        // the same words alone keep this one's id, so a retry cannot post twice.
        recover(base, {
          text,
          note: `not sent: ${errorText(cause)} — your message is back in the field${ids.length ? "; its images were not kept, attach them again" : ""}`,
          pending: ids.length ? null : tried,
        });
        return;
      }
      prompt = prompt.trim() ? `${text}\n${prompt}` : text;
      attachments = [...sent, ...attachments];
      await tick();
      resizeComposer();
      error = errorText(cause);
      keep(base, { note: `not sent: ${error}`, pending: tried });
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
  /** A report stands folded (open if it failed) until the reader opens or folds it; that choice holds. */
  const reportOpen = (id: string, failed: boolean) => chosen.get(`report:${id}`) ?? failed;
  function onReportToggle(event: Event, id: string, failed: boolean): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (open !== reportOpen(id, failed)) chosen.set(`report:${id}`, open);
  }
  function onToolToggle(event: Event, row: Extract<TranscriptRow, { kind: "tool" }>): void {
    // The element, not ToggleEvent.newState: older Safari sends a plain Event.
    const open = (event.currentTarget as HTMLDetailsElement).open;
    // A toggle the render caused (a strip opening as it runs) is no choice.
    if (open !== toolOpen(row, chosen)) chosen.set(row.callId, open);
  }

  /** A group stands folded until the reader opens it; the choice is kept by each of its calls. */
  function onGroupToggle(event: Event, group: Extract<Shown, { kind: "tools" }>): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (open === groupOpen(group, chosen)) return;
    for (const tool of group.tools) chosen.set(groupChoiceKey(tool.callId), open);
  }

  /** A tool line that held the focus when a frame came: the calls it stands
   * for (one strip's, or every call of a run). A frame that regroups them
   * (a lone call joined by a second, an earlier page reaching back into a
   * run) draws a new element, and the focus would fall to the page. */
  let focusedCalls: string[] = [];
  $effect.pre(() => {
    void shown;
    const active = document.activeElement;
    const line = active instanceof HTMLElement && active.matches("summary") && column?.contains(active) ? active.parentElement : null;
    focusedCalls = !line ? []
      : line.matches(".tool-strip[data-anchor]") ? [line.dataset.anchor!]
      : line.matches(".tool-group") ? [...line.querySelectorAll<HTMLElement>(".tool-strip[data-anchor]")].map(strip => strip.dataset.anchor!)
      : [];
  });
  // ...and after the frame it goes to the line that stands for them now:
  // the call's own line if it shows, else the folded run it is in.
  $effect(() => {
    void shown;
    const calls = focusedCalls;
    focusedCalls = [];
    if (!calls.length || (document.activeElement && document.activeElement !== document.body)) return;
    for (const anchor of calls) {
      const strip = column?.querySelector<HTMLElement>(`.tool-strip[data-anchor="${CSS.escape(anchor)}"]`);
      if (!strip) continue;
      const folded = strip.parentElement?.closest<HTMLDetailsElement>("details.tool-group:not([open])");
      (folded ?? strip).querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
      return;
    }
  });

  const toolStateLabel: Record<ToolState, string> = { waiting: "waiting", running: "running", done: "done", error: "error", open: "no result" };
</script>

<div class="conversation" class:sheet class:has-margin={!!margin}>
  <div class="transcript" bind:this={scroller} aria-busy={working}>
    <div class="transcript-page">
    <div class="transcript-column" bind:this={column}>
      {#if notice}<p class="conversation-notice" role="note">{notice}</p>{/if}
      {#if !loading && first > 0}
        <div class="transcript-earlier">
          {#if loadingEarlier}<span role="status">reading earlier messages…</span>
          {:else if earlierError}<span role="alert">{earlierError}</span><button class="key" type="button" onclick={() => { earlierError = null; void loadEarlier(); }}>retry</button>
          {:else}<button class="key" type="button" onclick={() => void loadEarlier()}>show earlier messages</button>{/if}
        </div>
      {/if}
      {#if loading || (waitingText && rows.length === 0)}
        <!-- a machine starting or a wake waiting: the cube says it moves, the words say what -->
        <div class="conversation-empty" class:machine={!!waitingText}>
          {#if waitingText}<ThinkingCube state={waitingText.startsWith("waiting") ? "waiting" : "starting"} size={64} />{/if}
          <p class="conversation-wait" role="status">{waitingText ?? "loading…"}</p>
        </div>
      {:else if rows.length === 0}
        <div class="conversation-empty">
          <p>{empty?.title ?? "ready when you are"}</p>
          <span>{empty?.hint ?? "Ask for a change, paste an error, or describe what you want to understand."}</span>
        </div>
      {:else}
        {#each shown as item (item.kind === "row" ? item.row.id : `tools:${item.key}`)}
          {#if item.kind === "tools"}
            <!-- A run of tool calls is one folded line: the chat's prose is what
                 is read. Its failures print in error ink on the line; opened,
                 each call is its own strip, as before. -->
            {@const line = groupLine(item.tools)}
            {@const said = toolLine?.(line.named) ?? null}
            {@const named = said ?? [line.named.name, line.named.summary].filter(Boolean).join(" ")}
            <details class="tool-group" class:failed={!!line.failed} open={groupOpen(item, chosen)} ontoggle={(event) => onGroupToggle(event, item)}>
              <summary aria-label={`${line.count}${line.failed ? `, ${line.failed}` : ""}${line.state ? `, ${line.state}` : ""}: ${named}`} title={named}>
                <span class="tool-group-count">{line.count}</span>
                {#if line.failed}<span class="tool-state failure">{line.failed}</span>{/if}
                {#if line.state}<span class="tool-state">{line.state}</span>{/if}
                <span class="tool-group-named">{#if said}<span class="tool-said">{said}</span>{:else}<code class="tool-name">{line.named.name}</code>{#if line.named.summary}<span class="tool-summary">{line.named.summary}</span>{/if}{/if}</span>
                <span class="tool-chevron"><Icon name="chevron" size={12} /></span>
              </summary>
              <div class="tool-group-body">
                {#each item.rows as row (row.id)}{@render rowView(row)}{/each}
              </div>
            </details>
            {#each item.rows as row (row.id)}{@render after?.(row)}{/each}
          {:else}
            {@render rowView(item.row)}
            {@render after?.(item.row)}
          {/if}
        {/each}
        {#if working}
          <div class="working-line" role="status"><ThinkingCube state="working" /><span>working…</span></div>
        {:else if waiting}
          <div class="working-line" role="status"><ThinkingCube state="waiting" /><span>waiting on {status.waiting!.length === 1 ? "a background agent" : `${status.waiting!.length} background agents`}: {status.waiting!.map(description => description.length > 80 ? `${description.slice(0, 79)}…` : description).join(", ")}</span></div>
        {:else if status.state === "stopped"}
          <div class="working-line" role="status">stopped</div>
        {/if}
      {/if}
    </div>
    {@render margin?.()}
    </div>
  </div>

  {#if reconnecting}<div class="conversation-note" role="status">reconnecting to the thread…</div>{/if}
  {#if error || (historyError && !waitingText) || status.state === "failed"}<div class="conversation-error" role="alert">{error ?? (waitingText ? null : historyError) ?? status.error ?? "the run failed"}</div>{/if}
  <form class="composer" aria-busy={busy} onsubmit={(event) => { event.preventDefault(); void submit(); }}
    ondragover={(event) => { if (images && event.dataTransfer?.types.includes("Files")) event.preventDefault(); }} ondrop={onDrop}>
    <span class="sr-only" id="composer-hint">enter to send · shift enter for a new line{images ? " · attach images with the + key, or paste or drop them" : ""}</span>
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

{#snippet rowView(row: TranscriptRow)}
  {#if row.kind === "tool"}
    {@const line = toolLine?.(row) ?? null}
    <details class="tool-strip" data-anchor={rowKey(row)} open={toolOpen(row, chosen)} ontoggle={(event) => onToolToggle(event, row)}>
      <summary title={row.summary || row.name}>
        {#if line}<span class="tool-said">{line}</span><code class="tool-name">{row.name}</code>
        {:else}<code>{row.name}</code>{#if row.summary}<span class="tool-summary">{row.summary}</span>{/if}{/if}
        {#if row.state === "done"}<span class="sr-only">done</span>{:else}<span class="tool-state" class:failure={row.state === "error"}>{toolStateLabel[row.state]}</span>{/if}
        {#if row.input || row.output || row.images}<span class="tool-chevron"><Icon name="chevron" size={12} /></span>{/if}
      </summary>
      {#if row.input}<pre class="tool-input">{row.input}</pre>{/if}
      {#if row.output}<pre>{row.output}</pre>{/if}
      {#if row.images}{@render messageImages(row.images, row.summary || row.name)}{/if}
    </details>
  {:else if row.kind === "user" && row.from}
    <!-- A report is one folded line: the chat's own answer is what is read.
         A failure stands open; opened, the report is whole, as before. -->
    {@const line = reportLine(row.text)}
    {@const title = reportTitle?.(row.from) ?? `thread ${row.from}`}
    <details class="conversation-message report report-line" class:failed={line.failed} data-anchor={rowKey(row)}
      open={reportOpen(row.id, line.failed)} ontoggle={(event) => onReportToggle(event, row.id, line.failed)}>
      <summary aria-label={`report from ${title}${line.state ? `, ${line.state}` : ""}${line.summary ? `: ${line.summary}` : ""}`}>
        <span class="report-title" class:named={reportNamed?.(row.from) ?? false}>{title}</span><span class="report-kind">report</span>
        {#if line.state}<span class="report-state" class:failure={line.failed}>{line.state}</span>{/if}
        {#if line.summary}<span class="report-summary">{line.summary}</span>{/if}
        <span class="tool-chevron"><Icon name="chevron" size={12} /></span>
      </summary>
      <div class="report-body">
        <span class="message-label">{#if reportLabel}{@render reportLabel(row.from)}{:else}thread {row.from}{/if}</span>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown prints raw html as text and allows only http(s)/mailto links -->
        <div class="message-copy markdown">{@html renderMarkdown(row.text)}</div>
      </div>
    </details>
  {:else if row.kind === "user"}
    <article class="conversation-message user" class:sending={row.sending} aria-label="user message" data-anchor={rowKey(row)}>
      {#if !sheet}<span class="message-label">you{#if row.sending}<span class="message-sending"> · sending</span>{/if}</span>
      {:else if row.sending}<span class="message-label message-sending">sending</span>{/if}
      {#if row.images}{@render messageImages(row.images, "")}{/if}
      {#if row.text}<div class="message-copy">{row.text}</div>{/if}
    </article>
  {:else}
    <article class="conversation-message assistant" class:continued={!row.labelled} aria-label={row.reasoning ? "agent reasoning" : "agent message"} data-anchor={rowKey(row)}>
      {#if row.labelled && !sheet}<span class="message-label">agent</span>{/if}
      <!-- a press on an image the thread read opens it; the keys are in the rendered markup -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown prints raw html as text, allows only http(s)/mailto links and shows only images the thread read -->
      <div class="message-copy markdown" class:reasoning={row.reasoning} onclick={onProseClick}>{@html renderMarkdown(row.text, pictureOf(row), { streaming: row.id === streamingId })}</div>
    </article>
  {/if}
{/snippet}

<!-- `subject` names a tool's images (its path); a message's are numbered -->
{#snippet messageImages(list: MessageImage[], subject: string)}
  <ul class="message-images" aria-label={list.length === 1 ? "1 image" : `${list.length} images`}>
    {#each list as image, index (index)}
      {@const label = !subject ? `image ${index + 1} of ${list.length}` : list.length === 1 ? subject : `${subject} · ${index + 1} of ${list.length}`}
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
