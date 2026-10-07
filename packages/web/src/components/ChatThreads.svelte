<script lang="ts">
  import { onMount } from "svelte";
  import { dismissChatWish, errorText, fetchChatThreads, fetchChatWishes } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { OverviewThread, ThreadOverview, WishList, WishView } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  // The threads OptChat started, found from its own spawns, each with its
  // own state as cubed records it: nobody keeps this list by hand. A thread
  // whose turn ended has not necessarily done its work, and an archived one
  // is not a goal met. Below, folded, the wishes no thread took up, as a
  // cheap model inferred them from the chat: a hint to ask about, never a
  // record of what was done.
  let { busy = false }: { busy?: boolean } = $props();

  let overview = $state<ThreadOverview | null>(null);
  let error = $state<string | null>(null);
  let wishes = $state<WishList | null>(null);
  let wishError = $state<string | null>(null);
  let dismissing = $state<string | null>(null);
  let missing = $state<string | null>(null);
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
      const fresh = await fetchChatThreads();
      if (!disposed) { overview = fresh; error = null; }
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    } finally {
      loading = false;
    }
  }

  async function loadWishes(): Promise<void> {
    try {
      const fresh = await fetchChatWishes();
      if (!disposed) { wishes = fresh; wishError = null; }
    } catch (cause) {
      if (!disposed) wishError = errorText(cause);
    }
  }

  async function dismiss(wish: WishView): Promise<void> {
    dismissing = wish.id;
    try {
      await dismissChatWish(wish.id);
      await loadWishes();
    } catch (cause) {
      if (!disposed) wishError = errorText(cause);
    } finally {
      if (!disposed) dismissing = null;
    }
  }

  // The user's message in the transcript beside the panel.
  function show(entry: number | null): void {
    const target = entry === null ? null : document.querySelector<HTMLElement>(`[data-entry="${entry}"]`);
    missing = target ? null : "that message is not in the loaded transcript";
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("located");
    setTimeout(() => target.classList.remove("located"), 1600);
  }

  // A thread's own state, in the words the panel uses.
  const stateText = (thread: OverviewThread) => {
    const state = thread.state === "completed" ? "turn ended" : thread.state;
    return thread.archived ? `archived · ${state === "archived" ? "last run not read" : state}` : state;
  };
  const lamp = (thread: OverviewThread) => thread.archived ? ""
    : moving(thread.state) ? "on-amber"
    : thread.state === "failed" || thread.state.includes("error") || thread.state.includes("failed") ? "on-red" : "";
  const wishState = $derived(!wishes ? "" : wishes.state === "off" ? "off"
    : wishes.state === "catching up" ? `reading ${wishes.total ? Math.floor(100 * wishes.read / wishes.total) : 0}%`
    : String(wishes.wishes.length + wishes.more));

  // Read again when a turn ends (a spawn or a report happens in one) and
  // while one runs; while the chat is idle only as long as a thread is
  // starting or running, and slowly.
  let wasBusy = false;
  $effect(() => {
    if (wasBusy && !busy) { void load(); void loadWishes(); }
    wasBusy = busy;
  });

  onMount(() => {
    void load();
    void loadWishes();
    let tick = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      tick++;
      if (busy || (tick % 6 === 0 && active.some((thread) => moving(thread.state)))) void load();
    }, 5000);
    const visible = () => { if (!document.hidden) { void load(); void loadWishes(); } };
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
    <details class="work-wishes" ontoggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void loadWishes(); }}>
      <summary>not started{wishState ? ` · ${wishState}` : ""}</summary>
      {#if wishError}
        <p class="work-error" role="alert">{wishError} <button class="key" onclick={loadWishes}>retry</button></p>
      {:else if !wishes}
        <p class="work-empty">reading…</p>
      {:else if wishes.state === "off"}
        <p class="work-empty">off: {wishes.reason}</p>
      {:else if wishes.state === "catching up"}
        <p class="work-empty">reading the chat for wishes no thread took up ({wishes.read} of {wishes.total} messages); nothing is shown until it is through.</p>
      {:else if !wishes.wishes.length}
        <p class="work-empty">nothing found that no thread took up.</p>
      {:else}
        <ul class="work-list" aria-label="wishes not started">
          {#each wishes.wishes as wish (wish.id)}
            <li class="work-wish">
              <div class="work-wish-head">
                <span class="work-wish-text">{wish.text}</span>
                <button class="work-dismiss" aria-label="dismiss: {wish.text}" title="not a wish, or already handled: dismiss" disabled={dismissing === wish.id} onclick={() => dismiss(wish)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <blockquote class="work-quote">{wish.quote}</blockquote>
              <div class="work-sources">
                {#if wish.project}<span>{wish.project}</span>{/if}
                {#each wish.sources.slice(-3) as source (source.message)}
                  <button class="work-source" onclick={() => show(source.entry)} title="show the message in the chat">you, {source.date ? relTime(source.date) : `#${source.message}`}</button>
                {/each}
              </div>
            </li>
          {/each}
        </ul>
        {#if wishes.more}<p class="work-note">{wishes.more} more not shown</p>{/if}
      {/if}
      {#if missing}<p class="work-note" role="status">{missing}</p>{/if}
      {#if wishes?.error}<p class="work-note">last read failed: {wishes.error}</p>{/if}
      <p class="work-note">inferred from the chat by a model; it may miss or misread a wish.</p>
    </details>
    <p class="work-foot">states from cube · archived is not done · merged is not released</p>
  </div>
</aside>
