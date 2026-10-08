<script lang="ts">
  import { onMount } from "svelte";
  import { errorText, fetchArtifacts, fetchChatThreads } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { ArtifactListItem, OverviewThread, ThreadOverview } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  // The threads OptChat started, found from its own spawns, each with its
  // own state as cubed records it: nobody keeps this list by hand. A thread
  // whose turn ended has not necessarily done its work, and an archived one
  // is not a goal met.
  let { busy = false }: { busy?: boolean } = $props();

  let overview = $state<ThreadOverview | null>(null);
  // The newest artifacts: documents to read, linked here, not tasks.
  let artifacts = $state<ArtifactListItem[] | null>(null);
  let error = $state<string | null>(null);
  let loading = false;
  let disposed = false;
  // On a narrow screen the panel folds above the conversation.
  let open = $state(true);

  // By project, in the order of each project's newest thread.
  const groups = $derived.by(() => {
    const out: Array<{ id: string; name: string; threads: OverviewThread[] }> = [];
    for (const thread of overview?.threads ?? []) {
      const group = out.find((item) => item.id === thread.project.id);
      if (group) group.threads.push(thread);
      else out.push({ id: thread.project.id, name: thread.project.name, threads: [thread] });
    }
    return out;
  });
  const active = $derived(overview?.threads.filter((thread) => !thread.archived) ?? []);
  const moving = (state: string) => state === "working" || state === "starting" || state === "being archived" || state.startsWith("waiting");
  const summary = $derived(!overview ? "" : !overview.threads.length ? "none yet" : [
    `${active.length} open`,
    ...(active.some((thread) => moving(thread.state)) ? [`${active.filter((thread) => moving(thread.state)).length} running`] : []),
  ].join(" · "));

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const [fresh, documents] = await Promise.all([fetchChatThreads(), fetchArtifacts().catch(() => artifacts)]);
      if (!disposed) { overview = fresh; artifacts = documents; error = null; }
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    } finally {
      loading = false;
    }
  }

  // A thread's own state, in the words the panel uses.
  const stateText = (thread: OverviewThread) => {
    const state = thread.state === "completed" ? "turn ended" : thread.state;
    return thread.archived ? `archived · ${state === "archived" ? "last run not read" : state}` : state;
  };
  const lamp = (thread: OverviewThread) => thread.archived ? ""
    : moving(thread.state) ? "on-amber"
    : thread.state === "failed" || thread.state.includes("error") || thread.state.includes("failed") ? "on-red" : "";

  // Read again when a turn ends (a spawn or a report happens in one) and
  // while one runs; while the chat is idle only as long as a thread is
  // starting or running, and slowly.
  let wasBusy = false;
  $effect(() => {
    if (wasBusy && !busy) void load();
    wasBusy = busy;
  });

  onMount(() => {
    void load();
    let tick = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      tick++;
      if (busy || (tick % 6 === 0 && active.some((thread) => moving(thread.state)))) void load();
      // A thread writes an artifact whenever it likes: the list is read every 30 s.
      else if (tick % 6 === 0) void fetchArtifacts().then((fresh) => { if (!disposed) artifacts = fresh; }).catch(() => {});
    }, 5000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  });
</script>

<aside class="work-panel" class:folded={!open} aria-labelledby="work-heading">
  <div class="work-head">
    <h2 id="work-heading">threads</h2>
    <span class="work-summary" aria-live="polite">{summary}</span>
    <button class="strip-toggle work-fold" aria-expanded={open} aria-controls="work-body" onclick={() => (open = !open)}>
      <span class="sr-only">{open ? "hide" : "show"} threads</span>
      <Icon name="chevron" size={12} />
    </button>
  </div>
  <div id="work-body" class="work-body">
    {#if error}
      <p class="work-error" role="alert">{error} <button class="key" onclick={load}>retry</button></p>
    {/if}
    {#if !overview && !error}
      <p class="work-empty">reading threads…</p>
    {:else if overview}
      {#if !overview.threads.length}
        <p class="work-empty">no threads yet. threads optchat starts show up here.</p>
      {/if}
      {#each groups as group (group.id)}
        <section class="work-group" aria-label="project {group.name}">
          <h3>{group.name}</h3>
          <ul class="work-list">
            {#each group.threads as thread (thread.id)}
              <li class="work-thread" class:archived={thread.archived}>
                <span class="lamp {lamp(thread)}" aria-hidden="true"></span>
                <div class="work-thread-text">
                  {#if thread.archived}
                    <span class="work-title" title={thread.title ?? undefined}>{thread.title ?? "untitled"}</span>
                  {:else}
                    <a class="work-title" href="#/t/{thread.id}" title={thread.title ?? undefined}>{thread.title ?? "untitled"}</a>
                  {/if}
                  <span class="work-state" title="the thread's own state as cube records it now">{thread.id.slice(0, 8)} · {stateText(thread)}</span>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if overview.archived.total > overview.archived.shown}
        <p class="work-note">{overview.archived.total - overview.archived.shown} older archived not shown</p>
      {/if}
      {#if overview.unknown}
        <p class="work-note">{overview.unknown} no longer known to cube</p>
      {/if}
    {/if}
    {#if artifacts?.length}
      <section class="work-group work-artifacts" aria-labelledby="artifacts-heading">
        <h3 id="artifacts-heading"><a href="#/artifacts">artifacts</a></h3>
        <ul class="work-list">
          {#each artifacts.slice(0, 5) as artifact (artifact.id)}
            <li class="work-thread">
              <span class="lamp {artifact.comments.queued ? 'on-amber' : ''}" aria-hidden="true"></span>
              <div class="work-thread-text">
                <a class="work-title" href="#/a/{artifact.id}" title={artifact.title}>{artifact.title}</a>
                <span class="work-state">{artifact.author.kind === "optchat" ? "optchat" : `[${artifact.author.thread.slice(0, 8)}]`} · revision {artifact.head} · {relTime(artifact.updatedAt)}{artifact.comments.draft ? ` · ${artifact.comments.draft} not sent` : ""}{artifact.comments.queued ? ` · ${artifact.comments.queued} waiting` : ""}</span>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <p class="work-foot">states from cube · archived is not done · merged is not released</p>
  </div>
</aside>
