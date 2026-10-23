<script lang="ts">
  import { onMount } from "svelte";
  import { CHAT_BASE, errorText, fetchChatModels, fetchChatView, setChatModel } from "../lib/api.ts";
  import { providerLabel } from "../lib/agent.ts";
  import { chatToolLine, latestReports, mentionsOf, resolveArtifact, resolveThread, rowKey, type NoteGroup } from "../lib/provenance.ts";
  import type { TranscriptRow } from "../lib/transcript.ts";
  import type { ArtifactListItem, ThreadModels, ThreadSummary } from "../lib/types.ts";
  import { ChatWork } from "../lib/work.svelte.ts";
  import { workCounts } from "../lib/work-state.ts";
  import AuthBadge from "./AuthBadge.svelte";
  import ChatIndex from "./ChatIndex.svelte";
  import ChatMargin from "./ChatMargin.svelte";
  import Conversation from "./Conversation.svelte";
  import Icon from "./Icon.svelte";
  import Wordmark from "./Wordmark.svelte";
  import WorkNote from "./WorkNote.svelte";

  // OptChat, cube's home: one sheet. The conversation has the screen; what
  // it started (threads) and named (artifacts) stands in the margin beside
  // the message that says so, on a wide screen, or as quiet lines under it
  // on a narrow one. Everything else (every thread, artifacts, projects,
  // settings, the chat's model and memory) is in the index, a step away.
  let { threads = [], threadsLoaded = false }: {
    /** Every thread cubed has, archived ones too (App's poll). */
    threads?: ThreadSummary[];
    /** Whether that list has been read at least once. */
    threadsLoaded?: boolean;
  } = $props();

  let modelState = $state<ThreadModels | null>(null);
  let modelError = $state<string | null>(null);
  let changingModel = $state(false);
  let busy = $state(false);
  let memory = $state<{ view: string; messages: number; failure: string | null } | null>(null);
  let memoryOpen = $state(false);
  let memoryError = $state<string | null>(null);
  let disposed = false;
  const modelKey = $derived(modelState?.selected ? JSON.stringify(modelState.selected) : "");
  const selectedModel = $derived(modelState?.models.find((model) =>
    model.provider === modelState?.selected?.provider && model.id === modelState?.selected?.id) ?? null);
  const providers = $derived([...new Set(modelState?.models.map((model) => model.provider) ?? [])]);

  const work = new ChatWork();
  $effect(() => work.setBusy(busy));
  let index = $state<ChatIndex>();

  // The margin needs the width of the measure and a margin beside it;
  // narrower, the notes go into the conversation. app.css repeats this.
  const WIDE = "(min-width: 76rem)";
  let wide = $state(matchMedia(WIDE).matches);

  // What the rows shown say they started and named, as cube knows it now.
  let rows = $state<TranscriptRow[]>([]);
  const groups = $derived<NoteGroup[]>(mentionsOf(rows).map((mention) => ({
    row: mention.row,
    threads: mention.threads.map((thread) => resolveThread(thread, work.overview, threads, threadsLoaded)),
    // An artifact cube cannot show (a link to one that is not there) gets no note.
    artifacts: mention.artifacts.map((key) => resolveArtifact(key, work.artifacts)).filter((item): item is ArtifactListItem => !!item),
    unstarted: mention.unstarted,
  })).filter((group) => group.threads.length || group.artifacts.length || group.unstarted.length));
  // Inline, an artifact is already a link in the text it is named in: no note twice.
  const inline = $derived(new Map(groups.filter((group) => group.threads.length || group.unstarted.length)
    .map((group) => [group.row, { ...group, artifacts: [] }])));
  const reports = $derived(latestReports(rows));
  const unread = $derived(work.overview ? null : work.error);
  const counts = $derived(workCounts(work.overview?.threads ?? []));
  const keyLabel = $derived(["index: threads, artifacts and settings",
    ...(counts.running ? [`${counts.running} running`] : []), ...(counts.failed ? [`${counts.failed} failed`] : [])].join(" · "));
  let open = $state<string | null>(null);

  const titleOf = (short: string) => resolveThread({ short, project: null, title: null }, work.overview, threads, threadsLoaded).title;
  const toolLine = (row: Extract<TranscriptRow, { kind: "tool" }>) => chatToolLine(row, titleOf);

  /** What a message's note in the margin holds, for its skip key. */
  const skipText = (group: NoteGroup) => {
    const count = (n: number, one: string, many: string) => n ? [`${n} ${n === 1 ? one : many}`] : [];
    return `${[...count(group.threads.length + group.unstarted.length, "thread", "threads"), ...count(group.artifacts.length, "artifact", "artifacts")].join(" and ")} from this message, in the margin`;
  };
  function toNote(row: string): void {
    document.querySelector<HTMLElement>(`.margin-notes > [data-note="${CSS.escape(row)}"] .note-head`)?.focus();
  }

  /** Shows a row of the conversation and puts focus there. */
  function jump(row: string): void {
    const target = document.querySelector<HTMLElement>(`.chat-sheet [data-anchor="${CSS.escape(row)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // a tool line's own key is its summary; a message takes focus as a place, not a stop in the tab order
    const place = target.querySelector<HTMLElement>(":scope > summary") ?? target;
    if (place === target && !target.hasAttribute("tabindex")) target.tabIndex = -1;
    place.focus({ preventScroll: true });
  }

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
    if (memoryOpen) {
      void loadMemory();
      index?.close();
    }
  }

  /** A press that came from a finger (or a pen): the index then opens
   * without raising the on-screen keyboard. A key's press has no detail.
   * The press's own pointer is the one that went down: WebKit reports the
   * click that follows a tap as a mouse's. */
  let lastDown = { type: "", at: -Infinity };
  function tapped(event: MouseEvent): boolean {
    if (event.detail === 0) return false;
    const type = event.timeStamp - lastDown.at < 1500 ? lastDown.type : (event as PointerEvent).pointerType;
    return type === "touch" || type === "pen";
  }

  /** `/` (outside a field) and ctrl/⌘ k open the index. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.shiftKey) {
      event.preventDefault();
      void index?.show();
    } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !target?.closest?.("dialog, input, textarea, select, [contenteditable]")) {
      event.preventDefault();
      void index?.show();
    }
  }

  onMount(() => {
    void loadModels();
    const stopWork = work.start();
    const media = matchMedia(WIDE);
    const onWidth = () => { wide = media.matches; };
    media.addEventListener("change", onWidth);
    // Retry until the chat opens (it needs a connected model first). While
    // a message waits or runs, the memory says whether the compactor is stuck.
    const timer = setInterval(() => {
      if (!modelState) void loadModels();
      else if (busy || memoryOpen || memory?.failure) void loadMemory();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      stopWork();
      media.removeEventListener("change", onWidth);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} onpointerdowncapture={(event) => { lastDown = { type: event.pointerType, at: event.timeStamp }; }} />

<header class="sheet-bar">
  <Wordmark onclick={(event) => void index?.show({ touch: tapped(event) })} label="cube · index: threads, artifacts and settings · press /" />
  <span class="spacer"></span>
  <AuthBadge quiet />
</header>
{#if modelError}
  <div class="strip-note bad" role="alert">
    <span class="strip-note-text">{modelError}</span>
    <a class="key" href="#/settings/providers">providers</a>
    <button class="key" onclick={loadModels}>retry</button>
  </div>
{/if}
{#if memory?.failure}
  <div class="strip-note bad" role="alert"><span class="strip-note-text">{memory.failure} — retrying</span></div>
{/if}
<main class="chat-sheet" aria-labelledby="chat-heading">
  <h1 id="chat-heading" class="sr-only">optchat</h1>
  {#if memoryOpen}
    <section id="chat-memory" class="chat-memory" aria-label="memory">
      <div class="chat-memory-head">
        <span>{memory ? `memory · ${memory.messages} messages · ${memory.view.split("\n").length - 2} lines` : "reading memory…"}</span>
        <button class="key" onclick={loadMemory}>refresh</button>
        <button class="key icon" aria-label="close memory" title="close memory" onclick={() => (memoryOpen = false)}><Icon name="close" size={12} /></button>
      </div>
      {#if memoryError}<p class="chat-memory-error" role="alert">{memoryError}</p>{/if}
      {#if memory}<pre>{memory.view}</pre>{/if}
    </section>
  {/if}
  {#if modelState}
    <Conversation base={CHAT_BASE} steer sheet model={selectedModel} {changingModel} bind:busy onRows={(shown) => (rows = shown)}
      images={modelState.images ?? { supported: false, reason: "this host does not take images in the chat" }}
      placeholder="message optchat" {toolLine} {reportLabel} {after} margin={wide ? margin : undefined} composerStart={workKey}
      empty={{ title: "one chat, every thread", hint: "Say what you want done: the chat starts threads in your projects, follows their reports and remembers everything you said. A thread needs a project; add one under projects." }} />
  {:else}
    <p class="conversation-empty">{modelError ? "connect a model provider to start the chat" : "opening the chat…"}</p>
  {/if}
</main>
<ChatIndex bind:this={index} {work} settings={chatSettings} />

{#snippet reportLabel(from: string)}
  {@const thread = resolveThread({ short: from, project: null, title: null }, work.overview, threads, threadsLoaded)}
  {#if thread.id && !thread.archived}<a class="report-name" href="#/t/{thread.id}">{thread.title ?? `[${from}]`}</a>
  {:else}<span class="report-name">{thread.title ?? `[${from}]`}</span>{/if}<span class="report-kind">· report</span>
{/snippet}

{#snippet after(row: TranscriptRow)}
  {#if !wide}
    {@const group = inline.get(rowKey(row))}
    {#if group}<WorkNote inline {group} {open} onToggle={(key) => (open = key)} {reports} onJump={jump} {unread} />{/if}
  {:else}
    <!-- The margin comes after the whole conversation in reading and tab
         order: this key, shown only while focused, takes a keyboard or a
         screen reader from the message to its note and takes no room. -->
    {@const group = groups.find((item) => item.row === rowKey(row))}
    {#if group}
      <div class="note-skip-holder"><button type="button" class="note-skip" onclick={() => toNote(group.row)}>{skipText(group)}</button></div>
    {/if}
  {/if}
{/snippet}

{#snippet margin()}
  <ChatMargin {groups} {open} onToggle={(key) => (open = key)} {reports} onJump={jump} {unread} />
{/snippet}

{#snippet workKey()}
  <button type="button" class="work-key" aria-haspopup="dialog" aria-label={keyLabel} aria-keyshortcuts="/ Control+K Meta+K"
    title="{keyLabel} · / or ctrl k" onclick={(event) => void index?.show({ touch: tapped(event) })}>
    <Icon name="index" size={16} />
    <!-- the one count that matters most, in words: what failed, else what runs -->
    {#if counts.failed}<span class="work-count failure">{counts.failed} failed</span>
    {:else if counts.running}<span class="work-count">{counts.running} running</span>{/if}
  </button>
{/snippet}

{#snippet chatSettings()}
  <label class="index-model" title={modelState?.selected ? `${modelState.selected.provider}/${modelState.selected.id}` : "choose a model"}>
    <span class="index-label">model</span>
    <select aria-label="model" data-index-item value={modelKey} onchange={changeModel} disabled={!modelState || busy || changingModel || !modelState.models.length}>
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
    {#if busy}<span class="index-quiet">the model changes once the chat is idle</span>{/if}
  </label>
  <button type="button" class="index-memory" data-index-item aria-expanded={memoryOpen} aria-controls="chat-memory" onclick={toggleMemory}>
    <span class="index-label">memory</span><span>{memoryOpen ? "hide what the chat reads each turn" : "show what the chat reads each turn"}</span>
  </button>
{/snippet}
