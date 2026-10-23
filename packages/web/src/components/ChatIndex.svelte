<script lang="ts">
  import { onDestroy, tick, type Snippet } from "svelte";
  import { COMPACT_MEDIA } from "../lib/keyboard.ts";
  import { relTime } from "../lib/time.ts";
  import { failing, moving, stateText } from "../lib/work-state.ts";
  import type { ChatWork } from "../lib/work.svelte.ts";
  import type { OverviewThread } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  // The index: everything the chat is not, one step away and gone again.
  // The chat's threads (failed, then moving, then the rest, each in cubed's
  // own words), the newest artifacts, the places (threads, artifacts,
  // projects, settings) and the chat's own model and memory. It rises from
  // the composer's work key, or `/` and ctrl/⌘ k; a filter narrows it, the
  // arrow keys walk it, enter opens, escape closes and focus goes back.
  let { work, settings }: { work: ChatWork; settings: Snippet } = $props();

  let dialog = $state<HTMLDialogElement>();
  let filter = $state("");
  let input = $state<HTMLInputElement>();
  let opener: HTMLElement | null = null;

  // On a phone the index is the whole screen, and the screen is what the
  // on-screen keyboard leaves of it: the visual viewport. iOS keeps the
  // layout viewport whole under its keyboard, so a fixed sheet would run on
  // behind it; the sheet takes the visual viewport's height and offset.
  let room = $state<{ top: number; height: number } | null>(null);
  function fit(): void {
    const view = window.visualViewport;
    room = dialog?.open && view && matchMedia(COMPACT_MEDIA).matches ? { top: view.offsetTop, height: view.height } : null;
  }
  let unfit: (() => void) | null = null;
  // Left while open (a route change, back, a swipe): the dialog goes without
  // a close event, so its listeners go here. unfit is safe to call twice.
  onDestroy(() => unfit?.());
  function follow(): void {
    unfit?.();
    const view = window.visualViewport;
    fit();
    view?.addEventListener("resize", fit);
    view?.addEventListener("scroll", fit);
    window.addEventListener("resize", fit);
    unfit = () => {
      view?.removeEventListener("resize", fit);
      view?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      unfit = null;
      room = null;
    };
  }

  /** `touch`: opened by a tap. Then the sheet itself takes focus, not the
   * filter, so no on-screen keyboard rises over it; the filter is a tap away.
   * Opened by a key or a mouse, the filter takes focus for typing at once. */
  export async function show(options: { touch?: boolean } = {}): Promise<void> {
    if (!dialog || dialog.open) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    filter = "";
    // showModal focuses the dialog itself when it carries autofocus, else its first field
    dialog.toggleAttribute("autofocus", !!options.touch);
    dialog.showModal();
    follow();
    await tick();
    if (options.touch) dialog.focus({ preventScroll: true });
    else input?.focus();
    void work.load();
  }
  export function close(): void { dialog?.close(); }

  const words = $derived(filter.trim().toLowerCase());
  const matches = (...texts: Array<string | null | undefined>) => !words || texts.some(text => text?.toLowerCase().includes(words));
  const rank = (thread: OverviewThread) => failing(thread.state) ? 0 : moving(thread.state) ? 1 : 2;
  const threads = $derived((work.overview?.threads ?? []).filter(thread => !thread.archived)
    .map((thread, index) => ({ thread, index })).sort((a, b) => rank(a.thread) - rank(b.thread) || a.index - b.index)
    .map(item => item.thread).filter(thread => matches(thread.title, thread.project.name, thread.id.slice(0, 8), thread.state)));
  const artifacts = $derived((work.artifacts ?? []).filter(artifact => matches(artifact.title, artifact.project?.name)).slice(0, words ? 12 : 6));
  const PLACES = [
    { href: "#/threads", name: "threads", hint: "every thread, by project" },
    { href: "#/artifacts", name: "artifacts", hint: "every document" },
    { href: "#/projects", name: "projects", hint: "repositories and runners" },
    { href: "#/settings/providers", name: "settings", hint: "model providers, chat memory, skills, system" },
  ];
  const places = $derived(PLACES.filter(place => matches(place.name, place.hint)));

  /** The arrow keys walk the index's items; enter in the filter opens the first. */
  function onKeydown(event: KeyboardEvent): void {
    const items = [...dialog!.querySelectorAll<HTMLElement>("[data-index-item]")].filter(item => !(item as HTMLButtonElement).disabled);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if ((document.activeElement as HTMLElement | null)?.tagName === "SELECT") return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 1 : items.length - 1) : (at + step + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Enter" && document.activeElement === input && words) {
      event.preventDefault();
      items.find(item => item !== input && item.tagName === "A")?.click();
    }
  }

  function onClose(): void {
    unfit?.();
    // Back to where the reader was, unless a link took them elsewhere.
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }
</script>

<!-- a press on the backdrop closes it, as escape does -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="chat-index" bind:this={dialog} aria-label="index" tabindex="-1" onclose={onClose} onkeydown={onKeydown}
  style:top={room ? `${room.top}px` : null} style:height={room ? `${room.height}px` : null}
  onclick={(event) => { if (event.target === dialog) dialog?.close(); else if ((event.target as Element).closest("a[href]")) dialog?.close(); }}>
  <div class="index-filter">
    <span class="index-search"><Icon name="search" size={14} /></span>
    <input bind:this={input} bind:value={filter} type="search" data-index-item aria-label="filter threads, artifacts and places"
      placeholder="filter" autocomplete="off" spellcheck="false" />
    <button type="button" class="index-close" aria-label="close index" title="close · esc" onclick={() => dialog?.close()}><Icon name="close" size={14} /></button>
  </div>
  <div class="index-body">
    <section aria-labelledby="index-threads">
      <h2 id="index-threads">threads</h2>
      {#if work.error}
        <p class="index-error" role="alert">threads could not be read: {work.error} <button type="button" class="note-link" data-index-item onclick={() => work.load()}>retry</button></p>
      {/if}
      {#if !work.overview && !work.error}
        <p class="index-quiet" role="status">reading threads…</p>
      {:else if work.overview && !threads.length}
        <p class="index-quiet">{words ? "no thread matches" : "no open threads. ask the chat to start one."}</p>
      {/if}
      {#if threads.length}
        <ul>
          {#each threads as thread (thread.id)}
            <li>
              <a class="index-row" href="#/t/{thread.id}" data-index-item>
                <span class="index-title" class:untitled={!thread.title}>{thread.title ?? "untitled"}</span>
                <span class="index-meta" class:failure={failing(thread.state)}>{stateText(thread.state)} · {thread.project.name}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      {#if work.overview && (work.overview.archived.total || work.overview.unknown) && !words}
        <p class="index-quiet">{[work.overview.archived.total && `${work.overview.archived.total} archived`, work.overview.unknown && `${work.overview.unknown} no longer known to cube`].filter(Boolean).join(" · ")}</p>
      {/if}
    </section>
    <section aria-labelledby="index-artifacts">
      <h2 id="index-artifacts">artifacts</h2>
      {#if work.artifactsError && !work.artifacts}
        <p class="index-error" role="alert">artifacts could not be read: {work.artifactsError}</p>
      {:else if work.artifacts && !artifacts.length}
        <p class="index-quiet">{words ? "no artifact matches" : "no artifacts yet"}</p>
      {/if}
      {#if artifacts.length}
        <ul>
          {#each artifacts as artifact (artifact.id)}
            <li>
              <a class="index-row" href="#/a/{artifact.id}" data-index-item>
                <span class="index-doc"><Icon name="file" size={13} /></span>
                <span class="index-title">{artifact.title}</span>
                <span class="index-meta">revision {artifact.head} · {relTime(artifact.updatedAt)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    {#if places.length}
      <nav aria-label="places" class="index-places">
        {#each places as place (place.href)}
          <a href={place.href} data-index-item title={place.hint}>{place.name}</a>
        {/each}
      </nav>
    {/if}
    <section class="index-chat" aria-label="this chat">
      {@render settings()}
    </section>
  </div>
  <p class="index-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>enter</kbd> open · <kbd>esc</kbd> close</p>
</dialog>
