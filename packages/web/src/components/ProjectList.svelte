<script lang="ts">
  import { onMount } from "svelte";
  import { checkProject, errorText, fetchProjects, isUnreachable } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import { createTransient } from "../lib/transient.svelte.ts";
  import type { Project } from "../lib/types.ts";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  let projects = $state<Project[]>([]);
  // True once the list has arrived at least once; a failed poll is not
  // an empty list, and must not read as "configure your first project".
  let loaded = $state(false);
  let unreachable = $state(false);
  let error = $state<string | null>(null);
  let checking = $state<string | null>(null);
  // "checked" printed in the row whose check just landed, for a moment.
  const checked = createTransient();
  let refreshSeq = 0;

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq;
    try {
      const fresh = await fetchProjects();
      if (seq !== refreshSeq) return;
      projects = fresh;
      error = null;
      unreachable = false;
      loaded = true;
    } catch (e) {
      if (seq !== refreshSeq) return;
      // A host that does not answer is the app's strip to report.
      unreachable = isUnreachable(e);
      if (!unreachable) error = errorText(e);
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  });

  async function recheck(project: Project): Promise<void> {
    if (checking) return;
    checking = project.id;
    try {
      await checkProject(project.id);
      error = null;
      await refresh();
      checked.set(project.id);
    } catch (e) {
      error = `check: ${errorText(e)}`;
    } finally {
      checking = null;
    }
  }

  const lampClass = (project: Project) =>
    project.status === "checking" ? "on-amber blink"
    : project.status === "error" ? "on-red"
    : "on-green";

  const repoShort = (url: string) => url.replace(/\.git$/, "").split("/").slice(-2).join("/");
</script>

<Header section="projects" />
<main class="thread-list project-list">
  <div class="list-head">
    <div>
      <h1>projects</h1>
      <p class="list-intro">repository inputs, checked before work starts</p>
    </div>
    <a class="key primary" href="#/projects/new"><Icon name="plus" size={13} />new project</a>
  </div>

  {#if error}
    <div class="banner" role="alert">
      <span class="banner-text">{error}</span>
      <button class="key icon note-dismiss" title="dismiss" aria-label="dismiss error" onclick={() => (error = null)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  {/if}

  {#if projects.length > 0}
    <div class="well">
      {#each projects as project (project.id)}
        <div class="module project-module">
          <a class="module-face" href="#/projects/{project.id}">
            <span class="lamp {lampClass(project)}" aria-hidden="true"></span>
            <span class="module-text">
              <span class="module-title">{project.name}</span>
              <span class="module-meta project-summary">
                <span class="state-label" class:error={project.status === "error"}>{project.status}</span>
                <span>{project.repositories.length} {project.repositories.length === 1 ? "repository" : "repositories"}</span>
                <span>{project.threadCount} {project.threadCount === 1 ? "thread" : "threads"}</span>
                {#if project.checkedAt}
                  <span title={new Date(project.checkedAt).toLocaleString()}>checked {relTime(project.checkedAt)}</span>
                {/if}
              </span>
              <span class="project-repo-line">
                {#each project.repositories as repository, index (repository.id)}
                  {#if index > 0}<span aria-hidden="true">·</span>{/if}
                  <span title={repository.url}>{repoShort(repository.url)}</span>
                {/each}
              </span>
              {#if project.error}<span class="module-error">{project.error}</span>{/if}
            </span>
          </a>
          <div class="module-actions">
            {#if checked.value === project.id}<span class="bank-note" role="status">checked</span>{/if}
            <button
              class="key icon"
              title="check repositories now"
              aria-label={`check ${project.name} repositories now`}
              disabled={project.status === "checking" || checking === project.id}
              onclick={() => recheck(project)}
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {:else if loaded && !error}
    <div class="empty-state">
      <p class="hint">A project owns the repositories every thread starts with.<br />Configure one primary checkout to begin.</p>
      <a class="key primary" href="#/projects/new"><Icon name="plus" size={13} />new project</a>
    </div>
  {:else if !loaded}
    <div class="empty-state" role="status">
      <p class="hint">{unreachable ? "can't reach the host — it may be starting or restarting" : "reading projects…"}{#if unreachable}<br />retrying…{/if}</p>
      {#if unreachable || error}<button class="key" onclick={refresh}>retry now</button>{/if}
    </div>
  {/if}
</main>
