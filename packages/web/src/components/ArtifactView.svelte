<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { addComment, deleteComment, errorText, fetchArtifact, fetchRevision, isNotFound, previewAction, runAction, sendComments } from "../lib/api.ts";
  import { renderArtifact } from "../lib/artifact-render.ts";
  import { mark, placeAnchor, selectionAnchor, textNodes, textRange, type Anchor, type Placement } from "../lib/anchor.ts";
  import { drawDiagram } from "../lib/mermaid.ts";
  import { relTime } from "../lib/time.ts";
  import { uid } from "../lib/uid.ts";
  import type { ActionPreview, ArtifactAction, ArtifactComment, ArtifactView, Revision } from "../lib/types.ts";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  // One artifact: the document an agent wrote, its revisions, the user's
  // comments on selections and the actions it offers. The chat stays the
  // place to talk; comments go to the author as one message when sent.
  let { artifactId, revision: requested = null }: { artifactId: string; revision?: number | null } = $props();

  let view = $state<ArtifactView | null>(null);
  let loadError = $state<string | null>(null);
  let gone = $state(false);
  let shown = $state<Revision | null>(null);
  let shownError = $state<string | null>(null);
  let body = $state<HTMLElement>();
  let scroller = $state<HTMLElement>();
  let docText = $state("");
  let placements = $state<Record<string, Placement>>({});
  // A selection waiting to become a comment, and the comment being written:
  // each keeps the revision its offsets belong to.
  let selection = $state<{ anchor: Anchor; revision: number; x: number; y: number; away: boolean } | null>(null);
  let selectionNote = $state<string | null>(null);
  let pending = $state<{ anchor: Anchor; revision: number } | null>(null);
  let draftText = $state("");
  let saving = $state(false);
  let sending = $state(false);
  let commentError = $state<string | null>(null);
  let composer = $state<HTMLTextAreaElement>();
  let focused = $state<string | null>(null);
  // The action being confirmed.
  let dialog = $state<HTMLDialogElement>();
  let confirming = $state<ArtifactAction | null>(null);
  let preview = $state<ActionPreview | null>(null);
  let previewError = $state<string | null>(null);
  let checking = $state(false);
  let running = $state(false);
  let actionResult = $state<string | null>(null);
  let actionRequest = "";
  let disposed = false;

  const artifact = $derived(view?.artifact ?? null);
  const head = $derived(artifact?.head ?? 0);
  // While a comment is written its revision stays on screen; a newer one shows as newer.
  const number = $derived(requested && requested >= 1 && requested <= head ? requested : pending?.revision ?? head);
  const older = $derived(!!shown && shown.number < head);
  const rendered = $derived(shown ? renderArtifact(shown.body) : null);
  const comments = $derived(view?.comments ?? []);
  const drafts = $derived(comments.filter((comment) => comment.state === "draft"));
  const sent = $derived(comments.filter((comment) => comment.state !== "draft").toReversed());
  const author = $derived(!artifact ? "" : artifact.author.kind === "optchat" ? "optchat"
    : `thread ${artifact.thread?.title ? `“${artifact.thread.title}”` : `[${artifact.author.thread.slice(0, 8)}]`}`);
  const authorLink = $derived(artifact?.author.kind === "thread" && artifact.thread && !artifact.thread.archived ? `#/t/${artifact.author.thread}` : artifact?.author.kind === "optchat" ? "#/chat" : null);
  const meta = $derived(view?.revisions.find((item) => item.number === shown?.number) ?? null);
  // Whether there is one, not meta itself: each poll brings a new meta object.
  const metaShown = $derived(!!meta);
  // While a comment is written, even the newest revision is named: following
  // the newest is what the composer pins.
  const revisionHash = (value: number) => value === head && !pending ? `#/a/${artifactId}` : `#/a/${artifactId}?rev=${value}`;
  const runs = (action: string) => view?.actionRuns.filter((run) => run.action === action) ?? [];
  // Who hears of a run's outcome; a chat that did not start the thread is not told.
  const told = (run: string) => view?.notices.filter((notice) => notice.run === run && notice.state !== "skipped") ?? [];
  const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

  async function load(): Promise<void> {
    try {
      const fresh = await fetchArtifact(artifactId);
      if (disposed) return;
      view = fresh;
      loadError = null;
      document.title = `${fresh.artifact.title} · cube`;
    } catch (cause) {
      if (disposed) return;
      if (isNotFound(cause)) gone = true;
      else loadError = errorText(cause);
    }
  }

  // The revision on screen follows the URL, or the newest one.
  $effect(() => {
    const id = artifactId, wanted = number;
    if (!wanted || shown?.number === wanted && shown.artifact === id) return;
    shownError = null;
    fetchRevision(id, wanted).then((revision) => { if (!disposed && number === wanted) shown = revision; })
      .catch((cause) => { if (!disposed) shownError = errorText(cause); });
  });

  // After the document is on the page: its diagrams, then the comments' marks.
  $effect(() => {
    const html = rendered?.html;
    if (!html || !body) return;
    void tick().then(() => drawAll(rendered!.diagrams));
  });
  // Placed again only when a comment or its state changes, not at every poll.
  const marksKey = $derived(comments.map((comment) => `${comment.id}:${comment.state}`).join());
  $effect(() => {
    const current = shown, root = body, html = rendered?.html;
    void marksKey;
    if (!current || !root || !html) return;
    const list = untrack(() => comments);
    void tick().then(() => placeMarks(root, current.number, list));
  });

  async function drawAll(diagrams: string[]): Promise<void> {
    const root = body;
    for (const figure of root?.querySelectorAll<HTMLElement>("figure[data-diagram]") ?? []) {
      const source = diagrams[Number(figure.dataset.diagram)];
      const picture = figure.querySelector<HTMLElement>(".diagram-picture");
      if (source === undefined || !picture || picture.dataset.drawn) continue;
      picture.dataset.drawn = "1";
      const drawn = await drawDiagram(source, dark());
      if (disposed || !picture.isConnected) return;
      picture.removeAttribute("aria-busy");
      picture.replaceChildren();
      if ("error" in drawn) {
        const note = document.createElement("p");
        note.className = "diagram-note bad";
        note.textContent = drawn.error;
        picture.append(note);
        figure.querySelector("details")?.setAttribute("open", "");
      } else {
        // An image of the SVG: nothing in it runs, loads or links.
        const image = document.createElement("img");
        image.src = drawn.url;
        image.alt = `diagram ${Number(figure.dataset.diagram) + 1}; its source is below`;
        if (drawn.width) image.style.maxWidth = `min(100%, ${Math.ceil(drawn.width)}px)`;
        picture.append(image);
      }
    }
  }

  function placeMarks(root: HTMLElement, revision: number, list: ArtifactComment[]): void {
    // Marking replaces text nodes; a selection waiting for a comment is selected again after.
    const kept = selection?.revision === revision ? selection.anchor : null;
    const live = document.getSelection();
    const order = document.createRange();
    if (live?.anchorNode && live.focusNode) { order.setStart(live.anchorNode, live.anchorOffset); order.setEnd(live.focusNode, live.focusOffset); }
    // A range from a later anchor to an earlier focus collapses: the selection runs backward.
    const backward = !!live && !live.isCollapsed && order.collapsed;
    for (const old of root.querySelectorAll("mark.anchor")) old.replaceWith(...old.childNodes);
    root.normalize();
    docText = textNodes(root).text;
    const next: Record<string, Placement> = {};
    for (const comment of list) {
      const placement = placeAnchor(docText, comment.anchor, comment.revision === revision);
      next[comment.id] = placement;
      if (placement.state === "outdated") continue;
      mark(root, placement.start, placement.end, { class: `anchor ${comment.state}`, "data-comment": comment.id, title: comment.body.slice(0, 140) });
    }
    if (pending && pending.revision === revision) {
      const own = placeAnchor(docText, pending.anchor, true);
      if (own.state !== "outdated") mark(root, own.start, own.end, { class: "anchor composing" });
    }
    placements = next;
    const again = kept && textRange(root, kept.start, kept.end);
    if (again && backward) live?.setBaseAndExtent(again.endContainer, again.endOffset, again.startContainer, again.startOffset);
    else if (again) live?.setBaseAndExtent(again.startContainer, again.startOffset, again.endContainer, again.endOffset);
  }

  // A selection in the document offers a comment on it.
  function onSelection(): void {
    const root = body;
    const current = document.getSelection();
    if (!root || !current || current.isCollapsed || !current.rangeCount) { selection = null; selectionNote = null; return; }
    const range = current.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) { selection = null; return; }
    const anchor = selectionAnchor(root, range);
    if ("error" in anchor) { selection = null; selectionNote = anchor.error; return; }
    selectionNote = null;
    selection = { anchor, revision: shown?.number ?? 0, ...keyAt(range) };
  }

  // The comment key: below the selection, kept in the document's view (a phone's own selection menu sits above it);
  // away while none of the selection is in view, rather than over other text.
  function keyAt(range: Range): { x: number; y: number; away: boolean } {
    const rect = range.getBoundingClientRect();
    const field = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    return { x: Math.min(Math.max(rect.left + rect.width / 2, 60), innerWidth - 60), y: Math.min(Math.max(rect.bottom + 8, field.top + 8), field.bottom - 52),
      away: rect.bottom < field.top || rect.top > field.bottom };
  }

  // The document moved under the selection: a scroll, a diagram drawn, a resize, the panel below it.
  function follow(): void {
    const current = document.getSelection();
    if (selection && current?.rangeCount) selection = { ...selection, ...keyAt(current.getRangeAt(0)) };
  }
  // Anything in the document's scroller that changes size moves the text after it.
  $effect(() => {
    const field = scroller;
    void body; void metaShown; void shown; void shownError;
    if (!field) return;
    const sizes = new ResizeObserver(follow);
    sizes.observe(field);
    for (const child of field.children) sizes.observe(child);
    return () => sizes.disconnect();
  });

  async function startComment(): Promise<void> {
    if (!selection) return;
    pending = { anchor: selection.anchor, revision: selection.revision };
    selection = null;
    document.getSelection()?.removeAllRanges();
    commentError = null;
    await tick();
    if (body && shown) placeMarks(body, shown.number, comments);
    composer?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    composer?.focus({ preventScroll: true });
  }

  function cancelComment(): void {
    pending = null;
    draftText = "";
    if (body && shown) placeMarks(body, shown.number, comments);
  }

  async function saveComment(): Promise<void> {
    if (!pending || !draftText.trim() || saving) return;
    saving = true;
    commentError = null;
    try {
      await addComment(artifactId, { revision: pending.revision, anchor: pending.anchor, body: draftText.trim(), requestId: uid() });
      // The page stays on the revision the comment was written on.
      if (!requested && pending.revision !== head) location.hash = `#/a/${artifactId}?rev=${pending.revision}`;
      pending = null;
      draftText = "";
      await load();
    } catch (cause) {
      commentError = errorText(cause);
    } finally {
      saving = false;
    }
  }

  async function removeDraft(comment: ArtifactComment): Promise<void> {
    commentError = null;
    try { await deleteComment(artifactId, comment.id); await load(); }
    catch (cause) { commentError = errorText(cause); }
  }

  async function send(): Promise<void> {
    if (!drafts.length || sending) return;
    sending = true;
    commentError = null;
    try { await sendComments(artifactId, uid()); await load(); }
    catch (cause) { commentError = errorText(cause); }
    finally { sending = false; }
  }

  function locate(comment: ArtifactComment): void {
    focused = comment.id;
    const target = body?.querySelector<HTMLElement>(`mark[data-comment="${comment.id}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function onBodyClick(event: MouseEvent): void {
    const hit = (event.target as HTMLElement).closest?.<HTMLElement>("mark[data-comment]");
    if (!hit) return;
    focused = hit.dataset.comment ?? null;
    document.getElementById(`comment-${focused}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function onKeydown(event: KeyboardEvent): void {
    // `c` comments on the selected text, as the floating key does.
    if (event.key === "c" && selection && !event.metaKey && !event.ctrlKey && !event.altKey
      && !(event.target as HTMLElement | null)?.closest?.("input, textarea, select, dialog")) {
      event.preventDefault();
      void startComment();
    }
  }

  async function openAction(action: ArtifactAction): Promise<void> {
    confirming = action;
    preview = null;
    previewError = null;
    actionResult = null;
    actionRequest = uid();
    dialog?.showModal();
    await check();
  }
  async function check(): Promise<void> {
    if (!confirming || !shown) return;
    checking = true;
    previewError = null;
    try { preview = await previewAction(artifactId, confirming.id, shown.number); }
    catch (cause) { previewError = errorText(cause); }
    finally { checking = false; }
  }
  async function confirmAction(): Promise<void> {
    if (!confirming || !shown || !preview || preview.problems.length || running) return;
    running = true;
    previewError = null;
    try {
      const result = await runAction(artifactId, confirming.id, { revision: shown.number, confirm: preview.confirm, requestId: actionRequest });
      actionResult = result.state === "succeeded" ? result.detail : `still running: ${result.detail}`;
      await Promise.all([load(), check()]);
    } catch (cause) {
      // A failed try is not repeated under its id: the next press is a new
      // attempt. The state is read again; the failure stays in view.
      actionRequest = uid();
      await Promise.all([load(), check()]);
      previewError = errorText(cause);
    } finally {
      running = false;
    }
  }

  const stateText = (comment: ArtifactComment) => comment.state === "draft" ? "not sent"
    : comment.state === "queued" ? (comment.note ?? "waiting") : comment.state === "delivered" ? `sent to ${author}${comment.deliveredAt ? ` · ${relTime(comment.deliveredAt)}` : ""}`
    : comment.note ?? "not delivered";
  const noticeText = (notice: ArtifactView["notices"][number]) => {
    const who = notice.target.kind === "thread" ? "the thread" : "optchat";
    return notice.state === "delivered" ? `told ${who}${notice.deliveredAt ? ` · ${relTime(notice.deliveredAt)}` : ""}`
      : notice.state === "queued" ? `to ${who}: ${notice.note ?? "waiting"}` : `not told ${who}: ${notice.note ?? "undeliverable"}`;
  };
  const lamp = (comment: { state: string }) => comment.state === "queued" ? "on-amber" : comment.state === "delivered" ? "on-green" : comment.state === "undeliverable" ? "on-red" : "";
  const placeText = (comment: ArtifactComment) => {
    const placed = placements[comment.id];
    if (!shown || !placed) return "";
    if (placed.state === "outdated") return comment.revision === shown.number ? "not found in the text" : `on revision ${comment.revision}; not in this one`;
    return comment.revision === shown.number ? "" : `on revision ${comment.revision}; found here`;
  };
  const provenance = (item: NonNullable<typeof meta>) => [
    item.provenance.agent === "optchat" ? "optchat" : item.provenance.agent === "pi" ? "pi thread" : "claude code thread",
    // A revision another thread wrote names that thread; the author is in the strip above.
    item.editor.kind === "thread" && (artifact?.author.kind !== "thread" || artifact.author.thread !== item.editor.thread) ? `[${item.editor.thread.slice(0, 8)}]` : null,
    item.provenance.model,
    item.provenance.source ? `from ${item.provenance.source.path} · sha ${item.provenance.source.sha256.slice(0, 10)}` : null,
    item.provenance.call ? `call ${item.provenance.call.slice(0, 18)}` : null,
  ].filter(Boolean).join(" · ");

  onMount(() => {
    void load();
    // A new revision or a comment's delivery shows without a reload.
    const timer = setInterval(() => { if (!document.hidden && !dialog?.open && !gone) void load(); }, 4000);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("selectionchange", onSelection);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<Header section="artifacts" />
{#if gone}
  <main class="artifact-missing"><p>this artifact does not exist on this host.</p><a class="key" href="#/artifacts">all artifacts</a></main>
{:else if loadError && !view}
  <main class="artifact-missing" role="alert"><p>{loadError}</p><button class="key" onclick={load}>retry</button></main>
{:else if !view || !artifact}
  <p class="loading">loading artifact…</p>
{:else}
  <main class="artifact-workspace">
    <section class="artifact-pane" aria-label="document">
      <section class="thread-strip artifact-strip" aria-label="artifact">
        <span class="lamp {drafts.length ? 'on-amber' : ''}" aria-hidden="true"></span>
        <h1 class="strip-title artifact-title">{artifact.title}</h1>
        <span class="strip-state">by {#if authorLink}<a class="strip-link" href={authorLink}>{author}</a>{:else}{author}{/if}{artifact.thread?.archived ? " (archived)" : ""}</span>
        {#if artifact.project}<a class="strip-project" href={`#/projects/${artifact.project.id}`}>{artifact.project.name}</a>{/if}
        <span class="spacer"></span>
        <label class="strip-model artifact-revision" title="revision">
          <span class="sr-only">revision</span>
          <select aria-label="revision" value={String(number)} onchange={(event) => {
            const value = Number((event.currentTarget as HTMLSelectElement).value);
            location.hash = revisionHash(value);
          }}>
            {#each view.revisions.toReversed() as item (item.number)}
              <option value={String(item.number)}>revision {item.number}{item.number === head ? " · newest" : ""}</option>
            {/each}
          </select>
          <Icon name="chevron" size={12} />
        </label>
      </section>
      {#if older}
        <div class="strip-note" role="status">
          <span class="strip-note-text">revision {shown?.number} of {head}: an older version. Comments made here keep this revision; its actions do not run.</span>
          <a class="key" href={revisionHash(head)}>newest</a>
        </div>
      {/if}
      {#if loadError}<div class="strip-note bad" role="alert"><span class="strip-note-text">{loadError} — retrying</span></div>{/if}
      <!-- The document scrolls here, not the window: the comment key follows its selection. -->
      <div class="artifact-scroll" bind:this={scroller} onscroll={follow}>
        {#if meta}
          <p class="artifact-provenance">revision {meta.number} · {relTime(meta.createdAt)} · {provenance(meta)}</p>
        {/if}
        {#if shown?.actions.length}
          <section class="artifact-actions" aria-label="actions">
            {#each shown.actions as action (action.id)}
              {@const last = runs(action.id).at(-1)}
              <div class="artifact-action">
                <span class="lamp {last?.state === 'succeeded' ? 'on-green' : last?.state === 'failed' ? 'on-red' : last?.state === 'running' ? 'on-amber blink' : ''}" aria-hidden="true"></span>
                <div class="artifact-action-text">
                  <span class="artifact-action-label">{action.label}</span>
                  <span class="artifact-action-target">github.merge · {action.repository}#{action.pull} · head {action.headSha.slice(0, 12)} · {action.method}</span>
                  {#if last}<span class="artifact-action-run {last.state}">{last.state}: {last.detail}</span>{/if}
                  {#if last}
                    {#each told(last.id) as notice (notice.id)}
                      <span class="artifact-action-told"><span class="lamp mini {lamp(notice)}" aria-hidden="true"></span><span>{noticeText(notice)}</span></span>
                    {/each}
                  {/if}
                </div>
                <button class="key" onclick={() => openAction(action)} disabled={last?.state === "succeeded" || last?.state === "running"}>
                  {last?.state === "succeeded" ? "done" : "review…"}
                </button>
              </div>
            {/each}
          </section>
        {/if}
        {#if shownError}<p class="artifact-missing" role="alert">{shownError}</p>{/if}
        {#if rendered}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderArtifact prints raw html as text, keeps only http(s), mailto and #/ links, and draws diagrams as images -->
          <article class="markdown artifact-body" bind:this={body} onclick={onBodyClick} aria-describedby="artifact-select-hint">{@html rendered.html}</article>
        {/if}
        <p id="artifact-select-hint" class="artifact-hint">select text to comment on it{selectionNote ? ` — ${selectionNote}` : ""}</p>
      </div>
      {#if selection && !selection.away}
        <button class="key primary artifact-select-key" style={`left: ${selection.x}px; top: ${selection.y}px`}
          onpointerdown={(event) => event.preventDefault()} onclick={startComment} title="comment on the selection · c">comment</button>
      {/if}
    </section>
    <aside class="work-panel artifact-comments" aria-labelledby="comments-heading">
      <div class="work-head">
        <h2 id="comments-heading">comments</h2>
        <span class="work-summary">{drafts.length ? `${drafts.length} not sent · ` : ""}{sent.length} sent</span>
      </div>
      <div class="work-body">
        {#if pending}
          <form class="comment-composer" onsubmit={(event) => { event.preventDefault(); void saveComment(); }}>
            <blockquote class="work-quote">{pending.anchor.quote}</blockquote>
            <textarea bind:this={composer} bind:value={draftText} aria-label="comment" placeholder="what about it?" maxlength={4000} rows="3"
              onkeydown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveComment(); } if (event.key === "Escape") cancelComment(); }}></textarea>
            <div class="comment-keys">
              <button type="button" class="key" onclick={cancelComment}>cancel</button>
              <button type="submit" class="key primary" disabled={!draftText.trim() || saving}>{saving ? "saving…" : "add comment"}</button>
            </div>
          </form>
        {/if}
        {#if commentError}<p class="work-error" role="alert">{commentError}</p>{/if}
        {#if drafts.length}
          <ul class="work-list" aria-label="comments not sent">
            {#each drafts as comment (comment.id)}
              <li id={`comment-${comment.id}`} class="comment-item draft" class:focused={focused === comment.id}>
                <button class="work-quote comment-quote" onclick={() => locate(comment)} title="show in the document">{comment.anchor.quote}</button>
                <p class="comment-body">{comment.body}</p>
                <div class="comment-foot">
                  <span>{placeText(comment) || `revision ${comment.revision}`} · not sent</span>
                  <button class="work-dismiss" aria-label="delete this comment" title="delete" onclick={() => removeDraft(comment)}><Icon name="trash" size={13} /></button>
                </div>
              </li>
            {/each}
          </ul>
          <button class="key primary comment-send" onclick={send} disabled={sending}>
            {sending ? "sending…" : `send ${drafts.length} to ${artifact.author.kind === "optchat" ? "optchat" : "the thread"}`}
          </button>
          <p class="comment-hint">sent together as one message with the exact text each is about; {artifact.author.kind === "optchat" ? "it joins the chat's queue" : "a working thread gets it when its turn ends"}.</p>
        {:else if !pending && !sent.length}
          <p class="comment-hint">select text in the document, then press comment. Comments wait here until you send them to {author}.</p>
        {/if}
        {#if sent.length}
          <ul class="work-list comment-sent" aria-label="comments sent">
            {#each sent as comment (comment.id)}
              <li id={`comment-${comment.id}`} class="comment-item" class:focused={focused === comment.id}>
                <button class="work-quote comment-quote" onclick={() => locate(comment)} title="show in the document">{comment.anchor.quote}</button>
                <p class="comment-body">{comment.body}</p>
                <div class="comment-foot">
                  <span class="lamp mini {lamp(comment)}" aria-hidden="true"></span>
                  <span>{stateText(comment)}{placeText(comment) ? ` · ${placeText(comment)}` : ""}</span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </aside>
  </main>
{/if}

<dialog class="new-thread-dialog action-dialog" bind:this={dialog} aria-labelledby="action-title"
  oncancel={(event) => { if (running) event.preventDefault(); }} onclose={() => { confirming = null; }}>
  {#if confirming}
    <div class="new-thread-head">
      <h2 id="action-title">{confirming.label}</h2>
      <button type="button" class="key icon" aria-label="close" disabled={running} onclick={() => dialog?.close()}><Icon name="close" size={14} /></button>
    </div>
    <div class="action-body">
      <dl class="action-facts">
        <dt>action</dt><dd>github.merge · {confirming.method}</dd>
        <dt>repository</dt><dd>{confirming.repository}{preview?.project ? ` · project ${preview.project.name}` : ""}</dd>
        <dt>pull request</dt><dd>{#if preview?.pull}<a href={`https://github.com/${confirming.repository}/pull/${confirming.pull}`} target="_blank" rel="noopener noreferrer">#{confirming.pull} {preview.pull.title}</a>{preview.pull.author ? ` · by ${preview.pull.author}` : ""}{:else}#{confirming.pull}{/if}</dd>
        {#if preview?.pull}<dt>branches</dt><dd>{preview.pull.headRef} → {preview.pull.baseRef}</dd>{/if}
        <dt>reviewed head</dt><dd><code>{confirming.headSha}</code></dd>
        <dt>head now</dt><dd>{#if preview?.pull}<code>{preview.pull.headSha}</code>{:else}{checking ? "checking…" : "unknown"}{/if}</dd>
        {#if preview?.pull}<dt>github</dt><dd>{preview.pull.merged ? "merged" : preview.pull.state}{preview.pull.draft ? " · draft" : ""} · mergeable: {preview.pull.mergeable === null ? "not computed yet" : preview.pull.mergeable ? "yes" : "no"} ({preview.pull.mergeableState})</dd>{/if}
        <dt>document</dt><dd>revision {shown?.number} of {head}</dd>
      </dl>
      {#if checking}<p class="action-status">checking the pull request on github…</p>{/if}
      {#if preview?.problems.length && !actionResult}
        <ul class="action-problems" role="alert">{#each preview.problems as problem}<li>{problem}</li>{/each}</ul>
      {:else if preview && !actionResult}
        <p class="action-status">checked just now. Merging asks github to merge only while the head is still {confirming.headSha.slice(0, 12)}; it cannot be undone from cube.</p>
      {/if}
      {#if previewError}<p class="action-problems" role="alert">{previewError}</p>{/if}
      {#if actionResult}<p class="action-done" role="status">{actionResult}</p>{/if}
    </div>
    <div class="new-thread-footer action-footer">
      <button class="key" onclick={check} disabled={checking || running}>check again</button>
      <span class="spacer"></span>
      {#if actionResult}
        <button class="key" onclick={() => dialog?.close()}>close</button>
      {:else}
        <button class="key primary" onclick={confirmAction} disabled={!preview || !!preview.problems.length || checking || running}>
          {running ? "merging…" : `merge ${preview?.confirm ?? `${confirming.repository}#${confirming.pull}`}`}
        </button>
      {/if}
    </div>
  {/if}
</dialog>
