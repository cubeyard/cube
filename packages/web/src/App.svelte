<script lang="ts">
  import { onMount, tick } from "svelte";
  import ProjectList from "./components/ProjectList.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import ThreadList from "./components/ThreadList.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import Wordmark from "./components/Wordmark.svelte";
  import { errorText, fetchState, fetchThreads, isUnreachable } from "./lib/api.ts";
  import { COMMAND_TTL_MS, type Command } from "./lib/command.ts";
  import type { DaemonState, ThreadSummary } from "./lib/types.ts";

  // Global threads, project setup, and one thread's terminal. Cubes never
  // appear in URLs. Ids are opaque tokens (uuids, "new"), used verbatim.
  let hash = $state(location.hash);
  const threadId = $derived(hash.match(/^#\/t\/([^/?]+)/)?.[1] ?? null);
  const projectId = $derived(hash.match(/^#\/projects\/([^/?]+)/)?.[1] ?? null);
  const projectsRoute = $derived(/^#\/projects(?:[/?]|$)/.test(hash));
  const projectFilter = $derived(
    new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "").get("project"),
  );

  let daemon = $state<DaemonState | null>(null);
  let loadError = $state<string | null>(null);
  // The plain "no answer" case needs no detail line; anything else (a 500
  // from /api/state, say) prints what the host said.
  let loadUnreachable = $state(true);
  let threads = $state<ThreadSummary[]>([]);
  let threadsLoaded = $state(false);
  const activeThreads = $derived(threads.filter((thread) => !thread.archived));

  // Connection honesty after the first load: one missed poll is noise (a
  // laptop lid, a cubed restart); two in a row is worth a quiet word.
  let failedPolls = $state(0);
  const offline = $derived(failedPolls >= 2);

  // A note for the list after the app moved the user off a thread — the
  // Ship flow archives the thread under them; a silent redirect would
  // read as a glitch. It says only what is known: archived, not shipped.
  let listNotice = $state<string | null>(null);

  // `n` pressed: one command, consumed exactly once by the view it is
  // meant for (see lib/command.ts). The view clears it through
  // `consume` before doing anything async; anything left unconsumed
  // (no view to take it) expires on its own.
  let command = $state<Command | null>(null);
  let commandSeq = 0;
  let commandTimer: ReturnType<typeof setTimeout> | null = null;
  function issue(kind: Command["kind"]): void {
    commandSeq += 1;
    const id = commandSeq;
    command = { kind, id, at: Date.now() };
    if (commandTimer) clearTimeout(commandTimer);
    commandTimer = setTimeout(() => consume(id), COMMAND_TTL_MS);
  }
  function consume(id: number): void {
    if (command?.id === id) command = null;
  }

  /** One poll: cubed's state until it answers (a tab opened while the VM
   * boots recovers by itself), then the thread list. */
  async function refresh(): Promise<void> {
    if (!daemon) {
      try {
        daemon = await fetchState();
        loadError = null;
      } catch (e) {
        loadError = errorText(e);
        loadUnreachable = isUnreachable(e);
        return;
      }
    }
    if (!daemon.onboardingComplete) return;
    try {
      const fresh = await fetchThreads(true);
      threads = fresh;
      threadsLoaded = true;
      failedPolls = 0;
      if (threadId && fresh.find((thread) => thread.id === threadId)?.archived) {
        listNotice = "this thread was archived";
        location.hash = "#/threads";
      }
    } catch {
      // Keep the last good navigation state during transient connectivity
      // loss; the strip above the panel says so once it persists.
      failedPolls += 1;
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });

  /** After a navigation, put focus on the new view's heading so keyboard
   * and screen-reader users land where the page starts. Never yank focus
   * from a control the user is still in (the project filter select
   * navigates on change), and never from the terminal, which claims focus
   * itself on its first connect. */
  async function focusHeading(): Promise<void> {
    if (threadId) return;
    for (const wait of [0, 250]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      else await tick();
      const active = document.activeElement;
      if (active && active !== document.body && !(active instanceof HTMLAnchorElement)) return;
      const heading = document.querySelector<HTMLElement>("main h1");
      if (!heading) continue;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return;
    }
  }

  function onHashChange(): void {
    hash = location.hash;
    void refresh();
    void focusHeading();
  }

  // Keyboard: `n` new thread, `g t` threads, `g p` projects — only while
  // focus is on the panel itself, never inside a field or the terminal
  // (pi owns every key there).
  let pendingG = 0;
  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable], .term-pane")) return;
    const now = Date.now();
    const chord = pendingG && now - pendingG < 1500;
    pendingG = 0;
    if (event.key === "g") {
      pendingG = now;
      return;
    }
    if (chord && event.key === "t") {
      event.preventDefault();
      location.hash = "#/threads";
    } else if (chord && event.key === "p") {
      event.preventDefault();
      location.hash = "#/projects";
    } else if (!chord && event.key === "n") {
      event.preventDefault();
      issue("new-thread");
      if (!threadId && !(projectId && projectId !== "new")) location.hash = "#/threads";
    }
  }

  // The tab title names the place, newest first: "<thread> · cube".
  // Project routes set their own once the project's name is known.
  $effect(() => {
    if (projectId) return;
    const current = threadId ? threads.find((thread) => thread.id === threadId) : null;
    document.title =
      threadId ? `${current?.title ?? "untitled"} · cube`
      : projectsRoute ? "projects · cube"
      : "threads · cube";
  });
</script>

<!-- A navigation refreshes at once: a thread created a moment ago must be
     in the list before its view can say whether it exists. -->
<svelte:window onhashchange={onHashChange} onkeydown={onKeydown} />

{#if loadError}
  <header class="plain-header"><Wordmark /></header>
  <main class="unreachable" role="status" aria-live="polite">
    <p class="unreachable-line">can't reach cube on this host — it may still be starting. retrying…</p>
    {#if !loadUnreachable}<p class="unreachable-detail">{loadError}</p>{/if}
    <button class="key" onclick={() => void refresh()}>retry now</button>
  </main>
{:else if !daemon}
  <p class="loading">loading…</p>
{:else if !daemon.onboardingComplete}
  <Onboarding onComplete={() => {
    daemon = { ...daemon!, onboardingComplete: true };
    location.hash = "#/projects";
  }} />
{:else}
  {#if offline}
    <div class="conn-strip" role="status">not connected to the host — retrying</div>
  {/if}
  {#if threadId && threadsLoaded}
    {#key threadId}
      <ThreadView {threadId} threads={activeThreads} {command} onConsume={consume} />
    {/key}
  {:else if threadId}
    <p class="loading">loading threads…</p>
  {:else if projectId}
    {#key projectId}
      <ProjectView {projectId} githubLogin={/^#\/projects\/[^/?]+\/github(?:[?]|$)/.test(hash)} {command} onConsume={consume} />
    {/key}
  {:else if projectsRoute}
    <ProjectList />
  {:else if threadsLoaded}
    <ThreadList
      threads={activeThreads}
      initialProjectId={projectFilter}
      onThreadsChanged={refresh}
      notice={listNotice}
      onDismissNotice={() => (listNotice = null)}
      {command}
      onConsume={consume}
    />
  {:else}
    <p class="loading">loading threads…</p>
  {/if}
{/if}
