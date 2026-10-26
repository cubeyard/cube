<script lang="ts">
  import type { ThreadName as Name } from "../lib/thread-name.ts";
  // A thread's name, led by its emoji, before its title: quieter than the
  // title, never instead of it. The emoji is the animal the words say.
  let { name }: { name: Name | null | undefined } = $props();
</script>

{#if name}<span class="thread-name"><span class="thread-emoji" aria-hidden="true">{name.emoji}</span> {name.words}</span><span class="sr-only">,&#32;</span>{/if}
