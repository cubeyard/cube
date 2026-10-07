<script lang="ts">
  import { onMount } from "svelte";
  import { errorText, fetchArtifacts } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import type { ArtifactListItem } from "../lib/types.ts";
  import Header from "./Header.svelte";

  // Every artifact on this host, newest first: documents agents wrote for
  // the user to read and comment on. They are not tasks and keep no state of
  // the work; the chat and the threads do.
  let artifacts = $state<ArtifactListItem[] | null>(null);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    try { artifacts = await fetchArtifacts(); error = null; }
    catch (cause) { error = errorText(cause); }
  }
  const author = (item: ArtifactListItem) => item.author.kind === "optchat" ? "optchat"
    : item.thread?.title ? `thread “${item.thread.title}”` : `thread [${item.author.thread.slice(0, 8)}]`;
  const comments = (item: ArtifactListItem) => [
    item.comments.draft && `${item.comments.draft} not sent`,
    item.comments.queued && `${item.comments.queued} waiting`,
    item.comments.delivered && `${item.comments.delivered} sent`,
    item.comments.undeliverable && `${item.comments.undeliverable} undeliverable`,
  ].filter(Boolean).join(" · ");

  onMount(() => {
    document.title = "artifacts · cube";
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => clearInterval(timer);
  });
</script>

<Header section="artifacts" />
<main class="artifact-list-page">
  <h1>artifacts</h1>
  <p class="artifact-list-lede">documents optchat and threads wrote for you: reviews, plans, reports. Select text in one to comment; comments go back to its author.</p>
  {#if error}<p class="work-error" role="alert">{error} <button class="key" onclick={load}>retry</button></p>{/if}
  {#if !artifacts}
    <p class="loading">loading artifacts…</p>
  {:else if !artifacts.length}
    <p class="artifact-list-empty">none yet. Ask in the chat for a review or a plan as an artifact.</p>
  {:else}
    <ul class="artifact-list">
      {#each artifacts as item (item.id)}
        <li>
          <a class="artifact-list-title" href={`#/a/${item.id}`}>{item.title}</a>
          <span class="artifact-list-meta">{author(item)}{item.project ? ` · ${item.project.name}` : ""} · revision {item.head} · {relTime(item.updatedAt)}{comments(item) ? ` · ${comments(item)}` : ""}</span>
        </li>
      {/each}
    </ul>
  {/if}
</main>
