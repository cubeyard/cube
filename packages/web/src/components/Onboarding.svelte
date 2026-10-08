<script lang="ts">
  import { onMount, tick } from "svelte";
  import GithubConnect from "./GithubConnect.svelte";
  import Wordmark from "./Wordmark.svelte";
  import { completeOnboarding, disconnectGithub, errorText, fetchSettings, setCompactor } from "../lib/api.ts";
  import type { GithubAuthStatus, ModelSelection, SettingsView } from "../lib/types.ts";

  let { onComplete, projectLogin = false }: {
    onComplete: (connected: boolean) => void;
    projectLogin?: boolean;
  } = $props();
  let step = $state<1 | 2>(1);
  let github = $state<GithubAuthStatus>({ state: "disconnected" });
  let loginBusy = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let heading = $state<HTMLHeadingElement>();

  // The chat's memory model: the chat's own unless chosen here (or later in settings).
  const FOLLOW = "";
  const modelKey = (model: ModelSelection | null) => (model ? JSON.stringify({ provider: model.provider, id: model.id }) : FOLLOW);
  let memory = $state<SettingsView | null>(null);
  let memoryChoice = $state(FOLLOW);

  async function loadMemory() {
    try {
      memory = await fetchSettings();
      memoryChoice = modelKey(memory.compactor.saved);
    } catch {
      // Not offered then: it stays on its default and is chosen in settings.
      memory = null;
    }
  }

  onMount(() => { heading?.focus(); });

  async function next() {
    saving = true;
    error = null;
    try {
      // Skipping must not leave a login process waiting in the background.
      if (github.state === "pending") github = await disconnectGithub();
      if (projectLogin) {
        onComplete(github.state === "connected");
        return;
      }
      step = 2;
      // Loaded once: back and continue keep a choice not saved yet.
      if (!memory) void loadMemory();
      await tick();
      heading?.focus();
    } catch (e) {
      error = errorText(e);
    } finally {
      saving = false;
    }
  }

  async function back() {
    step = 1;
    error = null;
    await tick();
    heading?.focus();
  }

  async function finish() {
    saving = true;
    error = null;
    try {
      if (memory && memoryChoice !== modelKey(memory.compactor.saved)) {
        await setCompactor(memory.models?.find((model) => modelKey(model) === memoryChoice) ?? null);
      }
      await completeOnboarding();
      onComplete(github.state === "connected");
    } catch (e) {
      error = `could not save setup — ${errorText(e)}`;
      saving = false;
    }
  }
</script>

<header class="setup-header">
  <Wordmark />
  <span class="spacer"></span>
  {#if projectLogin}
    <span class="setup-label">github login</span>
  {:else}
    <span class="setup-label" aria-label={`setup, step ${step} of 2`}>setup <span class="step-count">{step} / 2</span></span>
  {/if}
</header>

<main class="onboarding">
  {#if step === 1}
    <h1 bind:this={heading} tabindex="-1">connect github?</h1>
    <p class="intro">Bring your repositories into cube. Clone private code, push changes, and open pull requests with the normal GitHub CLI login.</p>

    <div class="choices" aria-label="github login">
      <GithubConnect onStatusChange={(status) => { github = status; }} onBusyChange={(busy) => { loginBusy = busy; }} />
      {#if github.state === "connected"}
        <button class="key primary" onclick={next} disabled={saving || loginBusy}>{projectLogin ? "return to project" : "continue"}</button>
      {:else}
        <button class="key" onclick={next} disabled={saving}>{saving ? "cancelling login…" : projectLogin ? "back to project" : "not now"}</button>
      {/if}
    </div>
    <p class="later">{projectLogin ? "Your project stays as you left it. We’ll check repository access when you return after login." : "You can always log in later from a project."}</p>

    <div class="access-note">
      <p>The host runs <code>gh auth login</code>. You approve <strong>GitHub CLI</strong> in your browser, not a separate app.</p>
      <p>GitHub CLI keeps the credentials on the host. A thread’s machine sees only a placeholder; cube’s gateway adds the token to requests to GitHub.</p>
      <p>This is standard GitHub CLI access, not per-repository access.</p>
      <details>
        <summary>before connecting work code</summary>
        <p>You authorize GitHub CLI, not a separate Cube app. Review your organization’s policy and the permissions shown by GitHub before approving.</p>
      </details>
    </div>
  {:else}
    <h1 bind:this={heading} tabindex="-1">make yourself at home.</h1>
    <p class="intro">Tell the chat what you want done. It starts threads in your projects, each an agent in its own isolated environment, and reports back. Add a project first: choose a repository and check access.</p>
    <p class="account">{github.state === "connected" ? `github connected as ${github.login}` : "github skipped — connect whenever you need it"}</p>
    {#if memory}
      <div class="memory">
        <label for="setup-memory">chat memory</label>
        <p>The chat keeps everything you said by folding older messages into short summaries. The chat’s own model writes them unless you pick a cheaper one.</p>
        <select id="setup-memory" bind:value={memoryChoice} disabled={saving}>
          <option value={FOLLOW}>follow the chat’s model</option>
          {#each memory.models ?? [] as model}<option value={modelKey(model)}>{model.provider}/{model.id}</option>{/each}
        </select>
        {#if !memory.models}<p class="later">{memory.error ?? "The models could not be listed."} You can choose later under settings › chat memory.</p>
        {:else if !memory.models.length}<p class="later">Connect a model provider to choose another. You can change this any time under settings › chat memory.</p>{/if}
      </div>
    {/if}
    <div class="choices">
      <button class="key primary" onclick={finish} disabled={saving}>{saving ? "saving…" : "open the chat"}</button>
      <button class="key" onclick={back} disabled={saving}>back</button>
    </div>
    <div class="access-note">
      <p>This setup is remembered on the host.</p>
      <p>Model-provider login is separate. Set it up when you start a thread. Model providers, chat memory and system live under settings.</p>
    </div>
  {/if}
  {#if error}<p class="setup-error" role="alert">{error}</p>{/if}
</main>

<style>
  .setup-header { padding: 1.8rem 2.4rem; border: 0; box-shadow: none; }
  .setup-label { display: flex; gap: 1.4rem; color: var(--ink-3); font-size: 12px; }
  .step-count { font-variant-numeric: tabular-nums; }
  /* centred in the viewport, scrolling only when it must */
  .onboarding { flex: 0 1 auto; width: min(100%, 37rem); margin: auto; padding: 3rem 1.5rem 7rem; }
  /* the app's headline scale (DESIGN.md: 20px / 650 / −0.01em), not a
     display face of its own — the welcome is the same instrument */
  h1 { font-size: 20px; font-weight: 650; line-height: 1.3; letter-spacing: -0.01em; margin: 0 0 0.9rem; text-wrap: balance; }
  /* focused programmatically on arrival for screen readers; not a control */
  h1:focus { outline: none; }
  .intro { font-size: 15.5px; line-height: 1.6; color: var(--ink-2); margin: 0 0 1.8rem; max-width: 52ch; }
  .choices { display: flex; flex-wrap: wrap; align-items: center; column-gap: 0.6rem; row-gap: 0.8rem; }
  .later { font-size: 13px; color: var(--ink-3); margin: 1rem 0 0; }
  .access-note { margin-top: 3rem; padding-top: 1.4rem; border-top: 1px solid var(--line); font-size: 13px; line-height: 1.7; color: var(--ink-3); }
  .access-note p { margin: 0; }
  .access-note p + p { margin-top: 0.6rem; }
  .access-note code { font-family: var(--font-mono); font-size: 0.95em; }
  .access-note strong { font-weight: 550; }
  details { margin-top: 0.8rem; }
  summary { cursor: pointer; width: fit-content; color: var(--ink-2); }
  details p { padding-top: 0.7rem; }
  .memory { display: grid; gap: 0.45rem; margin: 0 0 1.8rem; max-width: 52ch; }
  .memory label { font-size: 14px; font-weight: 550; color: var(--ink); }
  .memory p { font-size: 14px; line-height: 1.6; color: var(--ink-2); margin: 0; }
  .memory .later { font-size: 13px; color: var(--ink-3); margin: 0; }
  .memory select {
    justify-self: start; max-width: 100%; appearance: none; color: var(--ink); background: var(--s3);
    border: 1px solid var(--line); border-radius: var(--r-xs); font: 550 13px/1.4 var(--font-ui);
    padding: 0.45rem 1.8rem 0.45rem 0.6rem;
    background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%), linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
    background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
  }
  .account { font-size: 14px; color: var(--ink-2); margin: 0 0 1.4rem; overflow-wrap: anywhere; }
  .setup-error { color: var(--bad); font-size: 14px; overflow-wrap: anywhere; margin: 1.4rem 0 0; }
  @media (max-width: 40rem) {
    .setup-header { padding: 1.4rem 1.5rem; }
    .onboarding { padding-block: 3rem; }
    .memory select { font-size: 16px; }
  }
</style>
