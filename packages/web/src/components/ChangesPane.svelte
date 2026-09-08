<script lang="ts">
  import { fetchDiff, repositoryFileUrl } from "../lib/api.ts";
  import type { RepoDiff, RepoDiffSection, ThreadRepository } from "../lib/types.ts";
  import Icon from "./Icon.svelte";

  let {
    threadId,
    repository,
    repositoriesReady,
    repositoriesError,
  }: {
    threadId: string;
    repository: ThreadRepository | null;
    repositoriesReady: boolean;
    repositoriesError: string | null;
  } = $props();

  type ChangeLayer = "committed" | "staged" | "unstaged";

  type Change = {
    id: string;
    layer: ChangeLayer;
    path: string;
    additions: number | null;
    deletions: number | null;
    patch: string | null;
    truncated: boolean;
    untracked: boolean;
    untrackedContent: UntrackedContent | null;
  };

  type ChangeGroup = {
    key: ChangeLayer;
    label: string;
    changes: Change[];
  };

  type UntrackedContent =
    | { kind: "loading" }
    | { kind: "text"; lines: string[] }
    | { kind: "message"; text: string };

  type DiffRow =
    | { kind: "collapsed"; count: number }
    | {
        kind: "context" | "add" | "del" | "meta";
        text: string;
        oldLine: number | null;
        newLine: number | null;
      };

  let diff = $state<RepoDiff | null>(null);
  let diffError = $state<string | null>(null);
  let refreshing = $state(false);
  let openChangeId = $state<string | null>(null);
  let untrackedFiles = $state<Record<string, UntrackedContent>>({});
  let diffRequest = 0;
  // Repository polling replaces the repository object even when the selected
  // repository is unchanged. Keep effects keyed to its stable ID so each
  // metadata poll does not clear and reload the visible diff.
  const repositoryId = $derived(repository?.id);
  const UNTRACKED_PREVIEW_MAX_BYTES = 1_000_000;

  /** Git emits one `diff --git` section per numstat row, in the same order. */
  function splitPatch(patch: string): string[] {
    const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
    if (starts.length === 0) return patch ? [patch] : [];
    return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length).trimEnd());
  }

  /** Turn a unified patch into editor-like rows with line numbers. Hunk
   * coordinates tell us exactly how much unchanged context Git omitted. */
  function diffRows(patch: string): DiffRow[] {
    const rows: DiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let seenHunk = false;

    for (const line of patch.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        const nextOld = Number(hunk[1]);
        const nextNew = Number(hunk[2]);
        const unchanged = seenHunk
          ? Math.min(nextOld - oldLine, nextNew - newLine)
          : Math.min(nextOld - 1, nextNew - 1);
        if (unchanged > 0) rows.push({ kind: "collapsed", count: unchanged });
        oldLine = nextOld;
        newLine = nextNew;
        inHunk = true;
        seenHunk = true;
        continue;
      }
      if (!inHunk) {
        if (line.startsWith("Binary files ") || line === "GIT binary patch") {
          rows.push({ kind: "meta", text: line, oldLine: null, newLine: null });
        }
        continue;
      }
      if (line.startsWith("+")) {
        rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
      } else if (line.startsWith("-")) {
        rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
      } else if (line.startsWith("\\")) {
        rows.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      } else {
        rows.push({
          kind: "context",
          text: line.startsWith(" ") ? line.slice(1) : line,
          oldLine: oldLine++,
          newLine: newLine++,
        });
      }
    }
    return rows;
  }

  const fileName = (filePath: string) => filePath.split("/").pop() ?? filePath;
  const fileDir = (filePath: string) => filePath.split("/").slice(0, -1).join("/");
  const fileStatus = (change: Change) =>
    change.untracked ? "u"
    : change.patch?.includes("\nnew file mode ") ? "a"
    : change.patch?.includes("\ndeleted file mode ") ? "d"
    : "m";

  function trackedChanges(layer: ChangeLayer, section: RepoDiffSection): Change[] {
    const patches = splitPatch(section.patch);
    return section.files.map((file, index) => ({
      id: `${layer}:${file.path}`,
      layer,
      ...file,
      patch: patches[index] ?? null,
      truncated: section.truncated,
      untracked: false,
      untrackedContent: null,
    }));
  }

  const changeGroups = $derived.by<ChangeGroup[]>(() => {
    if (!diff) return [];
    const untracked: Change[] = diff.untracked.map((path) => ({
      id: `unstaged:${path}`,
      layer: "unstaged",
      path,
      additions: null,
      deletions: null,
      patch: null,
      truncated: false,
      untracked: true,
      untrackedContent: untrackedFiles[path] ?? null,
    }));
    const groups: ChangeGroup[] = [
      { key: "committed", label: "committed", changes: trackedChanges("committed", diff.committed) },
      { key: "staged", label: "staged", changes: trackedChanges("staged", diff.staged) },
      { key: "unstaged", label: "unstaged", changes: [...trackedChanges("unstaged", diff.unstaged), ...untracked] },
    ];
    return groups.filter((group) => group.changes.length > 0);
  });

  const anyTruncated = $derived(
    Boolean(diff?.committed.truncated || diff?.staged.truncated || diff?.unstaged.truncated),
  );

  async function loadUntracked(path: string): Promise<void> {
    const requestedRepositoryId = repositoryId;
    if (requestedRepositoryId === undefined) return;
    untrackedFiles[path] = { kind: "loading" };
    const update = (content: UntrackedContent): boolean => {
      if (repositoryId !== requestedRepositoryId) return false;
      untrackedFiles[path] = content;
      return true;
    };
    try {
      const response = await fetch(repositoryFileUrl(threadId, requestedRepositoryId, path));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const size = Number(response.headers.get("content-length"));
      if (Number.isFinite(size) && size > UNTRACKED_PREVIEW_MAX_BYTES) {
        await response.body?.cancel();
        update({
          kind: "message",
          text: "new file is too large to render inline (limit 1 MB).",
        });
        return;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.includes(0) || response.headers.get("content-type")?.startsWith("image/")) {
        update({ kind: "message", text: "new binary file — no text preview available." });
        return;
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        update({ kind: "message", text: "new binary file — no text preview available." });
        return;
      }
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      update({
        kind: "text",
        lines: lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line),
      });
    } catch (error) {
      update({
        kind: "message",
        text: `new file unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function refresh(): Promise<void> {
    const requestedRepositoryId = repositoryId;
    if (requestedRepositoryId === undefined) return;
    const request = ++diffRequest;
    refreshing = true;
    try {
      const fresh = await fetchDiff(threadId, requestedRepositoryId);
      if (request !== diffRequest || repositoryId !== requestedRepositoryId) return;
      diff = fresh;
      diffError = null;
      if (openChangeId) {
        const separator = openChangeId.indexOf(":");
        const layer = openChangeId.slice(0, separator) as ChangeLayer;
        const path = openChangeId.slice(separator + 1);
        const section = fresh[layer];
        if (!section.files.some((file) => file.path === path) && !(layer === "unstaged" && fresh.untracked.includes(path))) {
          openChangeId = null;
        }
      }
    } catch (error) {
      if (request !== diffRequest) return;
      diffError = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === diffRequest) refreshing = false;
    }
  }

  $effect(() => {
    // Track the route and stable repository ID, not the repository object:
    // ThreadView refreshes that object's branch metadata every ten seconds.
    const selectedThreadId = threadId;
    const selectedRepositoryId = repositoryId;
    diffRequest += 1;
    diff = null;
    diffError = null;
    openChangeId = null;
    untrackedFiles = {};
    if (!repositoriesReady || selectedRepositoryId === undefined) {
      return;
    }
    // Start outside the effect's dependency tracking: refresh reads and
    // writes its own request state, which must not restart this interval.
    queueMicrotask(() => {
      if (threadId === selectedThreadId) void refresh();
    });
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  });

  function toggle(change: Change): void {
    if (openChangeId === change.id) {
      openChangeId = null;
      return;
    }
    openChangeId = change.id;
    if (change.untracked) void loadUntracked(change.path);
  }
</script>

<aside class="workspace-pane changes-pane" aria-label="workspace">
  <div class="workspace-pane-head workspace-tabs">
    <div class="tab-bank">
      <span class="workspace-tab active">changes</span>
    </div>
    <span class="pane-meta" title={repository?.url}>workspace</span>
  </div>

    <div class="changes-body" id="changes-panel" aria-busy={refreshing && !diff}>
      {#if repositoriesError && !repositoriesReady}
        <div class="changes-state bad">
          <p>repositories unavailable: {repositoriesError}</p>
        </div>
      {:else if !repositoriesReady}
        <div class="changes-state"><p>reading repositories…</p></div>
      {:else if !repository}
        <div class="changes-state"><p>this thread has no repository.</p></div>
      {:else if diffError && !diff}
        <div class="changes-state bad">
          <p>changes unavailable: {diffError}</p>
          <button class="key" onclick={refresh}>retry</button>
        </div>
      {:else if !diff}
        <div class="changes-state"><p>reading changes…</p></div>
      {:else if changeGroups.length === 0}
        <div class="changes-state"><p>no changes yet — the working tree matches its base.</p></div>
      {:else}
        {#if diffError}
          <p class="changes-notice bad">refresh failed — showing the last result</p>
        {:else if anyTruncated}
          <p class="changes-notice">large patch — later file diffs may be omitted</p>
        {/if}

        {#each changeGroups as group (group.key)}
          <section class="change-group" aria-labelledby={`change-group-${group.key}`}>
            <h3 class="change-group-head" id={`change-group-${group.key}`}>
              <span>{group.label}</span><span>{group.changes.length}</span>
            </h3>
            <ul class="changes-list">
              {#each group.changes as change (change.id)}
                <li class:open={openChangeId === change.id}>
                  <button
                    class="change-file"
                    title={change.path}
                    aria-expanded={openChangeId === change.id}
                    onclick={() => toggle(change)}
                  >
                    <span class="change-chevron" class:open={openChangeId === change.id}>
                      <Icon name="chevron" size={13} />
                    </span>
                    <span class="change-identity">
                      <span class="change-name">{fileName(change.path)}</span>
                      {#if fileDir(change.path)}<span class="change-dir">{fileDir(change.path)}</span>{/if}
                    </span>
                    <span class="change-stat">
                      {#if change.untracked}
                        {#if change.untrackedContent?.kind === "text"}
                          <span class="stat-add">+{change.untrackedContent.lines.length}</span>
                        {:else}
                          untracked
                        {/if}
                      {:else if change.additions === null || change.deletions === null}
                        binary
                      {:else}
                        <span class="stat-add">+{change.additions}</span>
                        <span class="stat-del">−{change.deletions}</span>
                      {/if}
                    </span>
                    <span class="change-status">{fileStatus(change)}</span>
                  </button>

                  {#if openChangeId === change.id}
                    {#if change.untracked}
                      {#if !change.untrackedContent || change.untrackedContent.kind === "loading"}
                        <div class="inline-diff">
                          <p class="inline-diff-note">loading new file…</p>
                        </div>
                      {:else if change.untrackedContent.kind === "message"}
                        <div class="inline-diff">
                          <p class="inline-diff-note">{change.untrackedContent.text}</p>
                        </div>
                      {:else if change.untrackedContent.lines.length === 0}
                        <div class="inline-diff">
                          <p class="inline-diff-note">new empty file</p>
                        </div>
                      {:else}
                        <!-- svelte-ignore a11y_no_noninteractive_tabindex: keyboard focus is required to scroll the diff horizontally -->
                        <div class="inline-diff scrollable" role="region" tabindex="0" aria-label={`new file ${change.path}`}>
                          <div class="diff-lines">
                            {#each change.untrackedContent.lines as line, index}
                              <div class="diff-line add">
                                <span class="diff-line-number" aria-hidden="true">{index + 1}</span>
                                <span class="diff-marker" aria-hidden="true">+</span>
                                <span class="diff-code-text">{line || " "}</span>
                              </div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    {:else if !change.patch}
                      <div class="inline-diff">
                        <p class="inline-diff-note">
                          {change.truncated ? "diff omitted because the patch limit was reached." : "no text diff available for this file."}
                        </p>
                      </div>
                    {:else}
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex: keyboard focus is required to scroll the diff horizontally -->
                      <div class="inline-diff scrollable" role="region" tabindex="0" aria-label={`diff for ${change.path}`}>
                        <div class="diff-lines">
                          {#each diffRows(change.patch) as row}
                            {#if row.kind === "collapsed"}
                              <div class="diff-collapsed">
                                <span class="diff-line-number" aria-hidden="true">⋯</span>
                                <span>{row.count} unchanged {row.count === 1 ? "line" : "lines"}</span>
                              </div>
                            {:else}
                              <div class="diff-line" class:add={row.kind === "add"} class:del={row.kind === "del"} class:meta={row.kind === "meta"}>
                                <span class="diff-line-number" aria-hidden="true">{row.kind === "del" ? row.oldLine : row.newLine}</span>
                                <span class="diff-marker" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</span>
                                <span class="diff-code-text">{row.text || " "}</span>
                              </div>
                            {/if}
                          {/each}
                        </div>
                      </div>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>
</aside>
