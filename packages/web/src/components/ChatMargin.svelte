<script lang="ts">
  import { onMount, tick } from "svelte";
  import { place } from "../lib/margin-layout.ts";
  import { failing, stateText } from "../lib/work-state.ts";
  import type { NoteGroup, NoteThread } from "../lib/provenance.ts";
  import Icon from "./Icon.svelte";
  import WorkNote from "./WorkNote.svelte";

  // The desktop margin: each note beside the message that started or
  // named what it shows, scrolling with the conversation; a hairline ties a
  // note to its message while it stands level with it. A note that grows
  // (opened, or a longer state) moves the notes after it, never the
  // conversation; the one opened stays by its message. A thread that failed
  // while its note is scrolled away is pinned at the margin's top with the
  // way back to it. Rows are found by their `data-anchor` (Conversation).
  let { groups, open, onToggle, reports, onJump, unread = null }: {
    groups: NoteGroup[];
    open: string | null;
    onToggle: (key: string | null) => void;
    reports: ReadonlyMap<string, { row: string; text: string }>;
    onJump: (row: string) => void;
    unread?: string | null;
  } = $props();

  let aside = $state<HTMLElement>();
  let tops = $state<Record<string, number>>({});
  /** The notes level with their message: only these draw the hairline to it. */
  let level = $state<Record<string, boolean>>({});
  type Pin = { row: string; thread: NoteThread; direction: "up" | "down" };
  let pins = $state<Pin[]>([]);
  const GAP = 14;

  const keysOf = (group: NoteGroup) => [...group.threads.map(thread => `t:${thread.short}`), ...group.artifacts.map(artifact => `a:${artifact.id}`)];
  const held = $derived(open ? groups.findIndex(group => keysOf(group).includes(open)) : -1);

  const anchorOf = (row: string) => aside?.parentElement?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(row)}"]`) ?? null;
  const noteOf = (row: string) => aside?.querySelector<HTMLElement>(`.margin-notes > [data-note="${CSS.escape(row)}"]`) ?? null;

  function layout(): void {
    if (!aside) return;
    const base = aside.offsetTop;
    const placed = groups.map(group => ({ group, anchor: anchorOf(group.row), note: noteOf(group.row) }));
    const notes = placed.map(({ anchor, note }) => ({ anchor: anchor ? anchor.offsetTop - base : 0, height: note?.offsetHeight ?? 0 }));
    const result = place(notes, { gap: GAP, limit: aside.clientHeight, hold: held >= 0 ? held : null });
    const next: Record<string, number> = {};
    const beside: Record<string, boolean> = {};
    placed.forEach(({ group, anchor }, index) => {
      if (!anchor) return;
      next[group.row] = Math.round(result[index]!);
      beside[group.row] = Math.abs(result[index]! - notes[index]!.anchor) < 3;
    });
    if (JSON.stringify(next) !== JSON.stringify(tops)) tops = next;
    if (JSON.stringify(beside) !== JSON.stringify(level)) level = beside;
    // The pins read where the notes are drawn: once these tops are, a frame on.
    void tick().then(() => requestAnimationFrame(pin));
  }

  /** The failed threads whose notes are out of view, and which way they are. */
  function pin(): void {
    const scroller = aside?.closest<HTMLElement>(".transcript");
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    const next: Pin[] = [];
    for (const group of groups) {
      const failed = group.threads.filter(thread => thread.state && failing(thread.state) && !thread.archived);
      if (!failed.length) continue;
      const box = noteOf(group.row)?.getBoundingClientRect();
      if (!box) continue;
      const direction = box.bottom < view.top + 8 ? "up" : box.top > view.bottom - 8 ? "down" : null;
      if (direction) for (const thread of failed) next.push({ row: group.row, thread, direction });
    }
    if (JSON.stringify(next.map(item => [item.thread.short, item.direction])) !== JSON.stringify(pins.map(item => [item.thread.short, item.direction]))) pins = next;
  }

  let frame = 0;
  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; layout(); });
  }

  // Again whenever what is shown changes: the notes, the one held open.
  $effect(() => {
    void groups; void held; void open;
    void tick().then(schedule);
  });

  const resize = new ResizeObserver(schedule);
  function observe(element: HTMLElement) {
    resize.observe(element);
    return { destroy: () => resize.unobserve(element) };
  }

  onMount(() => {
    const page = aside!.parentElement!;
    const column = page.querySelector<HTMLElement>(".transcript-column");
    if (column) resize.observe(column);
    resize.observe(aside!);
    const scroller = aside!.closest<HTMLElement>(".transcript");
    let pinFrame = 0;
    const onScroll = () => { if (!pinFrame) pinFrame = requestAnimationFrame(() => { pinFrame = 0; pin(); }); };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pinFrame);
    };
  });

  /** Back to a pinned thread's note: its message in view, focus on its head. */
  function back(item: Pin): void {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    anchorOf(item.row)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    noteOf(item.row)?.querySelector<HTMLButtonElement>(`.note-head[aria-controls^="peek-t-${item.thread.short}"]`)?.focus({ preventScroll: true });
  }
</script>

<aside class="sheet-margin" bind:this={aside} aria-label="threads and artifacts from this chat">
  {#if pins.length}
    <div class="margin-pins">
      {#each pins as item (item.thread.short)}
        <button type="button" class="margin-pin" onclick={() => back(item)} title="show where the chat started it">
          <span class="note-title">{item.thread.title ?? `[${item.thread.short}]`}</span>
          <span class="note-state failure">{stateText(item.thread.state ?? "")}</span>
          <span class="pin-way"><Icon name={item.direction === "up" ? "arrow" : "down"} size={12} /><span class="sr-only">{item.direction === "up" ? "above" : "below"}, show it</span></span>
        </button>
      {/each}
    </div>
  {/if}
  <div class="margin-notes">
    {#each groups as group (group.row)}
      <div class="margin-note" data-note={group.row} class:placed={group.row in tops} class:level={level[group.row]} style:top="{tops[group.row] ?? 0}px" use:observe>
        <WorkNote {group} {open} {onToggle} {reports} {onJump} {unread} onBack={() => onJump(group.row)} />
      </div>
    {/each}
  </div>
</aside>
