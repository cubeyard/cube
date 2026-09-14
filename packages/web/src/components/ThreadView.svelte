<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import {
    deleteThread,
    errorText,
    fetchFiles,
    fetchRepositories,
    fetchServices,
    fetchThreadModels,
    fileUrl,
    setThreadModel,
  } from "../lib/api.ts";
  import { createArmed } from "../lib/armed.svelte.ts";
  import { fmtBytes } from "../lib/bytes.ts";
  import type { Command } from "../lib/command.ts";
  import { lampClass, stateLabel, waitingText } from "../lib/thread-state.ts";
  import { relTime } from "../lib/time.ts";
  import type {
    ServiceLink,
    ThreadModels,
    ThreadRepository,
    ThreadSummary,
    WorkspaceListing,
  } from "../lib/types.ts";
  import ChangesPane from "./ChangesPane.svelte";
  import Conversation from "./Conversation.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  let { threadId, threads, command = null, onConsume = () => {}, onNewThread }: {
    threadId: string;
    threads: ThreadSummary[];
    onNewThread: (projectId?: string) => void;
    /** App's `n` shortcut: start a new thread in this thread's project. */
    command?: Command | null;
    onConsume?: (id: number) => void;
  } = $props();

  // ---- workspace split: draggable on desktop, remembered per browser ----
  const SPLIT_STORAGE_KEY = "cube.threadSplitPercent";
  let workspaceElement: HTMLElement;
  let splitPercent = $state(50);
  let resizing = $state(false);

  function clampSplit(percent: number): number {
    const width = workspaceElement?.getBoundingClientRect().width ?? 0;
    const minimum = width > 0 ? Math.min(45, Math.max(20, (224 / width) * 100)) : 20;
    return Math.min(100 - minimum, Math.max(minimum, percent));
  }

  function setSplit(percent: number, persist = false): void {
    splitPercent = clampSplit(percent);
    if (persist) localStorage.setItem(SPLIT_STORAGE_KEY, String(splitPercent));
  }

  function resizeFromPointer(event: PointerEvent): void {
    const bounds = workspaceElement.getBoundingClientRect();
    setSplit(((event.clientX - bounds.left) / bounds.width) * 100);
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    resizeFromPointer(event);
  }

  function moveResize(event: PointerEvent): void {
    if (resizing) resizeFromPointer(event);
  }

  function finishResize(event: PointerEvent): void {
    if (!resizing) return;
    resizeFromPointer(event);
    resizing = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    setSplit(splitPercent, true);
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 5 : 2;
    const next =
      event.key === "ArrowLeft" ? splitPercent - step
      : event.key === "ArrowRight" ? splitPercent + step
      : event.key === "Home" ? 20
      : event.key === "End" ? 80
      : event.key === "Enter" ? 50
      : null;
    if (next === null) return;
    event.preventDefault();
    setSplit(next, true);
  }

  // Navigation data lives above App.svelte's keyed thread view, so switching
  // remounts the conversation without blanking the persistent chrome.
  const summary = $derived(threads.find((thread) => thread.id === threadId) ?? null);
  // The list this view mounted with may predate a thread created a moment
  // ago; only a list refreshed since can say the thread is gone.
  const threadsAtMount = untrack(() => threads);
  const gone = $derived(summary === null && threads !== threadsAtMount);

  const projectGroups = $derived.by(() => {
    const groups = new SvelteMap<string, { project: ThreadSummary["project"]; threads: ThreadSummary[] }>();
    for (const thread of threads) {
      let group = groups.get(thread.project.id);
      if (!group) {
        group = { project: thread.project, threads: [] };
        groups.set(thread.project.id, group);
      }
      group.threads.push(thread);
    }
    return [...groups.values()];
  });

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

  // ---- the mobile thread drawer: opened from the strip, closed by its key,
  // the scrim, or Escape; focus goes in with it and back to the opener ----
  let threadSidebarOpen = $state(false);
  let sidebarOpener: HTMLElement | null = null;
  let sidebarClose = $state<HTMLButtonElement>();
  async function openSidebar(event: MouseEvent): Promise<void> {
    sidebarOpener = event.currentTarget as HTMLElement;
    threadSidebarOpen = true;
    await tick();
    sidebarClose?.focus();
  }
  function closeSidebar(): void {
    if (!threadSidebarOpen) return;
    threadSidebarOpen = false;
    sidebarOpener?.focus();
    sidebarOpener = null;
  }

  let repositories = $state<ThreadRepository[]>([]);
  let repositoriesReady = $state(false);
  let repositoriesError = $state<string | null>(null);
  const primaryRepository = $derived(
    repositories.find((repository) => repository.role === "primary") ?? null,
  );
  async function refreshRepositories(): Promise<void> {
    try {
      repositories = await fetchRepositories(threadId);
      repositoriesReady = true;
      repositoriesError = null;
    } catch (error) {
      // Mid-delete or setup — retain the last known repository bank.
      if (!repositoriesReady) repositoriesError = errorText(error);
    }
  }

  let services = $state<ServiceLink[]>([]);
  async function refreshServices(): Promise<void> {
    try {
      services = await fetchServices(threadId);
    } catch {
      // Keep the last good links through a transient error or a cube.toml
      // caught mid-edit — the strip must not flicker.
    }
  }

  // The view is keyed on threadId: a delete or a new thread navigates
  // away mid-request, and the completion must then touch nothing here.
  let disposed = false;

  onMount(() => {
    const savedSplit = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
    if (Number.isFinite(savedSplit) && savedSplit > 0) setSplit(savedSplit);
    refreshRepositories();
    refreshServices();
    void loadModels();
    const slow = setInterval(() => {
      refreshRepositories();
      refreshServices();
    }, 10_000);
    return () => {
      disposed = true;
      clearInterval(slow);
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

  // ---- workspace manifest shelf; git changes have their own fixed pane ----
  let filesOpen = $state(false);
  let filesKey = $state<HTMLButtonElement>();
  let files = $state<WorkspaceListing | null>(null);
  let filesError = $state<string | null>(null);

  function loadFiles(): void {
    files = null;
    filesError = null;
    fetchFiles(threadId).then(
      (fresh) => (files = fresh),
      (e) => (filesError = errorText(e)),
    );
  }

  function toggleFiles(): void {
    filesOpen = !filesOpen;
    if (filesOpen) loadFiles();
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
      setNote({ text: `delete: ${errorText(e)}`, bad: true });
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

  // Escape closes the topmost overlay — drawer, then files shelf — and hands
  // focus back to the key that opened it. Native fields keep their Escape.
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("dialog, input, textarea, select")) return;
    if (threadSidebarOpen) {
      event.preventDefault();
      closeSidebar();
    } else if (filesOpen) {
      event.preventDefault();
      filesOpen = false;
      filesKey?.focus();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet threadControls()}
  <section class="thread-strip" class:hidden={!summary} aria-label="thread controls">
    {#if summary}
      <span class="lamp {lampClass(summary)}" aria-hidden="true"></span>
      <span class="strip-title" class:untitled={!summary.title}>{summary.title ?? "untitled"}</span>
      <button
        class="mobile-thread-switch"
        class:untitled={!summary.title}
        aria-label="open threads"
        aria-expanded={threadSidebarOpen}
        aria-controls="thread-sidebar"
        onclick={openSidebar}
      >
        <span>{summary.title ?? "untitled"}</span>
        <Icon name="chevron" size={12} />
      </button>
      <a class="strip-project" href="#/projects/{summary.project.id}">project / {summary.project.name}</a>
      {#if stateLabel(summary)}
        <span class="strip-state" class:error={summary.state === "error"}>{stateLabel(summary)}</span>
      {/if}
      <span class="spacer"></span>
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
            <optgroup label={provider}>
              {#each modelState?.models.filter((model) => model.provider === provider) ?? [] as model}
                <option value={JSON.stringify(model)}>{model.id}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <Icon name="chevron" size={12} />
      </label>
      {#if services.length > 0}
        <span class="strip-services">
          {#each services as service (service.name)}
            <a class="strip-link" href={service.url} target="_blank" rel="noopener noreferrer">{service.name}</a>
          {/each}
        </span>
      {/if}
      {#if armed.is("thread")}
        <!-- honest about what a delete does right now: mid-setup it also
             cancels the setup that is running -->
        <span class="bank-note" role="status">{summary?.state === "setting-up" ? "setup is cancelled; workspace and history are destroyed; the project is kept" : "workspace and history are destroyed; the project is kept"}</span>
      {/if}
      <span class="key-bank">
        <button
          class="key icon"
          bind:this={filesKey}
          title="workspace files"
          aria-label="workspace files"
          class:held={filesOpen}
          aria-expanded={filesOpen}
          onclick={toggleFiles}
        >
          <Icon name="file" size={13} />
        </button>
        <button
          class="key danger"
          class:icon={!armed.is("thread") && !deleting}
          class:armed={armed.is("thread")}
          title={armed.is("thread") ? "press again to delete this thread" : "delete thread"}
          aria-label={armed.is("thread") ? "confirm: delete this thread" : "delete thread"}
          disabled={deleting}
          onclick={remove}
          onkeydown={armed.onKeydown}
          onblur={() => armed.disarm()}
        >
          {#if deleting}deleting…{:else if armed.is("thread")}delete?{:else}<Icon name="trash" size={13} />{/if}
        </button>
      </span>
    {/if}
  </section>
{/snippet}

<div class="thread-body">
  {#if threadSidebarOpen}
    <button
      class="thread-sidebar-scrim"
      aria-label="close threads"
      onclick={closeSidebar}
    ></button>
  {/if}

  <aside id="thread-sidebar" class="thread-sidebar" class:open={threadSidebarOpen} aria-label="threads">
    <div class="thread-navigation"><Header section="threads" /></div>
    <div class="sidebar-actions">
      <button class="sidebar-create" onclick={() => onNewThread()} aria-label="new thread" title="new thread · press n"><Icon name="plus" size={14} />thread</button>
      <button class="key sidebar-close" bind:this={sidebarClose} onclick={closeSidebar}>close</button>
    </div>

    {#if threads.length > 0}
      <nav class="thread-sidebar-list" aria-label="active threads">
        {#each projectGroups as group (group.project.id)}
          <section class="sidebar-project" aria-label={group.project.name}>
            <div class="sidebar-project-head">
              <a href="#/projects/{group.project.id}" title={group.project.name}>{group.project.name}</a>
              <span class="project-rule" aria-hidden="true"></span>
              <button
                class="sidebar-project-new"
                title={`new thread in ${group.project.name}`}
                aria-label={`new thread in ${group.project.name}`}
                onclick={() => onNewThread(group.project.id)}
              ><Icon name="plus" size={14} /></button>
            </div>
        {#each group.threads as thread (thread.id)}
          <a
            class="thread-sidebar-row"
            class:current={thread.id === threadId}
            href="#/t/{thread.id}"
            aria-current={thread.id === threadId ? "page" : undefined}
          >
            <span class="lamp {lampClass(thread)}" aria-hidden="true"></span>
            {#if !stateLabel(thread)}<span class="sr-only">ready</span>{/if}
            <span class="thread-sidebar-copy">
              <span class="thread-sidebar-title" class:untitled={!thread.title}>{thread.title ?? "untitled"}</span>
              {#if stateLabel(thread)}
                <span class="thread-sidebar-meta"><span class:error={thread.state === "error"}>{stateLabel(thread)}</span></span>
              {/if}
            </span>
          </a>
        {/each}
          </section>
        {/each}
      </nav>
    {:else}
      <p class="thread-sidebar-empty">no active threads</p>
    {/if}
  </aside>

  <div class="thread-stage">
{#if modelError || (modelState && !selectedModel)}
  <div class="strip-note bad" role="alert">
    <span class="strip-note-text">{modelError ?? (modelState?.models.length ? "selected model is unavailable — choose another model" : "no models available — sign in to a provider")}</span>
    <button class="key" onclick={loadModels}>retry models</button>
  </div>
{/if}
{#if waitingText(summary)}
  <div class="strip-note wait" role="status">
    <span class="lamp on-amber blink" aria-hidden="true"></span>
    <span class="strip-note-text">{waitingText(summary)}</span>
  </div>
{/if}
{#if summary?.error}
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

{#if filesOpen}
  <aside class="files-shelf" aria-label="workspace files">
    {#if filesError}
      <div class="files-note bad">
        <span>files unavailable — {filesError}</span>
        <button class="key" onclick={loadFiles}>retry</button>
      </div>
    {:else if !files}
      <p class="files-note">reading files…</p>
    {:else if files.files.length === 0}
      <p class="files-note">No files yet — this thread's primary workspace is empty.</p>
    {:else}
      <p class="files-head">
        primary workspace · {files.files.length}{files.truncated ? "+" : ""}
        {files.files.length === 1 && !files.truncated ? "file" : "files"}
        · {fmtBytes(files.totalBytes)} on disk
      </p>
      <ul class="files-list">
        {#each files.files as file (file.path)}
          <li>
            <a href={fileUrl(threadId, file.path)} target="_blank" rel="noopener noreferrer">
              <span class="file-path">{file.path}</span>
              <span class="file-meta">{fmtBytes(file.size)} · {relTime(file.mtime)}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>
{/if}

<main
  class="thread-workspace"
  class:resizing
  bind:this={workspaceElement}
  style={`--thread-pane-width: ${splitPercent}%`}
>
  <section class="workspace-pane thread-pane" aria-label="thread">
    {@render threadControls()}
    {#if gone}
      <div class="conversation-gone"><p>this thread was deleted.</p><a class="key" href="#/threads">back to threads</a></div>
    {:else}
      <Conversation {threadId} model={selectedModel} {changingModel} bind:busy={conversationBusy} waitingText={waitingText(summary)} />
    {/if}
  </section>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: an adjustable ARIA separator is keyboard-interactive -->
  <div
    class="workspace-splitter"
    role="separator"
    aria-label="resize thread and changes panes"
    aria-orientation="vertical"
    aria-valuemin="20"
    aria-valuemax="80"
    aria-valuenow={Math.round(splitPercent)}
    tabindex="0"
    title="drag to resize · arrow keys adjust · enter resets"
    onpointerdown={startResize}
    onpointermove={moveResize}
    onpointerup={finishResize}
    onpointercancel={() => (resizing = false)}
    onkeydown={resizeWithKeyboard}
  ><span aria-hidden="true"></span></div>

  <ChangesPane
    {threadId}
    repository={primaryRepository}
    {repositoriesReady}
    {repositoriesError}
    onRetryRepositories={refreshRepositories}
  />
</main>
  </div>
</div>
