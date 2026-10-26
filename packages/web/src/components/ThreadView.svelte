<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import {
    deleteThread,
    errorText,
    fetchThreadModels,
    fetchThreadUsage,
    setThreadModel,
  } from "../lib/api.ts";
  import { CLAUDE_DURABILITY, isClaude, providerLabel } from "../lib/agent.ts";
  import { createArmed } from "../lib/armed.svelte.ts";
  import type { Command } from "../lib/command.ts";
  import { composerWaiting, machineLabel, machineNotice, sleepState, slotReason, stateLabel } from "../lib/thread-state.ts";
  import { startupShown } from "../lib/startup.ts";
  import { COMPACT_MEDIA } from "../lib/keyboard.ts";
  import type {
    SubjectUsage,
    ThreadModels,
    ThreadSummary,
  } from "../lib/types.ts";
  import { BILLED_NOTE, CLAUDE_BILLING, spendText, tokensText } from "../../../server/src/usage.ts";
  import Conversation from "./Conversation.svelte";
  import AuthBadge from "./AuthBadge.svelte";
  import Icon from "./Icon.svelte";
  import StartupPanel from "./StartupPanel.svelte";
  import { pagePanel } from "./PagePanel.svelte";

  let { threadId, threads, command = null, onConsume = () => {}, onNewThread }: {
    threadId: string;
    threads: ThreadSummary[];
    onNewThread: (projectId?: string) => void;
    /** App's `n` shortcut: start a new thread in this thread's project. */
    command?: Command | null;
    onConsume?: (id: number) => void;
  } = $props();

  // Navigation data lives above App.svelte's keyed thread view, so switching
  // remounts the conversation without blanking the persistent chrome.
  const summary = $derived(threads.find((thread) => thread.id === threadId) ?? null);
  // The list this view mounted with may predate a thread created a moment
  // ago; only a list refreshed since can say the thread is gone.
  const threadsAtMount = untrack(() => threads);
  const gone = $derived(summary === null && threads !== threadsAtMount);

  let modelState = $state<ThreadModels | null>(null);
  let changingModel = $state(false);
  let conversationBusy = $state(false);
  let modelError = $state<string | null>(null);
  const modelKey = $derived(modelState?.selected ? JSON.stringify(modelState.selected) : "");
  const selectedModel = $derived(modelState?.models.find((model) =>
    model.provider === modelState?.selected?.provider && model.id === modelState?.selected?.id) ?? null);
  const providers = $derived([...new Set(modelState?.models.map((model) => model.provider) ?? [])]);

  async function loadModels(): Promise<void> {
    modelError = null;
    try {
      const fresh = await fetchThreadModels(threadId);
      if (!disposed) modelState = fresh;
    } catch (cause) {
      if (!disposed) modelError = errorText(cause);
    }
  }

  async function changeModel(event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const selected = modelState?.models.find((model) => JSON.stringify(model) === select.value);
    if (!selected || conversationBusy || changingModel) return;
    changingModel = true;
    modelError = null;
    try {
      const fresh = await setThreadModel(threadId, selected);
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

  // ---- usage: read on open and whenever a run ends ----
  let usage = $state<SubjectUsage | null>(null);
  async function loadUsage(): Promise<void> {
    try {
      const fresh = await fetchThreadUsage(threadId);
      if (!disposed) usage = fresh;
    } catch {
      // the strip simply shows nothing; the usage panels say why
    }
  }
  $effect(() => {
    if (!conversationBusy) untrack(() => void loadUsage());
  });
  const usageText = $derived(!usage ? null : usage.coverage === "unavailable" ? "usage unknown" : spendText(usage.spend));
  const usageTitle = $derived(!usage ? "" : [
    usage.coverage === "unavailable" ? usage.notes.join("\n") : tokensText(usage.spend.tokens),
    usage.unknownTurns ? `${usage.unknownTurns} turns without a usage report are not included` : "",
    ...usage.lines.map((line) => `${line.model}: ${spendText(line.spend)} — ${line.basis}`),
    usage.agent === "claude-code" ? CLAUDE_BILLING : "",
    BILLED_NOTE,
  ].filter(Boolean).join("\n"));

  // ---- the details (project, base, machine, usage, archive, and on a phone
  // the model) fold under the bar's details key; on a phone they fold again
  // when the composer takes focus ----
  let detailsOpen = $state(false);
  const compact = new MediaQuery(COMPACT_MEDIA, false);

  // ---- machine startup: shown while the machine starts and after a start
  // that failed; afterwards the machine label opens it ----
  let startupOpen = $state(false);
  const startupSteps = $derived(summary?.vm?.steps?.length ? summary.vm.steps : null);
  // A failed start's error is printed in full by its step; not twice.
  const startupCarriesError = $derived(!!summary && startupShown(summary) && !!startupSteps?.some((step) => step.state === "failed")
    && summary.failureKind === "allocation");
  // Models could not be read while the machine was not up; read them again once it is.
  $effect(() => {
    if (summary?.state === "ready" && modelError) untrack(() => void loadModels());
  });
  function onPaneFocusin(event: FocusEvent): void {
    if ((event.target as Element).closest(".composer") && compact.current) detailsOpen = false;
  }

  // The view is keyed on threadId: a delete or a new thread navigates
  // away mid-request, and the completion must then touch nothing here.
  let disposed = false;
  const panel = pagePanel();

  // The thread's name takes focus as the thread opens, so a screen reader
  // says where it is and no keyboard rises on a phone. PagePanel focuses it
  // when it opens; a thread opened while the panel is already open (a link
  // in another thread) focuses it here.
  let titleHeading = $state<HTMLElement>();
  let titleFocused = false;
  $effect(() => {
    if (!titleHeading || titleFocused) return;
    titleFocused = true;
    const heading = titleHeading;
    void tick().then(() => {
      if (heading.closest("dialog")?.open && !heading.closest("dialog")?.contains(document.activeElement)) heading.focus({ preventScroll: true });
    });
  });

  onMount(() => {
    void loadModels();
    return () => {
      disposed = true;
      if (noteTimer) clearTimeout(noteTimer);
    };
  });

  // ---- notes: a printed notice under the strip. Errors stay until
  // dismissed; anything else clears itself after a few seconds ----
  let note = $state<{ text: string; href?: string; bad?: boolean } | null>(null);
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  function setNote(next: { text: string; href?: string; bad?: boolean } | null): void {
    if (disposed) return;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = null;
    note = next;
    if (next && !next.bad) noteTimer = setTimeout(() => (note = null), 8000);
  }

  // ---- delete: two presses on the same key, never a dialog ----
  const armed = createArmed();
  let deleting = $state(false);
  async function remove(): Promise<void> {
    if (deleting || !armed.press("thread")) return;
    deleting = true;
    try {
      await deleteThread(threadId);
      location.hash = "#/threads";
    } catch (e) {
      setNote({ text: `archive: ${errorText(e)}`, bad: true });
    } finally {
      if (!disposed) deleting = false;
    }
  }

  // Take the shell's command once: consume it before the action runs, and
  // run the action untracked so its own state (creating, the note) can
  // never re-arm this effect.
  $effect(() => {
    const pending = command;
    if (!pending || pending.kind !== "new-thread") return;
    onConsume(pending.id);
    untrack(() => onNewThread(summary?.project.id));
  });
</script>

{#snippet modelSelect()}
  <label class="strip-model" title={modelState?.selected ? `${modelState.selected.provider}/${modelState.selected.id}` : "choose a model"}>
    <span class="sr-only">model</span>
    <select aria-label="model" value={modelKey} onchange={changeModel} disabled={!modelState || conversationBusy || changingModel || !modelState.models.length}>
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
{/snippet}

{#snippet machine(failedOnly: boolean)}
  {@const label = summary ? machineLabel(summary) : null}
  {#if summary && !!label?.failed === failedOnly}
    {#if startupSteps && !startupShown(summary)}
      <!-- the machine label opens the steps the machine took to start -->
      <button class="strip-machine" class:error={label?.failed}
        title={`${label?.title ?? "the machine is up"}\n\nshow how the machine started`}
        aria-expanded={startupOpen} onclick={() => (startupOpen = !startupOpen)}>{label?.text ?? "machine startup"}</button>
    {:else if label}
      <span class="strip-machine" class:error={label.failed} title={label.title}>{label.text}</span>
    {/if}
  {/if}
{/snippet}

<!-- The thread has the whole sheet: one bar (the way back to the chat, the
     thread's name and what it is doing, the details key), the details folded
     beneath it, then the conversation and composer exactly as the chat's. -->
{#snippet threadBar()}
  <section class="thread-strip thread-bar" class:hidden={!summary} class:details-open={detailsOpen} aria-label="thread controls">
    {#if summary}
      {#if panel}
        <button class="bar-back" type="button" aria-label="back to the chat" title="back to the chat · esc" onclick={panel.close}>
          <Icon name="chevron" size={14} /><span class="bar-back-word" aria-hidden="true">chat</span>
        </button>
      {:else}
        <span></span>
      {/if}
      <div class="bar-title">
        <h1 class="strip-title" class:untitled={!summary.title} bind:this={titleHeading} tabindex="-1" data-panel-focus
          title={summary.title ?? undefined}>{summary.title ?? "untitled"}</h1>
        {#if stateLabel(summary) || machineLabel(summary)?.failed || machineNotice(summary)}
          <p class="bar-sub">
            {#if stateLabel(summary)}
              <span class="strip-state" class:error={summary.state === "error"} class:attention={sleepState(summary)} title={slotReason(summary) ?? undefined}>{stateLabel(summary)}</span>
            {/if}
            {@render machine(true)}
            {#if machineNotice(summary)}
              <span class="strip-state strip-notice attention">{machineNotice(summary)}</span>
            {/if}
          </p>
        {/if}
      </div>
      <div class="bar-end">
        <AuthBadge quiet />
        {#if !compact.current}{@render modelSelect()}{/if}
        <button class="strip-toggle strip-details-key" aria-expanded={detailsOpen} aria-controls="thread-details" onclick={() => (detailsOpen = !detailsOpen)}>
          details<Icon name="chevron" size={12} />
        </button>
      </div>
    {/if}
  </section>
  {#if summary}
    <div class="thread-details" id="thread-details" hidden={!detailsOpen}>
      <div class="thread-details-row">
        <a class="strip-project" href="#/projects/{summary.project.id}">project / {summary.project.name}</a>
        {#if summary.workspaceBase}
          <span class="strip-base" title={`${summary.workspaceBase.remote}\n${summary.workspaceBase.ref}\n${summary.workspaceBase.oid}`}>
            base / {summary.workspaceBase.ref.replace("refs/heads/", "")} @ {summary.workspaceBase.oid.slice(0, 8)}
          </span>
        {/if}
        {@render machine(false)}
        {#if usageText}
          <span class="strip-usage" title={usageTitle} aria-label={`usage: ${usageText}`}>{usageText}</span>
        {/if}
        {#if slotReason(summary)}<span class="strip-state strip-reason">{slotReason(summary)}</span>{/if}
        {#if compact.current}{@render modelSelect()}{/if}
        <span class="spacer"></span>
        {#if armed.is("thread")}
          <span class="bank-note" role="status">workspace released; user changes are retained</span>
        {/if}
        <span class="key-bank">
          <button
            class="key danger"
            class:icon={!armed.is("thread") && !deleting}
            class:armed={armed.is("thread")}
            title={armed.is("thread") ? "press again to archive this thread" : "archive thread"}
            aria-label={armed.is("thread") ? "confirm: archive this thread" : "archive thread"}
            disabled={deleting || conversationBusy}
            onclick={remove}
            onkeydown={armed.onKeydown}
            onblur={() => armed.disarm()}
          >
            {#if deleting}archiving…{:else if armed.is("thread")}archive?{:else}<Icon name="trash" size={13} />{/if}
          </button>
        </span>
      </div>
    </div>
  {/if}
{/snippet}

<main class="thread-workspace">
  <section class="workspace-pane thread-pane" aria-label="thread" onfocusin={onPaneFocusin}>
    {@render threadBar()}
    {#if modelError || (modelState && !selectedModel)}
      <div class="strip-note bad" role="alert">
        <span class="strip-note-text">{modelError ?? (modelState?.models.length ? "selected model is unavailable — choose another model" : "no models available — sign in to a provider")}</span>
        <a class="key" href="#/settings/providers">providers</a>
        <button class="key" onclick={loadModels}>retry models</button>
      </div>
    {/if}
    {#if summary?.error && !startupCarriesError}
      <div class="strip-note bad"><span class="strip-note-text">{summary.error}</span></div>
    {/if}
    {#if note}
      <div class="strip-note" class:bad={note.bad} role={note.bad ? "alert" : "status"}>
        <span class="strip-note-text">
          {note.text}
          {#if note.href}<a href={note.href} target="_blank" rel="noopener noreferrer">{note.href}</a>{/if}
        </span>
        <button class="key icon note-dismiss" title="dismiss" aria-label="dismiss note" onclick={() => setNote(null)}>
          <Icon name="close" size={12} />
        </button>
      </div>
    {/if}
    {#if summary && startupSteps && (startupShown(summary) || startupOpen)}
      <StartupPanel thread={summary} onClose={startupShown(summary) ? null : () => (startupOpen = false)} />
    {/if}
    {#if gone}
      <div class="conversation-gone"><p>this thread is no longer active.</p><a class="key" href="#/threads">back to threads</a></div>
    {:else}
      <Conversation sheet {threadId} model={selectedModel} {changingModel} bind:busy={conversationBusy}
        waitingText={composerWaiting(summary)}
        notice={summary?.agent === "claude-code" || isClaude(modelState?.selected) ? `claude · max — ${CLAUDE_DURABILITY}` : null} />
    {/if}
  </section>
</main>
