<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { deleteThread, errorText, fetchProjects, isUnreachable, renameThread } from "../lib/api.ts";
  import { createArmed } from "../lib/armed.svelte.ts";
  import type { Command } from "../lib/command.ts";
  import { lampClass, stateLabel } from "../lib/thread-state.ts";
  import { relTime } from "../lib/time.ts";
  import { createTransient } from "../lib/transient.svelte.ts";
  import type { Project, ThreadSummary } from "../lib/types.ts";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  let {
    threads,
    initialProjectId,
    onThreadsChanged,
    notice = null,
    onDismissNotice = () => {},
    command = null,
    onConsume = () => {},
    onNewThread,
  }: {
    /** App polls the global list; this view only adds projects to it. */
    threads: ThreadSummary[];
    initialProjectId: string | null;
    /** A delete/rename landed — refresh the list now, not on the next poll. */
    onThreadsChanged: () => Promise<void>;
    /** Something the app did on the user's behalf on the way here. */
    notice?: string | null;
    onDismissNotice?: () => void;
    /** App's `n` shortcut: open the composer. */
    command?: Command | null;
    onConsume?: (id: number) => void;
    onNewThread: (projectId?: string) => void;
  } = $props();

  let projects = $state<Project[]>([]);
  // True once the project list has arrived at least once. A failed poll
  // is not an empty list: until then the composer and the empty state
  // say the host has not answered rather than "no projects".
  let loaded = $state(false);
  let unreachable = $state(false);
  let error = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  // The filter IS the URL (#/threads?project=…): back/forward and a
  // project's "n threads" link then agree with the select.
  const selectedFilter = $derived(initialProjectId ?? "");
  const filteredThreads = $derived(
    selectedFilter ? threads.filter((thread) => thread.project.id === selectedFilter) : threads,
  );

  let refreshSeq = 0;
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq;
    try {
      const fresh = await fetchProjects();
      if (seq !== refreshSeq) return;
      projects = fresh;
      if (selectedFilter && !fresh.some((project) => project.id === selectedFilter)) location.hash = "#/threads";
      error = null;
      unreachable = false;
      loaded = true;
    } catch (e) {
      if (seq !== refreshSeq) return;
      // A host that does not answer is the app's strip to report — one
      // quiet line, not a red banner on every view polling it.
      unreachable = isUnreachable(e);
      if (!unreachable) error = errorText(e);
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });

  function setFilter(projectId: string): void {
    location.hash = projectId ? `#/threads?project=${encodeURIComponent(projectId)}` : "#/threads";
  }

  function openComposer(): void {
    onNewThread(selectedFilter || undefined);
  }

  // Take the shell's command once (see lib/command.ts).
  $effect(() => {
    const pending = command;
    if (!pending || pending.kind !== "new-thread") return;
    onConsume(pending.id);
    untrack(openComposer);
  });

  // ---- delete: two presses on the row's own key, never a dialog. One row
  // is armed at a time; the request in flight disables its key ----
  const armed = createArmed();
  let deleting = $state<string | null>(null);
  async function remove(thread: ThreadSummary): Promise<void> {
    if (deleting || !armed.press(thread.id)) return;
    deleting = thread.id;
    try {
      await deleteThread(thread.id);
      actionError = null;
    } catch (e) {
      actionError = `archive: ${errorText(e)}`;
    } finally {
      deleting = null;
    }
    await onThreadsChanged();
  }

  let renaming = $state<string | null>(null);
  let renameText = $state("");
  // "renamed" printed in the row that just was, for a moment.
  const renamed = createTransient();
  function startRename(thread: ThreadSummary): void {
    renaming = thread.id;
    renameText = thread.title ?? "";
  }
  async function commitRename(): Promise<void> {
    const id = renaming;
    if (id === null) return;
    renaming = null;
    const current = threads.find((thread) => thread.id === id);
    const title = renameText.trim();
    if (!title || title === (current?.title ?? "")) return;
    try {
      await renameThread(id, title);
      actionError = null;
      renamed.set(id);
    } catch (e) {
      actionError = `rename: ${errorText(e)}`;
    }
    await onThreadsChanged();
  }
  function onRenameKey(event: KeyboardEvent): void {
    if (event.key === "Enter") commitRename();
    else if (event.key === "Escape") renaming = null;
  }
  const focusSelect = (element: HTMLInputElement) => {
    element.focus();
    element.select();
  };

</script>

<Header section="threads" />
<main class="thread-list">
  <div class="list-head">
    <div>
      <h1>threads</h1>
      <p class="list-intro">all work, across every project</p>
    </div>
      <button class="key primary" onclick={openComposer} title="new thread · press n">
        <Icon name="plus" size={13} />new thread
      </button>
  </div>

  <div class="list-controls">
    <label class="field-inline">
      <span>project</span>
      <select
        aria-label="filter threads by project"
        value={selectedFilter}
        onchange={(event) => setFilter(event.currentTarget.value)}
      >
        <option value="">all projects</option>
        {#each projects as project (project.id)}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    </label>
    <span class="result-count">{filteredThreads.length} {filteredThreads.length === 1 ? "thread" : "threads"}</span>
  </div>

  {#if notice}
    <div class="banner info" role="status">
      <span class="banner-text">{notice}</span>
      <button class="key icon note-dismiss" title="dismiss" aria-label="dismiss note" onclick={onDismissNotice}>
        <Icon name="close" size={12} />
      </button>
    </div>
  {/if}
  {#if error}<div class="banner" role="alert"><span class="banner-text">{error}</span></div>{/if}
  {#if actionError}
    <div class="banner" role="alert">
      <span class="banner-text">{actionError}</span>
      <button class="key icon note-dismiss" title="dismiss" aria-label="dismiss error" onclick={() => (actionError = null)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  {/if}

  {#if filteredThreads.length > 0}
    <div class="well">
      {#each filteredThreads as thread (thread.id)}
        <div class="module">
          {#if renaming === thread.id}
            <div class="module-face">
              <span class="lamp {lampClass(thread)}" aria-hidden="true"></span>
              <span class="module-text">
                <input
                  class="rename-input"
                  aria-label="thread title"
                  bind:value={renameText}
                  onkeydown={onRenameKey}
                  onblur={commitRename}
                  use:focusSelect
                />
                <span class="module-meta">
                  <span class="module-project">project / {thread.project.name}</span>
                  {#if thread.createdAt}<span>{relTime(thread.createdAt)}</span>{/if}
                </span>
              </span>
            </div>
          {:else}
            <a class="module-face" href="#/t/{thread.id}">
              <span class="lamp {lampClass(thread)}" aria-hidden="true"></span>
              {#if !stateLabel(thread)}<span class="sr-only">ready</span>{/if}
              <span class="module-text">
                <span class="module-title" class:untitled={!thread.title}>{thread.title ?? "untitled"}</span>
                <span class="module-meta">
                  <span class="module-project">project / {thread.project.name}</span>
                  {#if thread.createdAt}<span>{relTime(thread.createdAt)}</span>{/if}
                  {#if stateLabel(thread)}
                    <span class="state-label" class:error={thread.state === "error"}>{stateLabel(thread)}</span>
                  {/if}
                  {#if renamed.value === thread.id}<span class="state-label" role="status">renamed</span>{/if}
                </span>
                {#if thread.error}<span class="module-error">{thread.error}</span>{/if}
              </span>
            </a>
          {/if}
          <div class="module-actions">
            <button class="key icon" title="rename thread" aria-label="rename thread" onclick={() => startRename(thread)}>
              <Icon name="pencil" size={13} />
            </button>
            <button
              class="key danger"
              class:icon={!armed.is(thread.id) && deleting !== thread.id}
              class:armed={armed.is(thread.id)}
              title={armed.is(thread.id) ? "press again to archive this thread" : "archive thread"}
              aria-label={armed.is(thread.id) ? "confirm: archive this thread" : "archive thread"}
              disabled={deleting === thread.id}
              onclick={() => remove(thread)}
              onkeydown={armed.onKeydown}
              onblur={() => armed.disarm()}
            >
              {#if deleting === thread.id}archiving…{:else if armed.is(thread.id)}archive?{:else}<Icon name="trash" size={13} />{/if}
            </button>
          </div>
          {#if armed.is(thread.id)}
            <!-- a sibling of the face and the bank: beside them on a wide
                 panel, beneath the row on a phone, never over the title -->
            <span class="module-note bank-note" role="status">removed from active threads; the runner workspace is kept</span>
          {/if}
        </div>
      {/each}
    </div>
  {:else if loaded && !error}
    <div class="empty-state">
      {#if projects.length === 0}
        <p class="hint">Projects prepare repositories before work starts.<br />Configure the first one to begin.</p>
        <a class="key primary" href="#/projects/new"><Icon name="plus" size={13} />new project</a>
      {:else if selectedFilter}
        <p class="hint">No threads in this project yet.</p>
        <button class="key primary" onclick={openComposer}><Icon name="plus" size={13} />new thread</button>
      {:else}
        <p class="hint">Every thread starts from a checked project snapshot.<br />Start one and just ask.</p>
        <button class="key primary" onclick={openComposer}><Icon name="plus" size={13} />new thread</button>
      {/if}
      <p class="shortcuts"><kbd>n</kbd> new thread · <kbd>g</kbd> <kbd>t</kbd> threads · <kbd>g</kbd> <kbd>p</kbd> projects</p>
    </div>
  {:else if !loaded}
    <!-- no threads and no answer about projects yet: not an empty box -->
    <div class="empty-state" role="status">
      <p class="hint">{unreachable ? "can't reach the host — it may be starting or restarting" : "reading projects…"}{#if unreachable}<br />retrying…{/if}</p>
      {#if unreachable || error}<button class="key" onclick={refresh}>retry now</button>{/if}
    </div>
  {/if}
</main>
