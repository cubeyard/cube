<script lang="ts">
  import { tick } from "svelte";
  import { ApiError, createUserThread, errorText, fetchModels, fetchProjects } from "../lib/api.ts";
  import type { ModelSelection, Project, ThreadModels } from "../lib/types.ts";
  import { uid } from "../lib/uid.ts";
  import Icon from "./Icon.svelte";

  let dialog: HTMLDialogElement;
  let input: HTMLTextAreaElement;
  let projects = $state<Project[]>([]);
  let catalog = $state<ThreadModels | null>(null);
  let projectId = $state("");
  let modelKey = $state("");
  let text = $state("");
  let loading = $state(false);
  let sending = $state(false);
  let loadError = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending = $state<{ requestId: string; projectId: string; text: string; model: ModelSelection } | null>(null);
  const key = (model: ModelSelection) => JSON.stringify([model.provider, model.id]);
  const model = $derived(catalog?.models.find((item) => key(item) === modelKey));
  const providers = $derived([...new Set(catalog?.models.map((item) => item.provider))]);
  const ready = $derived(projects.some((project) => project.id === projectId && project.status === "ready" && project.availableRunnerCount > 0));
  const canSend = $derived(!loading && !loadError && !sending && (pending !== null || (ready && model && text.trim())));

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [freshProjects, freshCatalog] = await Promise.all([fetchProjects(), fetchModels()]);
      projects = freshProjects;
      catalog = freshCatalog;
      if (!projectId && projects.length === 1 && projects[0]?.status === "ready") projectId = projects[0].id;
      if (!modelKey && catalog.selected) modelKey = key(catalog.selected);
    } catch (cause) {
      loadError = errorText(cause);
    } finally {
      loading = false;
    }
  }

  export async function open(preselectedProject?: string): Promise<void> {
    if (dialog.open) return;
    if (!pending) {
      projectId = preselectedProject ?? "";
      error = null;
    }
    dialog.showModal();
    await tick();
    input.focus();
    void load();
  }

  async function submit(): Promise<void> {
    if (!canSend) return;
    pending ??= { requestId: uid(), projectId, text: text.trim(), model: model! };
    sending = true;
    error = null;
    try {
      const id = await createUserThread(pending.projectId, pending.requestId, { text: pending.text, model: pending.model });
      pending = null;
      text = "";
      dialog.close();
      location.hash = `#/t/${id}`;
    } catch (cause) {
      error = errorText(cause);
      // An uncertain response must retry exactly the same creation. Explicit
      // rejection is safe to edit; never lose the draft in either case.
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) pending = null;
    } finally {
      sending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<dialog class="new-thread-dialog" bind:this={dialog} aria-labelledby="new-thread-title"
  oncancel={(event) => { event.stopPropagation(); if (sending) event.preventDefault(); }}>
  <form onsubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={sending}>
    <div class="new-thread-head">
      <h2 id="new-thread-title">new thread</h2>
      <button type="button" class="key icon" aria-label="close new thread" title="close · esc"
        disabled={sending} onclick={() => dialog.close()}><Icon name="close" size={14} /></button>
    </div>
    <textarea bind:this={input} bind:value={text} aria-label="first message" aria-describedby="new-thread-hint"
      placeholder="what would you like to work on?" maxlength={100000} required
      readonly={pending !== null} onkeydown={onKeydown}></textarea>
    <div class="new-thread-status" aria-live="polite">
      {#if loading}<p>reading projects and models…</p>
      {:else if loadError}<p class="error" role="alert">{loadError} <button type="button" class="key" onclick={load}>retry loading</button></p>
      {:else if !projects.some((project) => project.status === "ready")}
        <p>a ready project is required. <a href="#/projects" onclick={() => dialog.close()}>configure a project</a></p>
      {:else if projects.find((project) => project.id === projectId)?.runnerCapacity.states.failed}
        <p class="error">runner workspace unavailable — {projects.find((project) => project.id === projectId)?.runnerCapacity.errors[0] ?? "inspect the runner logs"}. <button type="button" class="key" onclick={load}>retry status</button></p>
      {:else if !ready}<p>all trusted runners are in use; archive an idle thread or register another runner, then <button type="button" class="key" onclick={load}>refresh runners</button></p>
      {:else if !catalog?.models.length}<p>no models available — <a href="#/models" onclick={() => dialog?.close()}>connect a provider</a>, then <button type="button" class="key" onclick={load}>retry loading</button></p>
      {:else if !model}<p>choose an available model below.</p>{/if}
      {#if error}<p class="error" role="alert">{error}{pending ? " — retry to confirm this thread; your message is kept." : ""}</p>{/if}
    </div>
    <div class="new-thread-footer">
      <label><span>project</span>
        <select aria-label="project for new thread" bind:value={projectId} disabled={loading || pending !== null} required>
          <option value="" disabled>choose project</option>
          {#each projects as project (project.id)}
            <option value={project.id} disabled={project.status !== "ready"}>{project.name}{project.status === "ready" ? ` — ${project.availableRunnerCount} available` : ` — ${project.status}`}</option>
          {/each}
        </select>
      </label>
      <label><span>model</span>
        <select aria-label="model for new thread" bind:value={modelKey} disabled={loading || pending !== null} required>
          <option value="" disabled>choose model</option>
          {#if modelKey && !model}<option value={modelKey} disabled>unavailable — choose model</option>{/if}
          {#each providers as provider}
            <optgroup label={provider}>
              {#each catalog?.models.filter((item) => item.provider === provider) ?? [] as item}
                <option value={key(item)}>{item.id}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </label>
      <button class="key primary new-thread-submit" type="submit" disabled={!canSend}
        title="start thread · enter" aria-label={sending ? "starting thread" : pending ? "retry starting thread" : "start thread"}>
        {#if sending}<span>starting…</span>{:else if pending}<span>retry</span>{:else}<Icon name="arrow" size={18} />{/if}
      </button>
    </div>
    <p id="new-thread-hint" class="new-thread-hint">enter to start · shift enter for a new line</p>
  </form>
</dialog>
