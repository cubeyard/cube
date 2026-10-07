<script lang="ts">
  import { onMount } from "svelte";
  import { errorText, fetchChatTasks } from "../lib/api.ts";
  import type { TaskList, TaskView } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  // The chat's task list: what is going on now, kept by OptChat so the user
  // reads a list instead of scrolling the endless chat. A task's status is
  // OptChat's intent; a thread's state beside it is cubed's record; a link is
  // only a link — no pull request, merge or release state is checked here.
  let { busy = false }: { busy?: boolean } = $props();

  let list = $state<TaskList | null>(null);
  let error = $state<string | null>(null);
  let loading = false;
  let disposed = false;
  // On a narrow screen the list folds above the conversation.
  let open = $state(true);

  const blocked = $derived(list?.open.filter((task) => task.status === "blocked").length ?? 0);
  const summary = $derived(!list ? "" : list.open.length
    ? `${list.open.length} open${blocked ? ` · ${blocked} blocked` : ""}`
    : "nothing open");

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const fresh = await fetchChatTasks();
      if (!disposed) { list = fresh; error = null; }
    } catch (cause) {
      if (!disposed) error = errorText(cause);
    } finally {
      loading = false;
    }
  }

  function toggle(): void {
    open = !open;
  }

  const lamp = (status: TaskView["status"]) =>
    status === "blocked" ? "on-red" : status === "active" ? "on-amber" : status === "done" ? "on-green" : "";
  // A thread's own state, never the task's: a turn that ended is not a task done.
  const threadState = (state: string) => state === "completed" ? "turn ended" : state;
  const threadLamp = (state: string) =>
    state === "working" || state === "starting" || state.startsWith("waiting") ? "on-amber" : state === "failed" || state === "machine error" ? "on-red" : "";

  // Read again when a turn ends (OptChat changes the list in its turns, and
  // a thread's report starts one) and while one runs; never on a timer
  // while the chat is idle.
  let wasBusy = false;
  $effect(() => {
    if (wasBusy && !busy) void load();
    wasBusy = busy;
  });

  onMount(() => {
    void load();
    const timer = setInterval(() => { if (busy && !document.hidden) void load(); }, 5000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  });
</script>

{#snippet task(item: TaskView)}
  <li class="now-task" data-status={item.status}>
    <div class="now-task-head">
      <span class="lamp {lamp(item.status)}" aria-hidden="true"></span>
      <span class="now-title">{item.title}</span>
      <span class="now-status">{item.status}</span>
    </div>
    {#if item.project}<div class="now-project">{item.project}</div>{/if}
    {#if item.next}
      <p class="now-next"><span class="now-label">{item.status === "blocked" ? "blocked on" : "next"}</span> {item.next}</p>
    {/if}
    {#if item.threads.length || item.links.length}
      <ul class="now-refs" aria-label="linked threads and links">
        {#each item.threads as thread (thread.id)}
          <li>
            <span class="lamp {threadLamp(thread.state)}" aria-hidden="true"></span>
            {#if thread.state === "gone"}
              <span class="now-ref">thread {thread.id.slice(0, 8)}</span>
            {:else}
              <a class="now-ref" href="#/t/{thread.id}" title={thread.title ?? undefined}>thread {thread.id.slice(0, 8)}</a>
            {/if}
            <span class="now-observed" title="the thread's state as cube records it now">{threadState(thread.state)}</span>
          </li>
        {/each}
        {#each item.links as link (link.url)}
          <li>
            <a class="now-ref" href={link.url} target="_blank" rel="noopener noreferrer"
              title="{link.url} — a link only; cube does not check its state">{link.pr ? "pr " : ""}{link.label} ↗</a>
          </li>
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<aside class="now-panel" class:folded={!open} aria-labelledby="now-heading">
  <div class="now-head">
    <h2 id="now-heading">now</h2>
    <span class="now-summary" aria-live="polite">{summary}</span>
    <button class="strip-toggle now-fold" aria-expanded={open} aria-controls="now-body" onclick={toggle}>
      <span class="sr-only">{open ? "hide" : "show"} tasks</span>
      <Icon name="chevron" size={12} />
    </button>
  </div>
  <div id="now-body" class="now-body">
    {#if error}
      <p class="now-error" role="alert">{error} <button class="key" onclick={load}>retry</button></p>
    {/if}
    {#if !list && !error}
      <p class="now-empty">reading tasks…</p>
    {:else if list}
      {#if list.open.length}
        <ul class="now-list" aria-label="open tasks">
          {#each list.open as item (item.id)}{@render task(item)}{/each}
        </ul>
      {:else}
        <p class="now-empty">nothing open. ask optchat to keep track of work here.</p>
      {/if}
      {#if list.closed.length}
        <details class="now-closed">
          <summary>recently closed · {list.closed.length}</summary>
          <ul class="now-list" aria-label="recently closed tasks">
            {#each list.closed as item (item.id)}{@render task(item)}{/each}
          </ul>
        </details>
      {/if}
      <p class="now-foot">kept by optchat · thread states from cube · links unchecked</p>
    {/if}
  </div>
</aside>
