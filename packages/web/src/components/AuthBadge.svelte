<script lang="ts">
  import { onMount } from "svelte";
  import { fetchState } from "../lib/api.ts";
  import type { AuthState } from "../lib/types.ts";

  // Provider auth belongs to pi (`/login` in a thread); cubed only reports
  // it. Polled slowly so a login shows up in the header without a reload.
  let auth = $state<AuthState | null>(null);

  onMount(() => {
    const refresh = () => fetchState().then((state) => (auth = state.auth), () => {});
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  });
</script>

{#if auth?.state === "ok"}
  <!-- Healthy auth is a steady green lamp, not information to shout. -->
  <span class="auth-ok lamp-field" title="signed in: {auth.provider} ({auth.credentialType})">
    <span class="lamp on-green"></span>auth
  </span>
{:else if auth}
  <span
    class="auth-missing"
    aria-label="not signed in — run /login in a thread"
    title="not signed in — run /login in a thread"
  >
    <span class="lamp on-red"></span>
    <span class="auth-full" aria-hidden="true">not signed in — run /login in a thread</span>
    <span class="auth-short" aria-hidden="true">auth</span>
  </span>
{/if}
