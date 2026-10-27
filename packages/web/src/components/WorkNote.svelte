<script lang="ts">
  import { errorText, fetchRevision } from "../lib/api.ts";
  import { excerpt, type NoteGroup, type NoteThread } from "../lib/provenance.ts";
  import { relTime } from "../lib/time.ts";
  import { failing, stateText } from "../lib/work-state.ts";
  import type { ArtifactListItem } from "../lib/types.ts";
  import Icon from "./Icon.svelte";
  import ThreadName from "./ThreadName.svelte";

  // One note: what one message of the chat started or named, each as a
  // title and one line of state in words. A press opens it in place (the
  // conversation stays where it is) with what cube knows of it and the way
  // to its full view. States are cubed's own words; a thread cube no
  // longer knows says so. When thread names land (#239), the name goes
  // beside the title here, once, for the margin and the inline notes alike.
  let { group, inline = false, open, onToggle, reports, onJump, unread = null, onBack = null }: {
    group: NoteGroup;
    /** In the conversation's flow (narrow screens), not the margin. */
    inline?: boolean;
    /** The key of the open item, if it is in this note. */
    open: string | null;
    onToggle: (key: string | null) => void;
    /** Each thread's newest report among the rows shown, by short id. */
    reports: ReadonlyMap<string, { row: string; text: string }>;
    /** Shows a row of the conversation. */
    onJump: (row: string) => void;
    /** Why no state is shown (the overview could not be read), if so. */
    unread?: string | null;
    /** In the margin: back to the message the note stands beside. */
    onBack?: (() => void) | null;
  } = $props();

  const LIMIT = 4;
  let all = $state(false);
  type Item = { kind: "thread"; key: string; thread: NoteThread } | { kind: "artifact"; key: string; artifact: ArtifactListItem } | { kind: "unstarted"; key: string; task: number; project: string; reason: string };
  const items = $derived<Item[]>([
    ...group.threads.map(thread => ({ kind: "thread" as const, key: `t:${thread.short}`, thread })),
    ...group.unstarted.map(task => ({ kind: "unstarted" as const, key: `u:${group.row}:${task.task}`, ...task })),
    ...group.artifacts.map(artifact => ({ kind: "artifact" as const, key: `a:${artifact.id}`, artifact })),
  ]);
  // An open item past the limit stays shown.
  const shown = $derived(all || items.length <= LIMIT + 1 ? items : items.filter((item, index) => index < LIMIT || item.key === open));
  const hidden = $derived(items.length - shown.length);

  const threadState = (thread: NoteThread) => thread.known === "none" ? "not known to cube"
    : thread.state ? stateText(thread.state) : unread ? "state not read" : "reading state…";
  // What an opened thread note says after its short id: the project (inline,
  // where the state line leaves it out), when it started, archived.
  const facts = (thread: NoteThread) => [inline ? thread.project : null, thread.spawned ? `started ${relTime(thread.spawned)}` : null, thread.archived ? "archived" : null]
    .filter((part): part is string => !!part).map((part) => ` · ${part}`).join("");
  const commentText = (artifact: ArtifactListItem) => {
    const { draft, queued, delivered, undeliverable } = artifact.comments;
    return [delivered && `${delivered} sent`, queued && `${queued} waiting`, draft && `${draft} not sent`, undeliverable && `${undeliverable} undeliverable`].filter(Boolean).join(" · ");
  };

  // An artifact's opening words, read when it is opened.
  let bodies = $state<Record<string, { text: string | null; error: string | null }>>({});
  async function readBody(artifact: ArtifactListItem): Promise<void> {
    const key = `${artifact.id}@${artifact.head}`;
    if (bodies[key]) return;
    bodies[key] = { text: null, error: null };
    try { bodies[key] = { text: excerpt((await fetchRevision(artifact.id, artifact.head)).body), error: null }; }
    catch (cause) { bodies[key] = { text: null, error: errorText(cause) }; }
  }

  function toggle(item: Item): void {
    const next = open === item.key ? null : item.key;
    if (next && item.kind === "artifact") void readBody(item.artifact);
    onToggle(next);
  }

  function onKeydown(event: KeyboardEvent, item: Item): void {
    if (event.key !== "Escape" || open !== item.key) return;
    event.preventDefault();
    event.stopPropagation();
    onToggle(null);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(".note-head")?.focus();
  }
  const peekId = (key: string) => `peek-${key.replace(/[^a-z0-9-]/gi, "-")}${inline ? "-inline" : ""}`;
</script>

<div class="sheet-note" class:inline data-note={group.row}>
  <ul>
    {#each shown as item (item.key)}
      {#if item.kind === "unstarted"}
        <li class="note-item">
          <div class="note-head static">
            <span class="note-text">
              <span class="note-title">task {item.task} not started</span>
              <span class="note-state failure">{item.project} · {item.reason}</span>
            </span>
          </div>
        </li>
      {:else}
        <!-- escape folds an open note back and returns to its head -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li class="note-item" class:open={open === item.key} onkeydown={(event) => onKeydown(event, item)}>
          {#if item.kind === "thread"}
            {@const thread = item.thread}
            <button type="button" class="note-head" aria-expanded={open === item.key} aria-controls={peekId(item.key)} onclick={() => toggle(item)}>
              <span class="note-text">
                <span class="note-title" class:untitled={!thread.title && !thread.name}><ThreadName name={thread.name} />{thread.title ?? (thread.name ? "" : `[${thread.short}]`)}</span>
                <span class="note-state" class:failure={!!thread.state && failing(thread.state)}>{[threadState(thread), !inline && thread.project].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
            {#if open === item.key}
              {@const report = reports.get(thread.short)}
              <div class="note-peek" id={peekId(item.key)}>
                <p class="note-facts"><code>[{thread.short}]</code>{facts(thread)}</p>
                {#if thread.known === "none"}
                  <p>cube has no record of this thread now. the chat's log says it started{#if thread.project} in {thread.project}{/if}.</p>
                {:else if !thread.state && unread}
                  <p class="failure">its state could not be read: {unread}</p>
                {:else if thread.known === "pending"}
                  <p class="note-quiet" role="status">asking cube about this thread…</p>
                {/if}
                {#if report}
                  <p class="note-report">{excerpt(report.text, 180)}</p>
                  <button type="button" class="note-link" onclick={() => onJump(report.row)}>its report in the chat</button>
                {:else if thread.known === "overview" || thread.known === "list"}
                  <p class="note-quiet">no report in the chat yet</p>
                {/if}
                {#if thread.id && !thread.archived}<a class="note-link" href="#/t/{thread.id}">open thread</a>{/if}
                {#if onBack}<button type="button" class="note-link quiet" onclick={onBack}>the message that started it</button>{/if}
              </div>
            {/if}
          {:else}
            {@const artifact = item.artifact}
            {@const body = bodies[`${artifact.id}@${artifact.head}`]}
            <button type="button" class="note-head artifact" aria-expanded={open === item.key} aria-controls={peekId(item.key)} onclick={() => toggle(item)}>
              <!-- what kind of thing this is (a document), not a state -->
              <span class="note-doc"><Icon name="file" size={13} /></span>
              <span class="note-text">
                <span class="note-title">{artifact.title}</span>
                <span class="note-state">{[`artifact · revision ${artifact.head}`, commentText(artifact)].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
            {#if open === item.key}
              <div class="note-peek" id={peekId(item.key)}>
                <p class="note-facts">{#if artifact.author.kind === "thread"}by thread <code>[{artifact.author.thread.slice(0, 8)}]</code>{:else}by optchat{/if} · updated {relTime(artifact.updatedAt)}</p>
                {#if !body || (!body.text && !body.error)}<p class="note-quiet" role="status">reading…</p>
                {:else if body.error}<p class="failure">{body.error}</p>
                {:else if body.text}<p class="note-report">{body.text}</p>{/if}
                <a class="note-link" href="#/a/{artifact.id}">read</a>
                {#if onBack}<button type="button" class="note-link quiet" onclick={onBack}>the message that named it</button>{/if}
              </div>
            {/if}
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
  {#if hidden > 0}<button type="button" class="note-more" onclick={() => (all = true)}>{hidden} more</button>{/if}
</div>
