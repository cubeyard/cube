<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    createUserThread,
    deleteThread,
    errorText,
    fetchDiff,
    fetchFiles,
    fetchRepositories,
    fetchServices,
    fileUrl,
  } from "../lib/api.ts";
  import { fmtBytes } from "../lib/bytes.ts";
  import { lampClass, stateLabel } from "../lib/thread-state.ts";
  import { relTime } from "../lib/time.ts";
  import type {
    RepoDiff,
    ServiceLink,
    ThreadRepository,
    ThreadSummary,
    WorkspaceListing,
  } from "../lib/types.ts";
  import ChangesPane from "./ChangesPane.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import Terminal from "./Terminal.svelte";

  let { threadId, threads }: { threadId: string; threads: ThreadSummary[] } = $props();
  let terminalPane = $state<{ submitPrompt: (text: string) => boolean } | null>(null);

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
  // remounts the PTY without blanking or resizing the persistent chrome.
  const summary = $derived(threads.find((thread) => thread.id === threadId) ?? null);
  let threadSidebarOpen = $state(false);
  // The list this view mounted with may predate a thread created a moment
  // ago; only a list refreshed since can say the thread is gone.
  const threadsAtMount = untrack(() => threads);
  const gone = $derived(summary === null && threads !== threadsAtMount);

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
      if (!repositoriesReady) repositoriesError = error instanceof Error ? error.message : String(error);
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

  onMount(() => {
    const savedSplit = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
    if (Number.isFinite(savedSplit) && savedSplit > 0) setSplit(savedSplit);
    refreshRepositories();
    refreshServices();
    const slow = setInterval(() => {
      refreshRepositories();
      refreshServices();
    }, 10_000);
    return () => {
      clearInterval(slow);
    };
  });

  let note = $state<{ text: string; href?: string; bad?: boolean } | null>(null);

  // ---- workspace manifest shelf; git changes have their own fixed pane ----
  let filesOpen = $state(false);
  let files = $state<WorkspaceListing | null>(null);
  let filesError = $state<string | null>(null);

  type ShipPhase = "closed" | "checking" | "ready" | "blocked" | "sending" | "sent" | "error";
  type ShipPreflight = { repository: ThreadRepository; diff: RepoDiff };
  let shipPhase = $state<ShipPhase>("closed");
  let shipPreflight = $state<ShipPreflight | null>(null);
  let shipError = $state<string | null>(null);
  let shipAttempt = 0;

  const shipBusy = $derived(shipPhase === "checking" || shipPhase === "sending");
  const shipStatus = $derived(
    shipPhase === "checking" ? "checking working copy"
    : shipPhase === "ready" ? "ready to ship"
    : shipPhase === "blocked" ? "ship blocked"
    : shipPhase === "sending" ? "sending to agent"
    : shipPhase === "sent" ? "agent shipping"
    : shipPhase === "error" ? "ship failed"
    : "ship",
  );

  const SHIP_PROMPT = `Ship all committed and uncommitted changes to origin/main. Commit any uncommitted changes before pushing. If push fails because origin/main is ahead, rebase and resolve merge conflicts, checking with me before proceeding if there are any substantive conflicts, then push again. If rebasing floods add/add conflicts in unrelated files, run \`git rebase --abort\`, \`git fetch --unshallow origin\`, then rebase again. Fetch origin and rebase onto latest origin/main, then run the full test suite before pushing. Do not repeat it after a later fetch, rebase, or rejected push unless conflict resolution or other local edits changed files after the successful test run. Ignore a failing check from the test suite only after verifying that the same check also fails on origin/main without this thread's changes. When done, archive the current thread and any threads you created that are neither needed nor running. This archive step applies only to this Ship request: if I send new instructions afterward, drop it and do not archive unless I ask again.`;

  function shipBlock(preflight: ShipPreflight): string | null {
    const { repository, diff: publishDiff } = preflight;
    if (!repository.state) return "This checkout is still setting up. Check again when it is ready.";
    if (!repository.state.branch) return "This checkout has a detached HEAD. Switch to a branch before shipping.";
    if (repository.base !== "main") {
      return `This repository is configured with ${repository.base} as its base, but Ship publishes to origin/main. Change the project base before shipping.`;
    }
    if (repository.state.ahead < 1 && !publishDiff.dirty) {
      return `There are no committed or working-copy changes to ship from ${repository.state.branch}.`;
    }
    return null;
  }

  async function checkShip(): Promise<ShipPreflight | null> {
    if (!primaryRepository || shipBusy) return null;
    const repositoryId = primaryRepository.id;
    const attempt = ++shipAttempt;
    filesOpen = false;
    shipPhase = "checking";
    shipError = null;
    try {
      const [freshRepositories, freshDiff] = await Promise.all([
        fetchRepositories(threadId),
        fetchDiff(threadId, repositoryId),
      ]);
      if (attempt !== shipAttempt) return null;
      repositories = freshRepositories;
      const repository = freshRepositories.find((candidate) => candidate.role === "primary");
      if (!repository || repository.id !== repositoryId) {
        throw new Error("primary repository is no longer attached to this thread");
      }
      const preflight = { repository, diff: freshDiff };
      shipPreflight = preflight;
      shipPhase = shipBlock(preflight) ? "blocked" : "ready";
      return preflight;
    } catch (e) {
      if (attempt !== shipAttempt) return null;
      shipError = errorText(e);
      shipPhase = "error";
      return null;
    }
  }

  function closeShip(): void {
    if (shipBusy) return;
    shipAttempt += 1;
    shipPhase = "closed";
    shipPreflight = null;
    shipError = null;
  }

  async function ship(): Promise<void> {
    if (shipBusy || !shipPreflight) return;
    // Re-run preflight immediately before handing control to the agent. The
    // live terminal may have changed the worktree while review was open.
    const preflight = await checkShip();
    if (!preflight || shipBlock(preflight)) return;
    if (summary?.busy) {
      shipError = "The agent is already working. Wait for the current turn to finish, then retry Ship.";
      shipPhase = "error";
      return;
    }
    const repository = preflight.repository;
    const context = `Work in /workspace. This is the primary repository, id ${repository.id}; use the code tool with cube.git.syncBase(${repository.id}) and cube.git.pushBase(${repository.id}) for authenticated fetch and push. The configured base is origin/${repository.base}. Additional repositories under /repos are read-only references and must not be changed.`;
    shipPhase = "sending";
    if (!terminalPane?.submitPrompt(`${context}\n\n${SHIP_PROMPT}`)) {
      shipError = "The agent terminal is not connected. Reconnect it, then retry Ship.";
      shipPhase = "error";
      return;
    }
    shipPhase = "sent";
  }

  function toggleFiles(): void {
    filesOpen = !filesOpen;
    if (filesOpen) {
      files = null;
      filesError = null;
      fetchFiles(threadId).then(
        (fresh) => (files = fresh),
        (e) => (filesError = errorText(e)),
      );
    }
  }

  async function remove(): Promise<void> {
    if (!confirm("Delete this thread? Its environment is destroyed and the conversation ends; workspace files remain on the host.")) return;
    try {
      await deleteThread(threadId);
      location.hash = "#/threads";
    } catch (e) {
      note = { text: `delete: ${errorText(e)}`, bad: true };
    }
  }

  let creating = $state(false);
  async function newThread(): Promise<void> {
    if (!summary || creating) return;
    creating = true;
    try {
      const id = await createUserThread(summary.project.id);
      location.hash = `#/t/${id}`;
    } catch (e) {
      note = { text: `new thread: ${errorText(e)}`, bad: true };
    } finally {
      creating = false;
    }
  }
</script>

<div class="thread-topbar">
  <Header section="threads" />

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
        onclick={() => (threadSidebarOpen = true)}
      >
        <span>{summary.title ?? "untitled"}</span>
        <Icon name="chevron" size={12} />
      </button>
      <a class="strip-project" href="#/projects/{summary.project.id}">project / {summary.project.name}</a>
      {#if stateLabel(summary)}
        <span class="strip-state" class:error={summary.state === "error"}>{stateLabel(summary)}</span>
      {/if}
      <span class="spacer"></span>
      {#if services.length > 0}
        <span class="strip-services">
          {#each services as service (service.name)}
            <a class="strip-link" href={service.url} target="_blank" rel="noopener noreferrer">{service.name}</a>
          {/each}
        </span>
      {/if}
      <button
        class="key primary ship-key"
        aria-expanded={shipPhase !== "closed"}
        onclick={checkShip}
        disabled={!primaryRepository || shipBusy || shipPhase === "sent" || summary?.busy || !primaryRepository.state}
      >{shipStatus}</button>
      <span class="key-bank">
        <button class="key icon" title="workspace files" aria-label="workspace files" class:held={filesOpen} aria-expanded={filesOpen} onclick={toggleFiles}>
          <Icon name="file" size={13} />
        </button>
        <button class="key icon danger" title="delete thread" aria-label="delete thread" onclick={remove}>
          <Icon name="trash" size={13} />
        </button>
      </span>
    {/if}
  </section>
</div>

<div class="thread-body">
  {#if threadSidebarOpen}
    <button
      class="thread-sidebar-scrim"
      aria-label="close threads"
      onclick={() => (threadSidebarOpen = false)}
    ></button>
  {/if}

  <aside id="thread-sidebar" class="thread-sidebar" class:open={threadSidebarOpen} aria-label="threads">
    <div class="thread-sidebar-head">
      <a href="#/threads">all threads</a>
      <button class="key sidebar-close" onclick={() => (threadSidebarOpen = false)}>close</button>
    </div>
    <button class="key sidebar-new" onclick={newThread} disabled={!summary || creating}>
      <Icon name="plus" size={13} />new thread
    </button>

    {#if threads.length > 0}
      <nav class="thread-sidebar-list" aria-label="active threads">
        {#each threads as thread (thread.id)}
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
              <span class="thread-sidebar-meta">
                <span>{thread.project.name}</span>
                {#if stateLabel(thread)}<span class:error={thread.state === "error"}>{stateLabel(thread)}</span>{/if}
              </span>
            </span>
          </a>
        {/each}
      </nav>
    {:else}
      <p class="thread-sidebar-empty">no active threads</p>
    {/if}
  </aside>

  <div class="thread-stage">
{#if summary?.error}
  <div class="strip-note bad">{summary.error}</div>
{/if}
{#if note}
  <div class="strip-note" class:bad={note.bad}>
    {note.text}
    {#if note.href}<a href={note.href} target="_blank" rel="noopener noreferrer">{note.href}</a>{/if}
  </div>
{/if}

{#if shipPhase !== "closed"}
  <aside class="ship-panel" aria-label="ship repository">
    <div class="ship-panel-inner">
      <div class="ship-head">
        <div>
          <h2>ship primary repository</h2>
          <p>review what will be published, then let the agent ship it</p>
        </div>
        <button class="key" onclick={closeShip} disabled={shipBusy}>close</button>
      </div>

      <ol class="ship-progress" aria-label="ship progress" aria-live="polite">
        <li>
          <span class="lamp mini" class:on-amber={shipPhase === "checking"} class:blink={shipPhase === "checking"} class:on-green={shipPreflight !== null} class:on-red={shipPhase === "error" && !shipPreflight} aria-hidden="true"></span>
          <span>checking</span>
        </li>
        <li>
          <span class="lamp mini" class:on-amber={shipPhase === "sending" || shipPhase === "sent"} class:blink={shipPhase === "sending" || shipPhase === "sent"} class:on-red={shipPhase === "error" && shipPreflight !== null} aria-hidden="true"></span>
          <span>agent shipping</span>
        </li>
      </ol>

      <p class="sr-only" aria-live="polite">{shipStatus}</p>

      {#if shipPhase === "checking" && !shipPreflight}
        <p class="ship-wait">Reading branch, committed diff, and local working-copy status…</p>
      {:else if shipPreflight}
        <dl class="ship-readout">
          <div><dt>branch</dt><dd>{shipPreflight.repository.state?.branch ?? "detached"}</dd></div>
          <div><dt>base</dt><dd>{shipPreflight.repository.base}</dd></div>
          <div><dt>ahead</dt><dd>{shipPreflight.repository.state?.ahead ?? 0} commits</dd></div>
          <div><dt>working copy</dt><dd>{shipPreflight.diff.dirty ? "dirty" : "clean"}</dd></div>
        </dl>

        <div class="publish-boundary">
          <section>
            <h3>committed now</h3>
            <p>{shipPreflight.diff.committed.files.length} committed {shipPreflight.diff.committed.files.length === 1 ? "file" : "files"} differ between {shipPreflight.repository.base} and {shipPreflight.repository.state?.branch ?? "HEAD"}. They are in the live changes pane.</p>
            {#if shipPreflight.diff.committed.files.length > 0}
              <ul class="ship-files">
                {#each shipPreflight.diff.committed.files as file (file.path)}
                  <li>
                    <span>{file.path}</span>
                    <small>{file.additions === null ? "binary" : `+${file.additions} −${file.deletions}`}</small>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
          <section class:unsafe={shipPreflight.diff.dirty}>
            <h3>working copy</h3>
            {#if shipPreflight.diff.dirty}
              <p>
                {shipPreflight.diff.trackedDirty ? "tracked working-copy changes" : ""}
                {shipPreflight.diff.trackedDirty && shipPreflight.diff.untracked.length > 0 ? " and " : ""}
                {shipPreflight.diff.untracked.length > 0 ? `${shipPreflight.diff.untracked.length} untracked ${shipPreflight.diff.untracked.length === 1 ? "file" : "files"}` : ""}
                are not committed and cannot be pushed yet. Ship requires the agent to commit them before publishing.
              </p>
              {#if shipPreflight.diff.tracked.length > 0}
                <ul class="ship-files local">
                  {#each shipPreflight.diff.tracked as path (path)}<li><span>{path}</span><small>tracked</small></li>{/each}
                </ul>
              {/if}
              {#if shipPreflight.diff.untracked.length > 0}
                <ul class="ship-files local">
                  {#each shipPreflight.diff.untracked as path (path)}<li><span>{path}</span><small>untracked</small></li>{/each}
                </ul>
              {/if}
            {:else}
              <p>Clean. There are no tracked or untracked changes outside the committed diff.</p>
            {/if}
          </section>
        </div>

        {#if shipPhase === "blocked"}
          <p class="ship-notice bad">{shipBlock(shipPreflight)}</p>
          <div class="ship-actions"><button class="key" onclick={checkShip}>check again</button></div>
        {:else if shipPhase === "ready"}
          <p class="ship-notice">The agent will commit local work, securely fetch and rebase onto origin/main, run the full test suite, and non-force push only after the checks pass. Substantive conflicts require your approval in the terminal.</p>
          <div class="ship-actions"><button class="key primary" onclick={ship}>ship</button></div>
        {:else if shipPhase === "sent"}
          <p class="ship-notice success">Shipping is running in the agent terminal. Follow its checks, conflict questions, and final push result there.</p>
        {/if}
      {/if}

      {#if shipPhase === "error"}
        <p class="ship-notice bad">{shipError}</p>
        <div class="ship-actions"><button class="key" onclick={shipPreflight ? ship : checkShip}>retry</button></div>
      {/if}
    </div>
  </aside>
{/if}

{#if filesOpen}
  <aside class="files-shelf" aria-label="workspace files">
    {#if filesError}
      <p class="files-note">files unavailable: {filesError}</p>
    {:else if !files}
      <p class="files-note">reading…</p>
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
    {#if gone}
      <div class="term-gone"><p>This thread was deleted.</p><a class="key" href="#/threads">back to threads</a></div>
    {:else}
      <Terminal {threadId} bind:this={terminalPane} />
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
  />
</main>
  </div>
</div>
