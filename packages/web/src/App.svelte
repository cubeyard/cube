<script lang="ts">
  import { onMount } from "svelte";
  import ProjectList from "./components/ProjectList.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import ThreadList from "./components/ThreadList.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import Onboarding from "./components/Onboarding.svelte";
  import { fetchState, fetchThreads } from "./lib/api.ts";
  import type { DaemonState, ThreadSummary } from "./lib/types.ts";

  // Global threads, project setup, and one thread's terminal. Cubes never
  // appear in URLs.
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
  fetchState().then(
    (s) => (daemon = s),
    (e) => (loadError = String(e)),
  );

  async function refreshThreads(): Promise<void> {
    if (!daemon?.onboardingComplete) return;
    try {
      const fresh = await fetchThreads(true);
      threads = fresh;
      threadsLoaded = true;
      const currentId = threadId ? decodeURIComponent(threadId) : null;
      if (currentId && fresh.find((thread) => thread.id === currentId)?.archived) {
        location.hash = "#/threads";
      }
    } catch {
      // Keep the last good navigation state during transient connectivity loss.
    }
  }

  $effect(() => {
    if (daemon?.onboardingComplete) void refreshThreads();
  });
  onMount(() => {
    const timer = setInterval(refreshThreads, 3000);
    return () => clearInterval(timer);
  });
</script>

<svelte:window onhashchange={() => (hash = location.hash)} />

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
    <ThreadView threadId={decodeURIComponent(threadId)} threads={activeThreads} />
  {/key}
{:else if threadId}
  <p class="loading">loading threads…</p>
{:else if projectId}
  {#key projectId}
    <ProjectView projectId={decodeURIComponent(projectId)} githubLogin={/^#\/projects\/[^/?]+\/github(?:[?]|$)/.test(hash)} />
  {/key}
{:else if projectsRoute}
  <ProjectList />
{:else}
  <ThreadList initialProjectId={projectFilter} />
{/if}
