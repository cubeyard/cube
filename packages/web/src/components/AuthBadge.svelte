<script lang="ts">
  import { onMount } from "svelte";
  import { fetchState } from "../lib/api.ts";
  import type { AuthState } from "../lib/types.ts";

  // Pi owns credentials; the models page supplies its interactive login UI.
  let auth = $state<AuthState | null>(null);

  onMount(() => {
    const refresh = () => fetchState().then((state) => (auth = state.auth), () => {});
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  });
</script>

{#if auth?.state === "ok"}
  <!-- Healthy auth is a steady green lamp, not information to shout. On a
       phone the label shrinks to two letters rather than vanishing. -->
  <span class="auth-ok lamp-field" title="signed in: {auth.provider} ({auth.credentialType})">
    <span class="lamp on-green"></span>
    <span class="auth-full">auth</span>
    <span class="auth-short" aria-hidden="true">ok</span>
  </span>
{:else if auth}
  <a href="#/models"
    class="auth-missing"
    aria-label="connect a model provider"
    title="connect a model provider"
  >
    <span class="lamp on-red"></span>
    <span class="auth-full" aria-hidden="true">connect provider</span>
    <span class="auth-short" aria-hidden="true">auth</span>
  </a>
{/if}
