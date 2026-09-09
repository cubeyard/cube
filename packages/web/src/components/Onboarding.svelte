<script lang="ts">
  import { onMount, tick } from "svelte";
  import GithubConnect from "./GithubConnect.svelte";
  import Wordmark from "./Wordmark.svelte";
  import { completeOnboarding, disconnectGithub, errorText } from "../lib/api.ts";
  import type { GithubAuthStatus } from "../lib/types.ts";

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
      <p>Behind the scenes, cube runs <code>gh auth login</code> on your VM. You approve <strong>GitHub CLI</strong> in your browser, not a separate Cube app.</p>
      <p>GitHub CLI keeps the credentials on your VM, outside thread environments.</p>
      <p>This is standard GitHub CLI access, not per-repository access.</p>
      <details>
        <summary>before connecting work code</summary>
        <p>You authorize GitHub CLI, not a separate Cube app. Review your organization’s policy and the permissions shown by GitHub before approving.</p>
      </details>
    </div>
  {:else}
    <h1 bind:this={heading} tabindex="-1">make yourself at home.</h1>
    <p class="intro">Start with a project. Choose a repository and check access, then give an agent a task in its own isolated environment.</p>
    <p class="account">{github.state === "connected" ? `github connected as ${github.login}` : "github skipped — connect whenever you need it"}</p>
    <div class="choices">
      <button class="key primary" onclick={finish} disabled={saving}>{saving ? "saving…" : "open projects"}</button>
      <button class="key" onclick={back} disabled={saving}>back</button>
    </div>
    <div class="access-note">
      <p>This setup is remembered on your VM.</p>
      <p>Model-provider login is separate. Set it up when you start a thread.</p>
    </div>
  {/if}
  {#if error}<p class="setup-error" role="alert">{error}</p>{/if}
</main>

<style>
  .setup-header { padding: 1.8rem 2.4rem; border: 0; box-shadow: none; }
  .setup-label { display: flex; gap: 1.4rem; color: var(--ink-3); font-size: 12px; }
  .step-count { font-variant-numeric: tabular-nums; }
  .onboarding { width: min(100%, 37rem); margin: auto; padding: 3rem 1.5rem 7rem; }
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
  .account { font-size: 14px; color: var(--ink-2); margin: 0 0 1.4rem; overflow-wrap: anywhere; }
  .setup-error { color: var(--bad); font-size: 14px; overflow-wrap: anywhere; margin: 1.4rem 0 0; }
  @media (max-width: 40rem) {
    .setup-header { padding: 1.4rem 1.5rem; }
    .onboarding { padding-block: 3rem; }
  }
</style>
