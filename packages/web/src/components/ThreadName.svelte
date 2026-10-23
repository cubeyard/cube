<script lang="ts">
  // A thread's name, "🦦 calm otter": chosen once when it was created
  // (server thread-names.ts), shown beside its title, never instead of it.
  import type { ThreadIdentity } from "../lib/types.ts";

  let { identity }: { identity?: ThreadIdentity | null | undefined } = $props();
</script>

{#if identity}<span class="thread-name"><span class="thread-name-emoji" aria-hidden="true">{identity.emoji}</span>{identity.name}</span>{/if}
