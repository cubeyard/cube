<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    checkProject,
    createProject,
    createUserThread,
    deleteProject,
    errorText,
    fetchProject,
    isNotFound,
    isUnreachable,
    updateProject,
  } from "../lib/api.ts";
  import { createArmed } from "../lib/armed.svelte.ts";
  import { relTime } from "../lib/time.ts";
  import { createTransient } from "../lib/transient.svelte.ts";
  import { uid } from "../lib/uid.ts";
  import type { Project, ProjectRepository } from "../lib/types.ts";
  import Onboarding from "./Onboarding.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";

  let { projectId, githubLogin = false, composeAt = 0 }: {
    projectId: string;
    githubLogin?: boolean;
    /** App's `n` shortcut: start a thread from this project. */
    composeAt?: number;
  } = $props();
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
  // The host said this id does not exist — as opposed to not answering.
  let notFound = $state(false);
  let saving = $state(false);
  let checking = $state(false);
  let starting = $state(false);
  // "saved" / "checked", printed beside the key that just succeeded.
  const done = createTransient();

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
      notFound = false;
    } catch (e) {
      if (seq !== refreshSeq) return;
      if (isNotFound(e)) notFound = true;
      // A lost host while the project is on screen is the app's strip to
      // report; before the first load it is this view's retry block.
      else if (!isUnreachable(e) || !project) error = errorText(e);
    }
    loaded = true;
  }

  onMount(() => {
    refresh(true);
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    document.title = `${isNew ? "new project" : (project?.name ?? "project")} · cube`;
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
    refreshSeq++; // a poll already in flight must not revert the saved form
    saving = true;
    error = null;
    try {
      if (isNew) {
        const created = await createProject(payload());
        location.hash = `#/projects/${created.id}`;
      } else {
        loadForm(await updateProject(projectId, payload()));
        done.set("saved");
      }
    } catch (e) {
      error = errorText(e);
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
      done.set("checked");
    } catch (e) {
      error = errorText(e);
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
      location.hash = `#/t/${id}`;
    } catch (e) {
      error = `new thread: ${errorText(e)}`;
      starting = false;
    }
  }

  $effect(() => {
    if (composeAt && Date.now() - composeAt < 2000) void startThread();
  });

  // ---- delete: two presses on the same key, never a dialog ----
  const armed = createArmed();
  let deleting = $state(false);
  async function remove(): Promise<void> {
    if (!project || project.threadCount > 0 || deleting) return;
    if (!armed.press("project")) return;
    deleting = true;
    refreshSeq++;
    try {
      await deleteProject(project.id);
      location.hash = "#/projects";
    } catch (e) {
      error = `delete: ${errorText(e)}`;
      deleting = false;
    }
  }

  // Every disabled key prints its reason; a title alone is invisible on a
  // phone and to anyone who does not hover.
  const checkDisabled = $derived(checking || dirty || project?.status === "checking");
  const startDisabled = $derived(starting || dirty || project?.status !== "ready");
  const workReason = $derived(
    !project || (!checkDisabled && !startDisabled) ? null
    : dirty ? "save your changes first"
    : checking || project.status === "checking" ? "checking the repositories…"
    : project.status === "error" ? "new thread waits for a passing check"
    : null,
  );
  const deleteDisabled = $derived(!project || project.threadCount > 0 || project.status === "checking" || deleting);
  const deleteReason = $derived(
    !project || !deleteDisabled || deleting ? null
    : project.threadCount > 0 ? `delete its ${project.threadCount === 1 ? "thread" : `${project.threadCount} threads`} first`
    : "wait for the check to finish",
  );

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
    location.hash = `#/projects/${projectId}`;
    if (connected) void recheck();
  }} />
{:else}
<Header section="projects" />
<main class="thread-list project-view">
  <div class="detail-back"><a href="#/projects">← projects</a></div>

  {#if !loaded}
    <p class="loading">loading…</p>
  {:else if !project && !isNew}
    {#if notFound}
      <div class="empty-state">
        <p class="hint">No such project — it may have been deleted.</p>
        <a class="key" href="#/projects">back to projects</a>
      </div>
    {:else}
      <div class="empty-state" role="status">
        <p class="hint">{error ?? "can't reach the host — it may be starting or restarting"}<br />retrying…</p>
        <button class="key" onclick={() => refresh(true)}>retry now</button>
      </div>
    {/if}
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

    {#if error}
      <div class="banner" role="alert">
        <span class="banner-text">{error}</span>
        <button class="key icon note-dismiss" title="dismiss" aria-label="dismiss error" onclick={() => (error = null)}>
          <Icon name="close" size={12} />
        </button>
      </div>
    {/if}
    {#if project?.error && !dirty && !project.repositories.some((repository) => repository.error && project?.error === `${repository.checkoutName}: ${repository.error}`)}
      <div class="banner"><span class="banner-text">{project.error}</span></div>
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
                <div><a class="key github-login-link" href={`#/projects/${projectId}/github`}>log in to github</a></div>
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
      {#if done.value === "saved"}<span class="key-reason" role="status">saved</span>{/if}
      {#if project}
        <button class="key" onclick={recheck} disabled={checkDisabled}>
          <Icon name="refresh" size={13} />{checking ? "checking…" : "check now"}
        </button>
        {#if done.value === "checked"}<span class="key-reason" role="status">checked</span>{/if}
        <button class="key" onclick={startThread} disabled={startDisabled}>
          <Icon name="plus" size={13} />{starting ? "starting…" : "new thread"}
        </button>
        {#if workReason}<span class="key-reason">{workReason}</span>{/if}
        <a class="key" href="#/threads?project={encodeURIComponent(project.id)}">
          {project.threadCount} {project.threadCount === 1 ? "thread" : "threads"}
        </a>
        <span class="action-spacer"></span>
        <span class="action-group">
          {#if armed.is("project")}
            <span class="key-reason bad" role="status">the project and its repository checks are removed; threads must be deleted first</span>
          {:else if deleteReason}
            <span class="key-reason">{deleteReason}</span>
          {/if}
          <button
            class="key danger-text"
            class:armed={armed.is("project")}
            onclick={remove}
            onkeydown={armed.onKeydown}
            onblur={() => armed.disarm()}
            disabled={deleteDisabled}
            title={armed.is("project") ? "press again to delete this project" : "delete project"}
            aria-label={armed.is("project") ? "confirm: delete this project" : "delete project"}
          >{deleting ? "deleting…" : armed.is("project") ? "delete?" : "delete project"}</button>
        </span>
      {/if}
    </div>
  {/if}
</main>
{/if}

<style>
  .github-login-link { font-family: var(--font-ui); }
</style>
