<script lang="ts">
  import type { AuthState } from "../lib/types.ts";

  let { auth }: { auth: AuthState } = $props();
</script>

{#if auth.state === "ok"}
  <!-- Healthy auth is a steady green lamp, not information to shout. -->
  <span class="auth-ok lamp-field" title="signed in: {auth.provider} ({auth.credentialType})">
    <span class="lamp on-green"></span>auth
  </span>
{:else}
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
