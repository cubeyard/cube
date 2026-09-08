<script lang="ts">
  import { connectGithub, disconnectGithub, errorText, fetchGithubAuth } from "../lib/api.ts";
  import type { GithubAuthStatus } from "../lib/types.ts";

  let { onStatusChange, onBusyChange }: {
    onStatusChange?: (status: GithubAuthStatus) => void;
    onBusyChange?: (busy: boolean) => void;
  } = $props();

  let status = $state<GithubAuthStatus>({ state: "disconnected" });
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let loaded = $state(false);

  $effect(() => { onStatusChange?.(status); });
  $effect(() => { onBusyChange?.(busy || !loaded); });

  // Sequence guard: connect()/disconnect() bump `seq` when they land, so a
  // poll that was already in flight resolves with a stale capture and is
  // dropped instead of clobbering the fresh result. Plain let on purpose —
  // a tracked read here would make every bump re-arm the polling effect.
  let seq = 0;
  let pollInFlight = false;

  const refresh = () => {
    // One poll at a time: with response latency above the interval, each
    // new poll's seq bump would make EVERY response stale on arrival and
    // the UI would never observe connected/expired — and a hung request
    // would pile up siblings without bound (sol Medium).
    if (pollInFlight) return;
    pollInFlight = true;
    const s = ++seq; // a new poll also invalidates any older poll in flight
    fetchGithubAuth()
      .then((next) => {
        if (s === seq) status = next;
      })
      .catch(() => { if (!loaded) failure = "could not check github login — try again"; })
      .finally(() => {
        pollInFlight = false;
        loaded = true;
      });
  };

  // Poll fast while a device code is pending (cubed advances the flow;
  // this only re-reads state), slow otherwise so a token death or an ssh
  // login elsewhere shows up without a reload. `pending` is $derived so
  // the effect re-arms the interval only when the boolean actually flips
  // — each poll response is a fresh status object, and reading
  // `status.state` directly here would tear down and recreate the
  // interval (and refetch) on every response.
  const pending = $derived(status.state === "pending");

  $effect(() => {
    refresh();
    const ms = pending ? 3_000 : 60_000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  });

  async function connect() {
    busy = true;
    failure = null;
    try {
      const next = await connectGithub();
      seq++;
      status = next;
    } catch (e) {
      failure = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    busy = true;
    failure = null;
    try {
      const next = await disconnectGithub();
      seq++;
      status = next;
    } catch (e) {
      failure = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

  <div class="plain-login">
    {#if !loaded}
      <p class="plain-status" role="status">checking github login…</p>
    {:else if status.state === "connected"}
      <p class="plain-status" role="status">signed in as <strong>{status.login}</strong></p>
      <button class="plain-secondary" onclick={disconnect} disabled={busy}>disconnect</button>
    {:else if status.state === "pending"}
      <div class="plain-device" role="status">
        <span class="code">{status.userCode}</span>
        <p>Enter this code at <a href={status.verificationUri} target="_blank" rel="noreferrer">github.com/login/device</a> and authorize GitHub CLI.</p>
        <p class="hint">Waiting for you to finish in your browser.</p>
      </div>
      <button class="plain-secondary" onclick={disconnect} disabled={busy}>cancel login</button>
    {:else}
      {#if status.error}<p class="error" role="alert">{status.error}</p>{/if}
      <button class="plain-primary" onclick={connect} disabled={busy}>{busy ? "starting github login…" : "log in to github"}</button>
    {/if}
  </div>
{#if failure}<p class="error" role="alert">{failure}</p>{/if}

<style>
  .plain-login { display: contents; }
  .plain-status, .plain-device { flex-basis: 100%; margin: 0; font-size: 15px; overflow-wrap: anywhere; }
  .plain-status { color: var(--ink-2); }
  .plain-status strong { color: var(--ink); font-weight: 550; }
  .plain-device .code { display: block; font-size: 30px; letter-spacing: 0.12em; margin-bottom: 1rem; }
  .plain-device p { margin: 0.5rem 0; max-width: 35rem; }
  .plain-device a { color: var(--ink); text-underline-offset: 3px; }
  .plain-primary, .plain-secondary { padding: 0.7rem 1.1rem; border-radius: var(--r-key); font-size: 14px; font-weight: 550; border: 1px solid transparent; }
  .plain-primary { background: var(--signal); color: var(--signal-ink); }
  .plain-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--signal) 92%, white); }
  .plain-secondary { background: transparent; color: var(--ink-2); padding-inline: 0; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--line-2); }
  .plain-secondary:hover:not(:disabled) { color: var(--ink); text-decoration-color: currentColor; }
  .code {
    font-family: var(--font-mono);
    font-size: 1.4em;
    letter-spacing: 0.15em;
    user-select: all;
  }
  .hint { color: var(--ink-3); }
  .error { color: var(--bad); overflow-wrap: anywhere; flex-basis: 100%; margin: 0; }
</style>
