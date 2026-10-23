<script lang="ts">
  // The brand mark: the wireframe cube glyph and the lowercase name, drawn
  // inline so it renders before any font or asset arrives — it is the one
  // thing on screen while the host is still unreachable.
  // With `onclick` the mark is a key (the chat's way to its index).
  let { href = null, onclick = null, label = null }: { href?: string | null; onclick?: ((event: MouseEvent) => void) | null; label?: string | null } = $props();
</script>

{#snippet mark()}
  <span class="glyph" aria-hidden="true">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M12 2 21 7 V17 L12 22 3 17 V7 Z" />
      <path d="M3 7 L12 12 21 7 M12 12 V22" />
    </svg>
  </span>
  <span class="name-text">cube</span>
{/snippet}

{#if onclick}
  <button type="button" class="name name-key" aria-haspopup="dialog" aria-label={label ?? undefined} title={label ?? undefined} {onclick}>{@render mark()}</button>
{:else if href}
  <a class="name" {href}>{@render mark()}</a>
{:else}
  <span class="name">{@render mark()}</span>
{/if}
