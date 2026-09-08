<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    checkProject,
    createProject,
    createUserThread,
    deleteProject,
    fetchProject,
    updateProject,
  } from "../lib/api.ts";
  import { relTime } from "../lib/time.ts";
  import { uid } from "../lib/uid.ts";
  import type { Project, ProjectRepository } from "../lib/types.ts";
  import Onboarding from "./Onboarding.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  let { projectId, githubLogin = false }: { projectId: string; githubLogin?: boolean } = $props();
  const isNew = $derived(projectId === "new");
  type RepositoryDraft = { key: string; url: string; base: string; checkoutName: string };

  let project = $state<Project | null>(null);
  let name = $state("");
  let repositories = $state<RepositoryDraft[]>([
    { key: uid(), url: "", base: "", checkoutName: "workspace" },
  ]);
  let dirty = $state(untrack(() => projectId === "new"));
  let loaded = $state(untrack(() => projectId === "new"));
  let error = $state<string | null>(null);
  let saving = $state(false);
  let checking = $state(false);
  let starting = $state(false);

  function loadForm(fresh: Project): void {
    project = fresh;
    name = fresh.name;
    repositories = fresh.repositories.map((repository) => ({
      key: repository.id,
      url: repository.url,
      base: repository.base ?? "",
      checkoutName: repository.checkoutName,
    }));
    dirty = false;
  }

  let refreshSeq = 0;
  async function refresh(resetForm = false): Promise<void> {
    if (isNew) return;
    const seq = ++refreshSeq;
    try {
      const fresh = await fetchProject(projectId);
      if (seq !== refreshSeq) return;
      if (resetForm || !project || !dirty) loadForm(fresh);
      else project = fresh;
      error = null;
    } catch (e) {
      if (seq !== refreshSeq) return;
      error = String(e);
    }
    loaded = true;
  }

  onMount(() => {
    refresh(true);
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  });

  function changed(): void {
    dirty = true;
    error = null;
  }

  function addRepository(): void {
    repositories.push({ key: uid(), url: "", base: "", checkoutName: "" });
    changed();
  }

  function removeRepository(index: number): void {
    if (index === 0) return;
    repositories.splice(index, 1);
    changed();
  }

  function payload() {
    return {
      name,
      repositories: repositories.map((repository, index) => ({
        url: repository.url,
        base: repository.base.trim() || null,
        ...(index === 0 ? {} : { checkoutName: repository.checkoutName }),
      })),
    };
  }

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    error = null;
    try {
      if (isNew) {
        const created = await createProject(payload());
        location.hash = `#/projects/${encodeURIComponent(created.id)}`;
      } else {
        loadForm(await updateProject(projectId, payload()));
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function recheck(): Promise<void> {
    if (checking || isNew || dirty) return;
    checking = true;
    error = null;
    try {
      project = await checkProject(projectId);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
    }
  }

  async function startThread(): Promise<void> {
    if (starting || !project || project.status !== "ready" || dirty) return;
    starting = true;
    error = null;
    try {
      const id = await createUserThread(project.id);
      location.hash = `#/t/${encodeURIComponent(id)}`;
    } catch (e) {
      error = `new thread: ${e instanceof Error ? e.message : e}`;
      starting = false;
    }
  }

  async function remove(): Promise<void> {
    if (!project || project.threadCount > 0) return;
    if (!confirm(`Delete project "${project.name}"? Its prepared repository configuration will be removed.`)) return;
    try {
      await deleteProject(project.id);
      location.hash = "#/projects";
    } catch (e) {
      error = `delete: ${e instanceof Error ? e.message : e}`;
    }
  }

  const evidence = (index: number): ProjectRepository | null => project?.repositories[index] ?? null;
  const lampClass = (status: ProjectRepository["status"] | undefined) =>
    status === "checking" ? "on-amber blink"
    : status === "error" ? "on-red"
    : status === "ready" ? "on-green"
    : "off";
  const focusSelect = (element: HTMLInputElement) => {
    if (!isNew) return;
    element.focus();
    element.select();
  };
</script>

{#if githubLogin}
  <Onboarding projectLogin onComplete={(connected) => {
    location.hash = `#/projects/${encodeURIComponent(projectId)}`;
    if (connected) void recheck();
  }} />
{:else}
<Header section="projects" />
<main class="thread-list project-view">
  <div class="detail-back"><a href="#/projects">← projects</a></div>

  {#if !loaded}
    <p class="loading">loading…</p>
  {:else}
    <div class="project-detail-head">
      <div>
        <p class="silk">{isNew ? "new project" : "project switchboard"}</p>
        <h1>{isNew ? "configure project" : project?.name}</h1>
      </div>
      {#if project}
        <div class="project-state-readout">
          <span class="lamp {lampClass(project.status)}" aria-hidden="true"></span>
          <span>{project.status}</span>
          {#if project.checkedAt}
            <span title={new Date(project.checkedAt).toLocaleString()}>· checked {relTime(project.checkedAt)}</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if error}<div class="banner">{error}</div>{/if}
    {#if project?.error && !dirty && !project.repositories.some((repository) => repository.error && project?.error === `${repository.checkoutName}: ${repository.error}`)}
      <div class="banner">{project.error}</div>
    {/if}

    <section class="project-config" aria-label="project configuration">
      <label class="config-field project-name-field">
        <span class="silk">project name</span>
        <input
          class="compose-input"
          aria-label="project name"
          placeholder="e.g. cube"
          bind:value={name}
          oninput={changed}
          use:focusSelect
        />
      </label>

      <div class="board-head">
        <div>
          <h2>repositories</h2>
          <p>work in /workspace · references at ../repos/&lt;checkout&gt;</p>
        </div>
        <button class="key" onclick={addRepository}><Icon name="plus" size={13} />add reference</button>
      </div>

      <div class="repository-board well">
        {#each repositories as repository, index (repository.key)}
          {@const checked = evidence(index)}
          <div class="repository-row">
            <div class="repository-role">
              <span class="lamp {lampClass(checked?.status)}" aria-hidden="true"></span>
              <span>
                <strong>{index === 0 ? "primary" : `reference ${index}`}</strong>
                <small>{index === 0 ? "/workspace" : `../repos/${repository.checkoutName || "…"}`}</small>
              </span>
            </div>
            <div class="repository-fields">
              <label class="config-field repo-url-field">
                <span class="silk">repository</span>
                <input
                  class="compose-input"
                  aria-label={`repository ${index + 1} URL`}
                  placeholder="owner/name or git URL"
                  bind:value={repository.url}
                  oninput={changed}
                />
              </label>
              <label class="config-field">
                <span class="silk">base</span>
                <input
                  class="compose-input"
                  aria-label={`repository ${index + 1} base branch`}
                  placeholder="default"
                  bind:value={repository.base}
                  oninput={changed}
                />
              </label>
              {#if index > 0}
                <label class="config-field">
                  <span class="silk">checkout</span>
                  <input
                    class="compose-input"
                    aria-label={`repository ${index + 1} checkout name`}
                    placeholder="repo-name"
                    bind:value={repository.checkoutName}
                    oninput={changed}
                  />
                </label>
              {/if}
            </div>
            <div class="repository-evidence">
              {#if dirty}
                <span>not checked</span>
              {:else if checked?.status === "ready"}
                <span title={checked.baseOid ?? undefined}>{checked.resolvedBase} @ {checked.baseOid?.slice(0, 8)}</span>
              {:else if checked?.status === "checking"}
                <span>checking access and branch…</span>
              {:else if checked?.error?.startsWith("github: not connected")}
                <span class="error">{checked.error}</span>
                <div><a class="key github-login-link" href={`#/projects/${encodeURIComponent(projectId)}/github`}>log in to github</a></div>
              {:else if checked?.error}
                <span class="error">{checked.error}</span>
              {:else}
                <span>not checked</span>
              {/if}
            </div>
            {#if index > 0}
              <button
                class="key icon danger repository-remove"
                title="remove repository"
                aria-label={`remove repository ${index + 1}`}
                onclick={() => removeRepository(index)}
              ><Icon name="trash" size={13} /></button>
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <div class="project-actions">
      <button class="key primary" onclick={save} disabled={saving || !dirty}>
        {saving ? "saving…" : isNew ? "save & check" : "save changes"}
      </button>
      {#if project}
        <button class="key" onclick={recheck} disabled={checking || dirty || project.status === "checking"}>
          <Icon name="refresh" size={13} />{checking ? "checking…" : "check now"}
        </button>
        <button class="key" onclick={startThread} disabled={starting || dirty || project.status !== "ready"}>
          <Icon name="plus" size={13} />{starting ? "starting…" : "new thread"}
        </button>
        <a class="key" href="#/threads?project={encodeURIComponent(project.id)}">
          {project.threadCount} {project.threadCount === 1 ? "thread" : "threads"}
        </a>
        <span class="action-spacer"></span>
        <button
          class="key danger-text"
          onclick={remove}
          disabled={project.threadCount > 0 || project.status === "checking"}
          title={project.threadCount > 0 ? "delete the project's threads first" : "delete project"}
        >delete project</button>
      {/if}
    </div>
  {/if}
</main>
{/if}

<style>
  .github-login-link { font-family: var(--font-ui); }
</style>
