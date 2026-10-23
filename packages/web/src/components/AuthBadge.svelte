<script lang="ts">
  import { onMount } from "svelte";
  import { fetchState } from "../lib/api.ts";
  import type { AuthState } from "../lib/types.ts";

  // Pi owns credentials; the models page supplies its interactive login UI.
  let auth = $state<AuthState | null>(null);
  // quiet: healthy auth shows nothing at all; only a failure is printed.
  let { quiet = false }: { quiet?: boolean } = $props();

  onMount(() => {
    const refresh = () => fetchState().then((state) => (auth = state.auth), () => {});
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  });
</script>

{#if auth?.state === "ok" && quiet}
  <!-- signed in: nothing to say -->
{:else if auth?.state === "ok"}
  <!-- Healthy auth is a quiet word, not information to shout. On a phone
       the label shrinks rather than vanishing. -->
  <span class="auth-ok" title="signed in: {auth.provider} ({auth.credentialType})">
    <span class="auth-full">signed in</span>
    <span class="auth-short" aria-hidden="true">ok</span>
  </span>
{:else if auth}
  <a href="#/settings/providers"
    class="auth-missing"
    aria-label="connect a model provider"
    title="connect a model provider"
  >
    <span class="auth-full" aria-hidden="true">connect provider</span>
    <span class="auth-short" aria-hidden="true">auth</span>
  </a>
{/if}
