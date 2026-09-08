<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    createUserThread,
    deleteThread,
    fetchProjects,
    fetchThreads,
    renameThread,
  } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { Project, ThreadSummary } from "../lib/types.ts";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  let {
    initialProjectId,
  }: {
    initialProjectId: string | null;
  } = $props();

  let threads = $state<ThreadSummary[]>([]);
  let projects = $state<Project[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let creating = $state(false);
  let selectedFilter = $state(untrack(() => initialProjectId ?? ""));
  const filteredThreads = $derived(
    selectedFilter ? threads.filter((thread) => thread.project.id === selectedFilter) : threads,
  );
  const readyProjects = $derived(projects.filter((project) => project.status === "ready"));

  let refreshSeq = 0;
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq;
    try {
      const [freshThreads, freshProjects] = await Promise.all([fetchThreads(), fetchProjects()]);
      if (seq !== refreshSeq) return;
      threads = freshThreads;
      projects = freshProjects;
      if (selectedFilter && !freshProjects.some((project) => project.id === selectedFilter)) {
        selectedFilter = "";
      }
      error = null;
    } catch (e) {
      if (seq !== refreshSeq) return;
      error = String(e);
    }
    loaded = true;
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });

  function setFilter(projectId: string): void {
    selectedFilter = projectId;
    location.hash = projectId
      ? `#/threads?project=${encodeURIComponent(projectId)}`
      : "#/threads";
  }

  let composing = $state(false);
  let selectedProjectId = $state("");
  function openComposer(): void {
    composing = true;
    selectedProjectId =
      readyProjects.find((project) => project.id === selectedFilter)?.id ?? readyProjects[0]?.id ?? "";
    actionError = null;
  }

  async function newThread(): Promise<void> {
    if (creating || !selectedProjectId) return;
    creating = true;
    try {
      const id = await createUserThread(selectedProjectId);
      location.hash = `#/t/${encodeURIComponent(id)}`;
    } catch (e) {
      actionError = `new thread: ${e instanceof Error ? e.message : e}`;
    } finally {
      creating = false;
    }
  }

  async function remove(thread: ThreadSummary): Promise<void> {
    if (!confirm(`Delete thread "${thread.title ?? "untitled"}"? Its environment is destroyed and the thread disappears; workspace files remain on the host.`)) return;
    try {
      await deleteThread(thread.id);
      actionError = null;
    } catch (e) {
      actionError = `delete: ${e instanceof Error ? e.message : e}`;
    }
    refresh();
  }

  let renaming = $state<string | null>(null);
  let renameText = $state("");
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
    if (current) current.title = title;
    try {
      await renameThread(id, title);
      actionError = null;
    } catch (e) {
      actionError = `rename: ${e instanceof Error ? e.message : e}`;
    }
    refresh();
  }
  function onRenameKey(event: KeyboardEvent): void {
    if (event.key === "Enter") commitRename();
    else if (event.key === "Escape") renaming = null;
  }
  const focusSelect = (element: HTMLInputElement) => {
    element.focus();
    element.select();
  };

  const lampClass = (thread: ThreadSummary) =>
    thread.busy || thread.state === "setting-up" ? "on-amber blink"
    : thread.state === "error" ? "on-red"
    : thread.state === "sleeping" ? "off"
    : "on-green";

  const stateLabel = (thread: ThreadSummary) =>
    thread.busy ? "working"
    : thread.state === "setting-up" ? "setting up"
    : thread.state === "sleeping" ? "sleeping"
    : thread.state === "error" ? "error"
    : null;
</script>

<Header section="threads" />
<main class="thread-list">
  <div class="list-head">
    <div>
      <h1>threads</h1>
      <p class="list-intro">all work, across every project</p>
    </div>
    {#if !composing}
      <button class="key primary" onclick={openComposer}>
        <Icon name="plus" size={13} />new thread
      </button>
    {/if}
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

  {#if error}<div class="banner">{error}</div>{/if}
  {#if actionError}<div class="banner">{actionError}</div>{/if}

  {#if composing}
    <div class="compose well">
      {#if readyProjects.length > 0}
        <label class="compose-field">
          <span class="silk">project</span>
          <select class="compose-input" bind:value={selectedProjectId} aria-label="project for new thread">
            {#each projects as project (project.id)}
              <option value={project.id} disabled={project.status !== "ready"}>
                {project.name}{project.status === "ready" ? "" : ` — ${project.status}`}
              </option>
            {/each}
          </select>
        </label>
        <p class="compose-note">The checked repository snapshot is mounted before the thread starts.</p>
        <div class="compose-keys">
          <button class="key primary" onclick={newThread} disabled={creating || !selectedProjectId}>
            {creating ? "starting…" : "start"}
          </button>
          <button class="key" onclick={() => (composing = false)} disabled={creating}>cancel</button>
        </div>
      {:else}
        <p class="compose-note">A ready project is required before a thread can start.</p>
        <div class="compose-keys">
          <a class="key primary" href="#/projects/new">configure project</a>
          <button class="key" onclick={() => (composing = false)}>cancel</button>
        </div>
      {/if}
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
            <a class="module-face" href="#/t/{encodeURIComponent(thread.id)}">
              <span class="lamp {lampClass(thread)}" aria-hidden="true"></span>
              {#if !stateLabel(thread)}<span class="sr-only">ready</span>{/if}
              <span class="module-text">
                <span class="module-title" class:untitled={!thread.title}>{thread.title ?? "untitled"}</span>
                <span class="module-meta">
                  <span class="module-project">project / {thread.project.name}</span>
                  {#if thread.createdAt}<span>{relTime(thread.createdAt)}</span>{/if}
                  {#if stateLabel(thread)}
                    <span class="state-label" class:error={thread.state === "error" && !thread.busy}>{stateLabel(thread)}</span>
                  {/if}
                  {#if thread.error}<span class="module-error" title={thread.error}>{thread.error}</span>{/if}
                </span>
              </span>
            </a>
          {/if}
          <div class="module-actions">
            <button class="key icon" title="rename thread" aria-label="rename thread" onclick={() => startRename(thread)}>
              <Icon name="pencil" size={13} />
            </button>
            <button class="key icon danger" title="delete thread" aria-label="delete thread" onclick={() => remove(thread)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {:else if loaded && !error && !composing}
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
    </div>
  {/if}
</main>
