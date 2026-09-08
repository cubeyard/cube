<script lang="ts">
  import { onMount } from "svelte";
  import ProjectList from "./components/ProjectList.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import ThreadList from "./components/ThreadList.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import { errorText, fetchState, fetchThreads } from "./lib/api.ts";
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
  let threads = $state<ThreadSummary[]>([]);
  let threadsLoaded = $state(false);
  const activeThreads = $derived(threads.filter((thread) => !thread.archived));

  /** One poll: cubed's state until it answers (a tab opened while the VM
   * boots recovers by itself), then the thread list. */
  async function refresh(): Promise<void> {
    if (!daemon) {
      try {
        daemon = await fetchState();
        loadError = null;
      } catch (e) {
        loadError = errorText(e);
        return;
      }
    }
    if (!daemon.onboardingComplete) return;
    try {
      const fresh = await fetchThreads(true);
      threads = fresh;
      threadsLoaded = true;
      if (threadId && fresh.find((thread) => thread.id === threadId)?.archived) {
        location.hash = "#/threads";
      }
    } catch {
      // Keep the last good navigation state during transient connectivity loss.
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });
</script>

<!-- A navigation refreshes at once: a thread created a moment ago must be
     in the list before its view can say whether it exists. -->
<svelte:window onhashchange={() => { hash = location.hash; void refresh(); }} />

{#if loadError}
  <div class="banner">cubed unreachable: {loadError}</div>
{:else if !daemon}
  <p class="loading">loading…</p>
{:else if !daemon.onboardingComplete}
  <Onboarding onComplete={() => {
    daemon = { ...daemon!, onboardingComplete: true };
    location.hash = "#/projects";
  }} />
{:else if threadId && threadsLoaded}
  {#key threadId}
    <ThreadView {threadId} threads={activeThreads} />
  {/key}
{:else if threadId}
  <p class="loading">loading threads…</p>
{:else if projectId}
  {#key projectId}
    <ProjectView {projectId} githubLogin={/^#\/projects\/[^/?]+\/github(?:[?]|$)/.test(hash)} />
  {/key}
{:else if projectsRoute}
  <ProjectList />
{:else if threadsLoaded}
  <ThreadList threads={activeThreads} initialProjectId={projectFilter} onThreadsChanged={refresh} />
{:else}
  <p class="loading">loading threads…</p>
{/if}
